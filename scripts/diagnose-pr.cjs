/**
 * Reproduce the resolution pipeline for a single PR READ-ONLY (no push, no
 * comment) to surface the real error behind "failed unexpectedly".
 *   node scripts/diagnose-pr.cjs <owner> <repo> <prNumber>
 * Reads creds from .env (incl. GITHUB_PRIVATE_KEY_PATH). Never prints secrets.
 */
process.env.NODE_ENV ||= 'development';
const [owner, repo, prArg] = process.argv.slice(2);
const prNumber = parseInt(prArg, 10);
if (!owner || !repo || !prNumber) { console.error('usage: diagnose-pr.cjs <owner> <repo> <pr>'); process.exit(1); }

const step = async (name, fn) => {
  process.stdout.write(`• ${name} ... `);
  try { const r = await fn(); console.log('ok'); return r; }
  catch (e) { console.log('FAILED'); console.error(`\n>>> failure at "${name}":\n`, e && e.stack ? e.stack : e); process.exit(2); }
};

(async () => {
  const { initGithubApp, getGithubApp, getInstallationOctokit, getInstallationToken, getPRByNumber, getPRDiff } = require('../dist/services/github.js');
  const { prepareConflictWorkspace, abortMerge } = require('../dist/services/gitOps.js');
  const { resolveConflicts } = require('../dist/services/conflictResolver.js');
  const { getRepoConfig } = require('../dist/services/repoConfig.js');
  const { newRunUsage } = require('../dist/utils/pricing.js');

  await step('init app', () => initGithubApp());
  const app = getGithubApp();
  const inst = await step('resolve installation', async () =>
    (await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo })).data);
  const octokit = await step('installation octokit', () => getInstallationOctokit(inst.id));
  const { pr, state, isFork } = await step('fetch PR', () => getPRByNumber(octokit, owner, repo, prNumber, inst.id));
  console.log(`   PR #${pr.number}: state=${state} fork=${isFork} ${pr.headRef} → ${pr.baseRef}`);

  const repoConfig = await step('read .auto-merge.yml (base ref)', () => getRepoConfig(octokit, owner, repo, pr.baseRef));
  console.log(`   enabled=${repoConfig.enabled} threshold=${repoConfig.autoApplyConfidenceThreshold} maxFiles=${repoConfig.maxFilesToAutoResolve}`);
  const token = await step('mint installation token', () => getInstallationToken(inst.id));
  const diff = await step('fetch PR diff', () => getPRDiff(octokit, owner, repo, prNumber));

  const { ctx, conflictedFiles } = await step('clone + merge base (detect conflicts)', () =>
    prepareConflictWorkspace(pr.repoOwner, pr.repoName, pr.headRef, pr.baseRef, token));
  console.log(`   conflicted files (${conflictedFiles.length}): ${conflictedFiles.map((f) => f.path).join(', ') || '(none)'}`);

  if (conflictedFiles.length === 0) { console.log('No conflicts after workspace prep — nothing to resolve.'); await ctx.cleanup(); return; }

  const usage = newRunUsage();
  const resolved = await step('resolve with the model (REAL calls, no push)', () =>
    resolveConflicts(conflictedFiles, pr.title, pr.body, pr.headRef, pr.baseRef, diff || undefined, usage));
  for (const r of resolved) console.log(`   - ${r.path}: ${r.method} ${r.confidence} needsReview=${r.needsReview}`);
  console.log(`   usage: ${usage.apiCalls} calls, $${usage.costUsd.toFixed(4)}`);

  await abortMerge(ctx); await ctx.cleanup();
  console.log('\nDiagnosis complete — pipeline ran to completion read-only (no push).');
})().catch((e) => { console.error('UNCAUGHT:', e && e.stack ? e.stack : e); process.exit(2); });
