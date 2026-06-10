import { buildSlackMessage } from '../src/services/notify';
import { RunRecord } from '../src/types';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 4200,
    repo: 'acme/widgets',
    prNumber: 45,
    prTitle: 'Add retry logic',
    prUrl: 'https://github.com/acme/widgets/pull/45',
    trigger: { kind: 'merge', prNumber: 44, prTitle: 'x', baseRef: 'main', mergedBy: 'alice' },
    outcome: 'resolved',
    commitSha: 'abcdef1234567890',
    files: [{ path: 'a.ts', method: 'ai_judged', confidence: 'high', applied: true, explanation: 'ok' }],
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0, apiCalls: 2, costUsd: 0.04 },
    ...overrides,
  };
}

describe('buildSlackMessage', () => {
  it('summarizes a resolved run with a PR link and cost', () => {
    const msg = buildSlackMessage(run());
    expect(msg.text).toContain('acme/widgets#45');
    expect(msg.text).toContain('resolved 1 conflict');
    const json = JSON.stringify(msg.blocks);
    expect(json).toContain('https://github.com/acme/widgets/pull/45');
    expect(json).toContain('Add retry logic');
    expect(json).toContain('abcdef1'); // short sha
    expect(json).toContain('$0.04');
  });

  it('describes partial resolutions with the flagged count', () => {
    const msg = buildSlackMessage(
      run({
        outcome: 'partial',
        files: [
          { path: 'a.ts', method: 'ai_judged', confidence: 'high', applied: true, explanation: 'ok' },
          { path: 'b.ts', method: 'ai_failed', confidence: 'low', applied: false, explanation: 'review' },
        ],
      })
    );
    expect(msg.text).toContain('resolved 1, flagged 1 for review');
  });

  it('falls back to a bare ref when no PR URL is present', () => {
    const msg = buildSlackMessage(run({ prUrl: undefined }));
    expect(JSON.stringify(msg.blocks)).toContain('acme/widgets#45');
  });

  it('renders review_required without crashing', () => {
    const msg = buildSlackMessage(run({ outcome: 'review_required', commitSha: undefined }));
    expect(msg.text).toContain('review required');
  });
});
