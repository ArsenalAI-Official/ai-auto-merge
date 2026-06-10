import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { RunOutcome, RunRecord } from '../types';
import { formatTokens, formatUsd, totalTokens } from '../utils/pricing';

/**
 * Outbound notifications so teams hear about resolutions where they already
 * work. Slack-compatible incoming webhooks (Discord too, via the /slack
 * suffix) and a generic JSON webhook for anything else. Strictly
 * fire-and-forget: a notification failure never affects a resolution.
 */

const OUTCOME_EMOJI: Record<RunOutcome, string> = {
  resolved: ':white_check_mark:',
  partial: ':warning:',
  review_required: ':warning:',
  dry_run: ':eyes:',
  no_conflicts: ':information_source:',
  skipped: ':fast_forward:',
  disabled: ':no_entry_sign:',
  error: ':x:',
};

function shouldNotify(outcome: RunOutcome): boolean {
  const only = config.notifications.onlyOutcomes;
  if (only.length > 0) return only.includes(outcome);
  // Default: skip the noisy no-op outcomes.
  return outcome !== 'no_conflicts' && outcome !== 'disabled';
}

export function buildSlackMessage(run: RunRecord): { text: string; blocks: unknown[] } {
  const outcome = run.outcome ?? 'error';
  const emoji = OUTCOME_EMOJI[outcome] ?? ':robot_face:';
  const applied = run.files.filter((f) => f.applied).length;
  const flagged = run.files.length - applied;
  const tokens = totalTokens(run.usage);
  const prRef = `${run.repo}#${run.prNumber}`;
  const prLink = run.prUrl ? `<${run.prUrl}|${prRef}>` : prRef;

  const summary =
    outcome === 'resolved'
      ? `resolved ${applied} conflict${applied !== 1 ? 's' : ''}`
      : outcome === 'partial'
        ? `resolved ${applied}, flagged ${flagged} for review`
        : outcome.replace(/_/g, ' ');

  const text = `${emoji} ai-auto-merge ${summary} on ${prRef}`;
  const contextBits = [
    `*${outcome}*`,
    `${run.files.length} file${run.files.length !== 1 ? 's' : ''}`,
  ];
  if (tokens > 0) contextBits.push(`${formatTokens(tokens)} tokens · ${formatUsd(run.usage.costUsd)}`);
  if (run.commitSha) contextBits.push(`\`${run.commitSha.slice(0, 7)}\``);

  return {
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${emoji} *${prLink}* — ${summary}\n_${run.prTitle}_` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: contextBits.join('  ·  ') }],
      },
    ],
  };
}

async function post(url: string, body: unknown, channel: string, outcome: RunOutcome): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn(`Notification to ${channel} returned ${res.status}`);
      metrics.notifications.inc({ channel, outcome: 'error' });
    } else {
      metrics.notifications.inc({ channel, outcome });
    }
  } catch (err) {
    logger.warn(`Notification to ${channel} failed:`, err);
    metrics.notifications.inc({ channel, outcome: 'error' });
  }
}

/** Fire notifications for a completed run. Never throws; safe to not await. */
export async function notifyRunComplete(run: RunRecord): Promise<void> {
  const outcome = run.outcome;
  if (!outcome || !shouldNotify(outcome)) return;

  const { slackWebhookUrl, genericWebhookUrl } = config.notifications;
  const jobs: Promise<void>[] = [];

  if (slackWebhookUrl) {
    jobs.push(post(slackWebhookUrl, buildSlackMessage(run), 'slack', outcome));
  }
  if (genericWebhookUrl) {
    jobs.push(
      post(
        genericWebhookUrl,
        {
          event: 'run.completed',
          outcome,
          repo: run.repo,
          prNumber: run.prNumber,
          prTitle: run.prTitle,
          prUrl: run.prUrl,
          commitSha: run.commitSha,
          trigger: run.trigger,
          files: run.files,
          usage: run.usage,
          durationMs: run.durationMs,
          finishedAt: run.finishedAt,
        },
        'webhook',
        outcome
      )
    );
  }

  await Promise.allSettled(jobs);
}

export function notificationsConfigured(): boolean {
  return Boolean(config.notifications.slackWebhookUrl || config.notifications.genericWebhookUrl);
}
