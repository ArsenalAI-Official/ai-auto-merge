import type { App } from '@octokit/app';
import type { Octokit } from '@octokit/rest';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { mapLimit } from '../utils/async';
import { PRInfo } from '../types';

// @octokit/app v15+ is ESM-only; this project compiles to CommonJS. A plain
// `import` becomes `require()` and crashes at boot (no "require" export
// condition). The Function wrapper keeps `import()` dynamic so Node loads the
// ESM module natively from CJS.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<typeof import('@octokit/app')>;

let githubApp: App | undefined;

/** Load the ESM Octokit App and construct the singleton. Call once at boot. */
export async function initGithubApp(): Promise<App> {
  if (!githubApp) {
    const { App: OctokitApp } = await dynamicImport('@octokit/app');
    githubApp = new OctokitApp({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      webhooks: { secret: config.github.webhookSecret },
    });
  }
  return githubApp;
}

export function getGithubApp(): App {
  if (!githubApp) {
    throw new Error('GitHub App not initialized — await initGithubApp() before creating the server');
  }
  return githubApp;
}

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const app = getGithubApp();
  return app.getInstallationOctokit(installationId) as unknown as Octokit;
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const app = getGithubApp();
  const octokit = (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
  const { data } = await octokit.request(
    'POST /app/installations/{installation_id}/access_tokens',
    { installation_id: installationId }
  );
  return data.token;
}

// GitHub computes `mergeable` lazily — poll until it's non-null or we time out.
async function waitForMergeableStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  maxWaitMs = 30_000
): Promise<boolean | null> {
  const deadline = Date.now() + maxWaitMs;
  let delay = 2_000;

  while (Date.now() < deadline) {
    const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
    if (data.mergeable !== null) return data.mergeable;
    logger.debug(`PR #${pullNumber} mergeable still null, retrying in ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 8_000);
  }

  logger.warn(`PR #${pullNumber} mergeable status timed out after ${maxWaitMs}ms`);
  return null;
}

/**
 * Find open PRs against `baseRef` that now conflict. Polls mergeability with
 * bounded parallelism (the first GET also triggers GitHub's recompute), and
 * skips fork PRs — the app cannot push to a fork's branch.
 */
export async function getOpenPRsWithConflicts(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseRef: string,
  excludePRNumber: number,
  installationId: number
): Promise<PRInfo[]> {
  const { data: pulls } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    base: baseRef,
    per_page: 100,
  });

  const candidates = pulls.filter((pull) => {
    if (pull.number === excludePRNumber) return false;
    if (pull.head.repo && pull.head.repo.full_name !== `${owner}/${repo}`) {
      logger.info(`PR #${pull.number} is from a fork (${pull.head.repo.full_name}), skipping — cannot push to forks`);
      return false;
    }
    return true;
  });

  const checked = await mapLimit(candidates, 5, async (pull) => {
    const mergeable = await waitForMergeableStatus(octokit, owner, repo, pull.number);
    if (mergeable === false) {
      logger.info(`PR #${pull.number} has conflicts: "${pull.title}"`);
      return toPRInfo(pull, owner, repo, installationId);
    }
    if (mergeable === null) {
      logger.warn(`PR #${pull.number} mergeable status still unknown after timeout, skipping`);
    }
    return null;
  });

  return checked.filter((pr): pr is PRInfo => pr !== null);
}

/** Fetch a single PR (for manual `/ai-merge` triggers). */
export async function getPRByNumber(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  installationId: number
): Promise<{ pr: PRInfo; state: string; isFork: boolean; mergeable: boolean | null }> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    pr: toPRInfo(data, owner, repo, installationId),
    state: data.state,
    isFork: Boolean(data.head.repo && data.head.repo.full_name !== `${owner}/${repo}`),
    mergeable: data.mergeable,
  };
}

interface PullLike {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
}

function toPRInfo(pull: PullLike, owner: string, repo: string, installationId: number): PRInfo {
  return {
    number: pull.number,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    title: pull.title,
    body: pull.body,
    url: pull.html_url,
    author: pull.user?.login || 'unknown',
    repoOwner: owner,
    repoName: repo,
    installationId,
  };
}

export async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
}

export async function createCommitStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
  context = 'ai-auto-merge'
): Promise<void> {
  await octokit.repos.createCommitStatus({ owner, repo, sha, state, description, context });
}

/** Acknowledge a slash command with an emoji reaction. Best-effort. */
export async function addCommentReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: 'eyes' | 'rocket' | '+1' | '-1' = 'eyes'
): Promise<void> {
  try {
    await octokit.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content });
  } catch (err) {
    logger.debug(`Could not add reaction to comment ${commentId}:`, err);
  }
}

/**
 * Permission level of a user on a repo: 'admin' | 'write' | 'read' | 'none'.
 * Returns 'unknown' when the API call fails (caller falls back to the
 * webhook payload's author_association).
 */
export async function getCollaboratorPermission(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string
): Promise<string> {
  try {
    const { data } = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return data.permission;
  } catch (err) {
    logger.debug(`Could not fetch permission for ${username} on ${owner}/${repo}:`, err);
    return 'unknown';
  }
}

/**
 * Enable GitHub's native auto-merge on a PR, so it merges automatically once
 * CI passes and approvals are in. Requires "Allow auto-merge" in repo settings.
 */
export async function enableAutoMerge(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE' = config.settings.autoMergeMethod
): Promise<boolean> {
  try {
    const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });

    await octokit.graphql(
      `
      mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod}) {
          pullRequest {
            autoMergeRequest { enabledAt }
          }
        }
      }
    `,
      { pullRequestId: pr.node_id, mergeMethod }
    );
    logger.info(`Auto-merge (${mergeMethod}) enabled for PR #${prNumber}`);
    return true;
  } catch (err) {
    logger.warn(`Could not enable auto-merge for PR #${prNumber} (is "Allow auto-merge" on in repo settings?):`, err);
    return false;
  }
}

/**
 * Files changed between two commits (base..head). Used by the learning loop to
 * tell whether a human's later push touched files the bot had resolved.
 * Best-effort: returns an empty set on any API failure.
 */
export async function compareCommitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<Set<string>> {
  try {
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    });
    return new Set((data.files ?? []).map((f) => f.filename));
  } catch (err) {
    logger.debug(`Could not compare ${base}...${head} on ${owner}/${repo}:`, err);
    return new Set();
  }
}

/** Fetch the unified diff of a PR to give Claude richer context. */
export async function getPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    // GitHub returns the raw diff as the response body when requesting diff format
    return typeof response.data === 'string' ? (response.data as string).slice(0, 20_000) : '';
  } catch (err) {
    logger.warn(`Could not fetch diff for PR #${prNumber}:`, err);
    return '';
  }
}
