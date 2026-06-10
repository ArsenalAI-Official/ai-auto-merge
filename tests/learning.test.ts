import {
  recordAcceptance,
  recordOverride,
  getGate,
  getInsights,
  overriddenFiles,
  acceptedCandidates,
  extensionOf,
  clearLearning,
} from '../src/services/learning';
import { RunRecord, RunFileRecord } from '../src/types';

function file(path: string, method: RunFileRecord['method'], applied = true): RunFileRecord {
  return { path, method, confidence: 'high', applied, explanation: 'x' };
}

function run(files: RunFileRecord[]): RunRecord {
  return {
    id: 'r1',
    startedAt: new Date().toISOString(),
    repo: 'acme/widgets',
    prNumber: 1,
    prTitle: 't',
    trigger: { kind: 'merge', prNumber: 2, prTitle: 'x', baseRef: 'main', mergedBy: 'a' },
    files,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0, costUsd: 0 },
  };
}

describe('extensionOf', () => {
  it('extracts lowercase extension without the dot', () => {
    expect(extensionOf('src/Foo.TS')).toBe('ts');
    expect(extensionOf('go.sum')).toBe('sum');
    expect(extensionOf('Makefile')).toBe('');
  });
});

describe('adaptive gating', () => {
  beforeEach(() => clearLearning());

  it('does not gate before reaching the sample threshold', () => {
    for (let i = 0; i < 4; i++) recordOverride('acme/widgets', 'a.ts', 'ai_judged');
    expect(getGate('acme/widgets', 'b.ts', 'ai_judged').forceReview).toBe(false);
  });

  it('gates a category once override rate crosses the threshold with enough samples', () => {
    // 5 samples, 4 overridden = 80% >= 50%
    for (let i = 0; i < 4; i++) recordOverride('acme/widgets', `f${i}.ts`, 'ai_judged');
    recordAcceptance('acme/widgets', 'f5.ts', 'ai_judged');

    const gate = getGate('acme/widgets', 'new.ts', 'ai_judged');
    expect(gate.forceReview).toBe(true);
    expect(gate.overrideRate).toBeCloseTo(0.8);
    expect(gate.samples).toBe(5);
    expect(gate.reason).toMatch(/overrode 80%/);
  });

  it('stays trusted when humans mostly accept', () => {
    for (let i = 0; i < 9; i++) recordAcceptance('acme/widgets', `f${i}.ts`, 'ai_judged');
    recordOverride('acme/widgets', 'f9.ts', 'ai_judged');
    expect(getGate('acme/widgets', 'x.ts', 'ai_judged').forceReview).toBe(false);
  });

  it('isolates buckets by repo, extension, and method', () => {
    for (let i = 0; i < 6; i++) recordOverride('acme/widgets', `f${i}.ts`, 'ai_judged');
    // Same extension+method, different repo → unaffected
    expect(getGate('other/repo', 'x.ts', 'ai_judged').forceReview).toBe(false);
    // Same repo+method, different extension → unaffected
    expect(getGate('acme/widgets', 'x.py', 'ai_judged').forceReview).toBe(false);
    // The trained bucket gates
    expect(getGate('acme/widgets', 'x.ts', 'ai_judged').forceReview).toBe(true);
  });

  it('never gates deterministic fast-path methods', () => {
    for (let i = 0; i < 10; i++) recordOverride('acme/widgets', `f${i}.ts`, 'fast_additive');
    expect(getGate('acme/widgets', 'x.ts', 'fast_additive').forceReview).toBe(false);
    expect(getGate('acme/widgets', 'x.ts', 'lockfile').forceReview).toBe(false);
  });
});

describe('insight aggregation', () => {
  beforeEach(() => clearLearning());

  it('reports buckets sorted by override rate with gating flags', () => {
    for (let i = 0; i < 6; i++) recordOverride('acme/widgets', `f${i}.ts`, 'ai_judged'); // 100%
    for (let i = 0; i < 10; i++) recordAcceptance('acme/widgets', `g${i}.py`, 'ai_converged'); // 0%

    const insights = getInsights();
    expect(insights.enabled).toBe(true);
    expect(insights.buckets[0].ext).toBe('ts');
    expect(insights.buckets[0].gating).toBe(true);
    const py = insights.buckets.find((b) => b.ext === 'py')!;
    expect(py.gating).toBe(false);
    expect(py.overrideRate).toBe(0);
  });
});

describe('override / acceptance file selection (pure)', () => {
  it('counts only applied, AI-resolved files that a human actually touched', () => {
    const r = run([
      file('src/a.ts', 'ai_judged', true),
      file('src/b.ts', 'ai_converged', true),
      file('src/c.ts', 'fast_additive', true), // deterministic — excluded
      file('src/d.ts', 'ai_judged', false), // flagged, never applied — excluded
    ]);
    const changed = new Set(['src/a.ts', 'src/c.ts', 'src/d.ts', 'unrelated.ts']);
    const overridden = overriddenFiles(r, changed);
    expect(overridden.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('acceptance candidates are all applied AI files', () => {
    const r = run([
      file('src/a.ts', 'ai_judged', true),
      file('src/b.ts', 'fast_imports', true),
      file('src/c.ts', 'ai_converged', false),
    ]);
    expect(acceptedCandidates(r).map((f) => f.path)).toEqual(['src/a.ts']);
  });
});
