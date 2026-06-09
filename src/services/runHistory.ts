import { RunOutcome, RunRecord, TriggerInfo } from '../types';
import { newRunUsage, totalTokens } from '../utils/pricing';
import { metrics } from '../utils/metrics';

/**
 * In-memory ring buffer of recent resolution runs. Powers /dashboard and
 * /api/runs. Intentionally process-local: it is an operational view, not a
 * system of record — Prometheus counters carry the lifetime totals.
 */

const MAX_RUNS = 200;
const runs: RunRecord[] = [];
let seq = 0;

export interface StartRunInput {
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl?: string;
  trigger: TriggerInfo;
}

export function startRun(input: StartRunInput): RunRecord {
  const record: RunRecord = {
    id: `run-${Date.now()}-${++seq}`,
    startedAt: new Date().toISOString(),
    repo: input.repo,
    prNumber: input.prNumber,
    prTitle: input.prTitle,
    prUrl: input.prUrl,
    trigger: input.trigger,
    files: [],
    usage: newRunUsage(),
  };

  runs.unshift(record);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  metrics.inflightRuns.inc();
  return record;
}

export function finishRun(record: RunRecord, outcome: RunOutcome, detail?: string): void {
  if (record.finishedAt) return; // idempotent
  record.finishedAt = new Date().toISOString();
  record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
  record.outcome = outcome;
  if (detail) record.detail = detail;

  metrics.inflightRuns.dec();
  metrics.runsTotal.inc({ outcome });
  metrics.runDuration.observe(record.durationMs / 1000);
  metrics.tokensTotal.inc({ type: 'input' }, record.usage.inputTokens);
  metrics.tokensTotal.inc({ type: 'output' }, record.usage.outputTokens);
  metrics.tokensTotal.inc({ type: 'cache_read' }, record.usage.cacheReadTokens);
  metrics.tokensTotal.inc({ type: 'cache_write' }, record.usage.cacheWriteTokens);
  metrics.costUsd.inc({}, record.usage.costUsd);
  for (const f of record.files) {
    metrics.filesTotal.inc({ method: f.method, applied: String(f.applied) });
  }
}

export function getRuns(limit = 50): RunRecord[] {
  return runs.slice(0, Math.max(0, Math.min(limit, MAX_RUNS)));
}

export function getLastRunForPR(repo: string, prNumber: number): RunRecord | undefined {
  return runs.find((r) => r.repo === repo && r.prNumber === prNumber);
}

export interface HistoryStats {
  window: { size: number; oldestStartedAt?: string };
  runs: { total: number; inflight: number; byOutcome: Record<string, number>; last24h: number };
  files: { total: number; autoApplied: number; flaggedForReview: number; byMethod: Record<string, number>; aiShare: number };
  usage: { totalTokens: number; cacheReadTokens: number; costUsd: number; avgDurationMs: number };
}

export function getStats(): HistoryStats {
  const byOutcome: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  let filesTotal = 0;
  let applied = 0;
  let flagged = 0;
  let aiFiles = 0;
  let tokens = 0;
  let cacheRead = 0;
  let cost = 0;
  let durationSum = 0;
  let finished = 0;
  let last24h = 0;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const r of runs) {
    if (r.outcome) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    if (Date.parse(r.startedAt) >= dayAgo) last24h++;
    if (r.durationMs !== undefined) {
      durationSum += r.durationMs;
      finished++;
    }
    tokens += totalTokens(r.usage);
    cacheRead += r.usage.cacheReadTokens;
    cost += r.usage.costUsd;
    for (const f of r.files) {
      filesTotal++;
      byMethod[f.method] = (byMethod[f.method] ?? 0) + 1;
      if (f.applied) applied++;
      else flagged++;
      if (f.method.startsWith('ai_')) aiFiles++;
    }
  }

  return {
    window: { size: runs.length, oldestStartedAt: runs[runs.length - 1]?.startedAt },
    runs: {
      total: runs.length,
      inflight: metrics.inflightRuns.get(),
      byOutcome,
      last24h,
    },
    files: {
      total: filesTotal,
      autoApplied: applied,
      flaggedForReview: flagged,
      byMethod,
      aiShare: filesTotal > 0 ? aiFiles / filesTotal : 0,
    },
    usage: {
      totalTokens: tokens,
      cacheReadTokens: cacheRead,
      costUsd: cost,
      avgDurationMs: finished > 0 ? Math.round(durationSum / finished) : 0,
    },
  };
}

/** Test helper — not used in production code paths. */
export function clearHistory(): void {
  runs.length = 0;
}
