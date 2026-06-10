/**
 * Tests the webhook→learning bridge: human-push override detection and
 * merge-time acceptance. GitHub and runHistory edges are mocked; the learning
 * store is the real in-memory one so we can assert recorded signals.
 */

const mockGetLastRunForPR = jest.fn();
const mockCompareCommitFiles = jest.fn();

jest.mock('../src/services/github', () => ({
  getInstallationOctokit: jest.fn().mockResolvedValue({}),
  compareCommitFiles: (...args: unknown[]) => mockCompareCommitFiles(...args),
}));
jest.mock('../src/services/runHistory', () => ({
  getLastRunForPR: (...args: unknown[]) => mockGetLastRunForPR(...args),
}));

import { handleHumanPush, handleMergedForLearning } from '../src/services/learningSignals';
import { getGate, getInsights, clearLearning } from '../src/services/learning';
import { RunRecord, RunFileRecord } from '../src/types';

function file(path: string, method: RunFileRecord['method'], applied = true): RunFileRecord {
  return { path, method, confidence: 'high', applied, explanation: 'x' };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    repo: 'acme/widgets',
    prNumber: 45,
    prTitle: 't',
    trigger: { kind: 'merge', prNumber: 44, prTitle: 'x', baseRef: 'main', mergedBy: 'a' },
    outcome: 'resolved',
    commitSha: 'botsha123',
    files: [file('src/a.ts', 'ai_judged'), file('src/b.ts', 'ai_judged')],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0, costUsd: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  clearLearning();
  mockGetLastRunForPR.mockReset();
  mockCompareCommitFiles.mockReset();
});

describe('handleHumanPush (override detection)', () => {
  it('records overrides for resolved files the human re-touched and marks the run superseded', async () => {
    const run = makeRun();
    mockGetLastRunForPR.mockReturnValue(run);
    mockCompareCommitFiles.mockResolvedValue(new Set(['src/a.ts', 'unrelated.ts']));

    await handleHumanPush({
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 45,
      installationId: 1,
      newHeadSha: 'humansha999',
    });

    expect(run.superseded).toBe(true);
    const bucket = getInsights().buckets.find((b) => b.ext === 'ts');
    expect(bucket?.overridden).toBe(1); // only src/a.ts, not src/b.ts or unrelated
  });

  it('does nothing when the head still equals the bot commit (no human push yet)', async () => {
    mockGetLastRunForPR.mockReturnValue(makeRun({ commitSha: 'botsha123' }));
    await handleHumanPush({
      repoOwner: 'acme', repoName: 'widgets', prNumber: 45, installationId: 1, newHeadSha: 'botsha123',
    });
    expect(mockCompareCommitFiles).not.toHaveBeenCalled();
    expect(getInsights().buckets).toHaveLength(0);
  });

  it('ignores PRs the bot never resolved', async () => {
    mockGetLastRunForPR.mockReturnValue(undefined);
    await handleHumanPush({
      repoOwner: 'acme', repoName: 'widgets', prNumber: 45, installationId: 1, newHeadSha: 'x',
    });
    expect(mockCompareCommitFiles).not.toHaveBeenCalled();
  });

  it('does not re-record on an already-superseded run', async () => {
    mockGetLastRunForPR.mockReturnValue(makeRun({ superseded: true }));
    await handleHumanPush({
      repoOwner: 'acme', repoName: 'widgets', prNumber: 45, installationId: 1, newHeadSha: 'humansha999',
    });
    expect(mockCompareCommitFiles).not.toHaveBeenCalled();
  });
});

describe('handleMergedForLearning (acceptance)', () => {
  it('records acceptance for all applied AI files when a clean resolution merges', () => {
    const run = makeRun();
    mockGetLastRunForPR.mockReturnValue(run);

    handleMergedForLearning('acme', 'widgets', 45);

    expect(run.learningSettled).toBe(true);
    const bucket = getInsights().buckets.find((b) => b.ext === 'ts');
    expect(bucket?.accepted).toBe(2);
    expect(bucket?.overridden).toBe(0);
  });

  it('does not count acceptance if the resolution was already overridden', () => {
    mockGetLastRunForPR.mockReturnValue(makeRun({ superseded: true }));
    handleMergedForLearning('acme', 'widgets', 45);
    expect(getInsights().buckets).toHaveLength(0);
  });

  it('feeds the gate: enough overrides flips a category to forced review', async () => {
    // Six separate PRs whose ai_judged .ts resolutions a human overrode
    for (let i = 0; i < 6; i++) {
      const run = makeRun({ prNumber: 100 + i, commitSha: `bot${i}`, files: [file(`src/f${i}.ts`, 'ai_judged')] });
      mockGetLastRunForPR.mockReturnValue(run);
      mockCompareCommitFiles.mockResolvedValue(new Set([`src/f${i}.ts`]));
      await handleHumanPush({
        repoOwner: 'acme', repoName: 'widgets', prNumber: 100 + i, installationId: 1, newHeadSha: `human${i}`,
      });
    }
    expect(getGate('acme/widgets', 'src/new.ts', 'ai_judged').forceReview).toBe(true);
  });
});
