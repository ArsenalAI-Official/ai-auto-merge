import { Request, Response } from 'express';
import {
  getGithubApp,
  getInstallationOctokit,
  getPRByNumber,
  postComment,
  addCommentReaction,
  getCollaboratorPermission,
} from '../services/github';
import { enqueueConflictResolution, enqueueManualResolve, getQueueStats, isQueueEnabled } from '../services/queue';
import { getRepoConfig } from '../services/repoConfig';
import { getLastRunForPR } from '../services/runHistory';
import {
  buildHelpComment,
  buildStatusComment,
  buildPermissionDeniedComment,
} from '../services/comments';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { MergedPREvent } from '../types';

// ─── Slash commands ────────────────────────────────────────────────────────────

export type SlashCommand = 'resolve' | 'dry-run' | 'status' | 'help';

const COMMAND_ALIASES: Record<string, SlashCommand> = {
  '': 'resolve',
  resolve: 'resolve',
  retry: 'resolve',
  rerun: 'resolve',
  'dry-run': 'dry-run',
  dryrun: 'dry-run',
  preview: 'dry-run',
  status: 'status',
  help: 'help',
  commands: 'help',
};

/**
 * Parse a PR comment for an `/ai-merge <command>` invocation. Returns null
 * when the comment isn't addressed to us; unknown subcommands map to help.
 */
export function parseCommand(body: string): { cmd: SlashCommand; raw: string } | null {
  const match = body.match(/^\s*\/(?:ai-merge|ai-auto-merge)\b[ \t]*([\w-]*)[ \t]*$/im);
  if (!match) return null;
  const raw = (match[1] ?? '').toLowerCase();
  return { cmd: COMMAND_ALIASES[raw] ?? 'help', raw };
}

const WRITE_PERMISSIONS = new Set(['admin', 'write', 'maintain']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// ─── Webhook registration ──────────────────────────────────────────────────────

export function registerWebhookHandlers(): void {
  const app = getGithubApp();

  app.webhooks.on('pull_request.closed', async ({ payload, id }) => {
    if (!payload.pull_request.merged) return;
    metrics.webhookEvents.inc({ event: 'pull_request.merged' });

    const event: MergedPREvent = {
      prNumber: payload.pull_request.number,
      prTitle: payload.pull_request.title,
      headRef: payload.pull_request.head.ref,
      baseRef: payload.pull_request.base.ref,
      repoOwner: payload.repository.owner.login,
      repoName: payload.repository.name,
      installationId: payload.installation?.id ?? 0,
      mergedAt: payload.pull_request.merged_at ?? new Date().toISOString(),
      mergedBy: payload.pull_request.merged_by?.login ?? 'unknown',
    };

    logger.info(`Webhook ${id}: PR #${event.prNumber} merged into ${event.baseRef}`);
    await enqueueConflictResolution(event);
  });

  app.webhooks.on('issue_comment.created', async ({ payload }) => {
    // Only PR comments, only humans, only comments addressed to us
    if (!payload.issue.pull_request) return;
    if (payload.comment.user?.type === 'Bot') return;

    const command = parseCommand(payload.comment.body ?? '');
    if (!command) return;

    metrics.webhookEvents.inc({ event: `command.${command.cmd}` });

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.issue.number;
    const username = payload.comment.user?.login ?? 'unknown';
    const installationId = payload.installation?.id ?? 0;

    logger.info(`Command /ai-merge ${command.cmd} on ${owner}/${repo}#${prNumber} from @${username}`);

    try {
      const octokit = await getInstallationOctokit(installationId);

      // Permission gate: live collaborator permission, falling back to the
      // payload's author_association when that API is unavailable.
      const permission = await getCollaboratorPermission(octokit, owner, repo, username);
      const allowed =
        permission === 'unknown'
          ? TRUSTED_ASSOCIATIONS.has(payload.comment.author_association)
          : WRITE_PERMISSIONS.has(permission);

      if (!allowed) {
        logger.warn(`@${username} lacks write access on ${owner}/${repo} (${permission}), denying command`);
        await postComment(octokit, owner, repo, prNumber, buildPermissionDeniedComment(username));
        return;
      }

      await addCommentReaction(octokit, owner, repo, payload.comment.id, 'eyes');

      switch (command.cmd) {
        case 'help':
          await postComment(octokit, owner, repo, prNumber, buildHelpComment());
          return;

        case 'status': {
          const [{ pr, mergeable }, repoConfig, queueStats] = await Promise.all([
            getPRByNumber(octokit, owner, repo, prNumber, installationId),
            getRepoConfig(octokit, owner, repo, payload.repository.default_branch),
            getQueueStats(),
          ]);
          const lastRun = getLastRunForPR(`${owner}/${repo}`, prNumber);
          await postComment(octokit, owner, repo, prNumber, buildStatusComment({
            mergeable,
            enabled: repoConfig.enabled,
            dryRun: repoConfig.dryRun,
            threshold: repoConfig.autoApplyConfidenceThreshold,
            queueSummary: isQueueEnabled()
              ? `${queueStats?.waiting ?? 0} waiting / ${queueStats?.active ?? 0} active`
              : 'in-process',
            lastRunSummary: lastRun?.outcome
              ? `${lastRun.outcome} at ${lastRun.finishedAt ?? lastRun.startedAt}`
              : undefined,
          }));
          logger.debug(`Status posted for PR #${pr.number}`);
          return;
        }

        case 'resolve':
        case 'dry-run':
          await enqueueManualResolve({
            prNumber,
            repoOwner: owner,
            repoName: repo,
            installationId,
            requestedBy: username,
            requestedAt: new Date().toISOString(),
            dryRunOverride: command.cmd === 'dry-run' ? true : undefined,
          });
          return;
      }
    } catch (err) {
      logger.error(`Failed to handle /ai-merge ${command.cmd} on ${owner}/${repo}#${prNumber}:`, err);
    }
  });

  app.webhooks.onError((error) => {
    logger.error('Webhook error:', error);
  });
}

// ─── HTTP entry point ──────────────────────────────────────────────────────────

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const app = getGithubApp();

  const eventName = req.headers['x-github-event'] as string;
  const signature = req.headers['x-hub-signature-256'] as string;
  const deliveryId = req.headers['x-github-delivery'] as string;

  if (!eventName || !signature || !deliveryId) {
    res.status(400).json({ error: 'Missing required webhook headers' });
    return;
  }

  // GitHub signs the exact raw bytes. Never JSON.parse + re-stringify before
  // verification — that breaks the HMAC for any payload whose serialization
  // doesn't round-trip (unicode escapes, number formatting).
  const payload = Buffer.isBuffer(req.body)
    ? req.body.toString('utf-8')
    : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

  try {
    await app.webhooks.verifyAndReceive({
      id: deliveryId,
      name: eventName as never,
      signature,
      payload,
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error('Webhook verification failed:', err);
    res.status(401).json({ error: 'Webhook signature verification failed' });
  }
}
