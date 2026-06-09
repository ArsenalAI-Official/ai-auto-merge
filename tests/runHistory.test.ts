import { startRun, finishRun, getRuns, getStats, getLastRunForPR, clearHistory } from '../src/services/runHistory';
import { TriggerInfo } from '../src/types';

const trigger: TriggerInfo = { kind: 'merge', prNumber: 1, prTitle: 'feat', baseRef: 'main', mergedBy: 'alice' };

function start(prNumber = 7) {
  return startRun({ repo: 'acme/widgets', prNumber, prTitle: 'Add widgets', trigger });
}

describe('runHistory', () => {
  beforeEach(() => clearHistory());

  it('records a run lifecycle with duration and outcome', () => {
    const run = start();
    expect(run.id).toBeTruthy();
    expect(run.outcome).toBeUndefined();

    finishRun(run, 'resolved');
    expect(run.outcome).toBe('resolved');
    expect(run.finishedAt).toBeTruthy();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('finishRun is idempotent', () => {
    const run = start();
    finishRun(run, 'resolved');
    const first = run.finishedAt;
    finishRun(run, 'error', 'should not overwrite');
    expect(run.outcome).toBe('resolved');
    expect(run.finishedAt).toBe(first);
  });

  it('returns newest runs first and respects limit', () => {
    const a = start(1);
    finishRun(a, 'resolved');
    const b = start(2);
    finishRun(b, 'error', 'boom');

    const runs = getRuns(10);
    expect(runs.map((r) => r.prNumber)).toEqual([2, 1]);
    expect(getRuns(1)).toHaveLength(1);
  });

  it('finds the most recent run for a PR', () => {
    finishRun(start(5), 'review_required');
    finishRun(start(5), 'resolved');
    expect(getLastRunForPR('acme/widgets', 5)?.outcome).toBe('resolved');
    expect(getLastRunForPR('acme/widgets', 99)).toBeUndefined();
  });

  it('aggregates stats across runs and files', () => {
    const run = start();
    run.files = [
      { path: 'a.ts', method: 'ai_judged', confidence: 'high', applied: true, explanation: 'ok' },
      { path: 'b.ts', method: 'fast_additive', confidence: 'high', applied: true, explanation: 'ok' },
      { path: 'c.lock', method: 'lockfile', confidence: 'low', applied: false, explanation: 'regen' },
    ];
    run.usage.inputTokens = 1000;
    run.usage.outputTokens = 500;
    run.usage.cacheReadTokens = 500;
    run.usage.costUsd = 0.05;
    finishRun(run, 'partial');

    const stats = getStats();
    expect(stats.runs.total).toBe(1);
    expect(stats.runs.byOutcome.partial).toBe(1);
    expect(stats.runs.last24h).toBe(1);
    expect(stats.files.total).toBe(3);
    expect(stats.files.autoApplied).toBe(2);
    expect(stats.files.flaggedForReview).toBe(1);
    expect(stats.files.byMethod.lockfile).toBe(1);
    expect(stats.files.aiShare).toBeCloseTo(1 / 3);
    expect(stats.usage.totalTokens).toBe(2000);
    expect(stats.usage.costUsd).toBeCloseTo(0.05);
  });
});
