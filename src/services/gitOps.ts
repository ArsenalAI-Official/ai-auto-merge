import simpleGit, { SimpleGit } from 'simple-git';
import * as tmp from 'tmp-promise';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ConflictedFile } from '../types';

export interface GitContext {
  git: SimpleGit;
  dir: string;
  cleanup: () => Promise<void>;
}

export async function cloneRepo(
  repoUrl: string,
  token: string,
  branch: string
): Promise<GitContext> {
  const tmpDir = await tmp.dir({ unsafeCleanup: true });
  const git = simpleGit();

  logger.debug(`Cloning ${repoUrl} branch ${branch} to ${tmpDir.path}`);

  // SECURITY FIX: pass auth via http.extraHeader config rather than embedding
  // the token in the URL (which leaks into git reflog and process listings).
  await git.clone(repoUrl, tmpDir.path, [
    '--depth', '50',
    '--branch', branch,
    '--single-branch',
    '--config', `http.extraHeader=Authorization: token ${token}`,
  ]);

  const repoGit = simpleGit(tmpDir.path);

  await repoGit.addConfig('user.email', 'ai-auto-merge[bot]@users.noreply.github.com');
  await repoGit.addConfig('user.name', 'ai-auto-merge[bot]');
  // Keep auth available for the push step
  await repoGit.addConfig('http.extraHeader', `Authorization: token ${token}`);

  return {
    git: repoGit,
    dir: tmpDir.path,
    cleanup: async () => tmpDir.cleanup(),
  };
}

export async function fetchAndMergeBase(
  ctx: GitContext,
  baseBranch: string,
  token: string,
  remoteUrl: string
): Promise<{ hasConflicts: boolean; conflictedFiles: string[] }> {
  // SECURITY FIX: auth via header, not URL
  await ctx.git.addConfig('http.extraHeader', `Authorization: token ${token}`);
  await ctx.git.fetch(remoteUrl, baseBranch);

  try {
    await ctx.git.merge([`FETCH_HEAD`, '--no-commit', '--no-ff']);
    // No conflicts — clean up the in-progress merge state
    await ctx.git.merge(['--abort']).catch(() => {
      // Fast-forward merges have no state to abort, ignore
    });
    return { hasConflicts: false, conflictedFiles: [] };
  } catch {
    const status = await ctx.git.status();
    const conflictedFiles = status.conflicted;
    logger.info(`Found ${conflictedFiles.length} conflicted files`);
    return { hasConflicts: conflictedFiles.length > 0, conflictedFiles };
  }
}

// NEW: also handle delete/modify conflicts where one side removed the file.
export async function getConflictedFileContents(
  ctx: GitContext,
  conflictedFiles: string[]
): Promise<ConflictedFile[]> {
  const result: ConflictedFile[] = [];

  for (const filePath of conflictedFiles) {
    const fullPath = path.join(ctx.dir, filePath);
    try {
      if (!fs.existsSync(fullPath)) {
        // File was deleted on one side — surface this to Claude with a synthetic marker
        const deletedContent = await getDeleteConflictContent(ctx, filePath);
        result.push({ path: filePath, content: deletedContent, isDeleteConflict: true });
      } else {
        const content = fs.readFileSync(fullPath, 'utf-8');
        result.push({ path: filePath, content });
      }
    } catch (err) {
      logger.warn(`Could not read conflicted file ${filePath}:`, err);
    }
  }

  return result;
}

async function getDeleteConflictContent(ctx: GitContext, filePath: string): Promise<string> {
  // Try to show what the file looked like on each side for Claude's context
  try {
    const ourContent = await ctx.git.show([`HEAD:${filePath}`]).catch(() => '(deleted)');
    const theirContent = await ctx.git.show([`FETCH_HEAD:${filePath}`]).catch(() => '(deleted)');
    return [
      `<<<<<<< HEAD (this PR's branch)`,
      ourContent,
      `=======`,
      theirContent,
      `>>>>>>> MERGE_HEAD (base branch)`,
    ].join('\n');
  } catch {
    return '(could not retrieve file content for delete/modify conflict)';
  }
}

export async function applyResolutions(
  ctx: GitContext,
  resolutions: Array<{ path: string; content: string; isDelete?: boolean }>
): Promise<void> {
  for (const { path: filePath, content, isDelete } of resolutions) {
    const fullPath = path.join(ctx.dir, filePath);
    if (isDelete) {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      await ctx.git.rm([filePath]);
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      await ctx.git.add(fullPath);
    }
    logger.debug(`Applied resolution for ${filePath}`);
  }
}

export async function commitAndPush(
  ctx: GitContext,
  message: string,
  branch: string,
  _remoteUrl: string,
  _token: string
): Promise<string> {
  // Auth is already set via http.extraHeader in the repo config — no need to embed in URL
  await ctx.git.commit(message, { '--no-verify': null });
  const log = await ctx.git.log({ maxCount: 1 });
  const commitSha = log.latest?.hash || '';

  await ctx.git.push('origin', `HEAD:refs/heads/${branch}`, ['--force-with-lease']);
  logger.info(`Pushed resolved conflicts to ${branch} (${commitSha})`);

  return commitSha;
}

export async function abortMerge(ctx: GitContext): Promise<void> {
  try {
    await ctx.git.merge(['--abort']);
  } catch {
    // No merge in progress
  }
}

export async function prepareConflictWorkspace(
  repoOwner: string,
  repoName: string,
  prBranch: string,
  baseBranch: string,
  token: string
): Promise<{
  ctx: GitContext;
  conflictedFiles: ConflictedFile[];
  remoteUrl: string;
}> {
  const remoteUrl = `https://github.com/${repoOwner}/${repoName}.git`;

  const ctx = await cloneRepo(remoteUrl, token, prBranch);

  const { hasConflicts, conflictedFiles: conflictedPaths } = await fetchAndMergeBase(
    ctx,
    baseBranch,
    token,
    remoteUrl
  );

  if (!hasConflicts) {
    return { ctx, conflictedFiles: [], remoteUrl };
  }

  const conflictedFiles = await getConflictedFileContents(ctx, conflictedPaths);
  return { ctx, conflictedFiles, remoteUrl };
}
