import { metrics, renderPrometheus } from '../src/utils/metrics';
import { estimateCostUsd, recordUsage, newRunUsage, formatUsd, formatTokens } from '../src/utils/pricing';

describe('metrics registry', () => {
  it('renders counters with sorted labels in Prometheus format', () => {
    metrics.claudeCalls.inc({ outcome: 'ok', model: 'claude-opus-4-8' });
    metrics.claudeCalls.inc({ model: 'claude-opus-4-8', outcome: 'ok' }, 2);

    const out = renderPrometheus();
    expect(out).toContain('# TYPE aam_claude_calls_total counter');
    expect(out).toContain('aam_claude_calls_total{model="claude-opus-4-8",outcome="ok"} 3');
  });

  it('renders gauges and summaries', () => {
    metrics.inflightRuns.set(2);
    metrics.runDuration.observe(1.5);
    metrics.runDuration.observe(2.5);

    const out = renderPrometheus();
    expect(out).toContain('aam_inflight_runs 2');
    expect(out).toContain('aam_run_duration_seconds_sum 4');
    expect(out).toContain('aam_run_duration_seconds_count 2');
    metrics.inflightRuns.set(0);
  });

  it('includes caller-supplied extra gauges', () => {
    const out = renderPrometheus({ aam_queue_waiting: { help: 'waiting', value: 7 } });
    expect(out).toContain('aam_queue_waiting 7');
  });

  it('escapes label values', () => {
    metrics.webhookEvents.inc({ event: 'with"quote' });
    expect(renderPrometheus()).toContain('aam_webhook_events_total{event="with\\"quote"}');
  });
});

describe('pricing', () => {
  it('prices opus 4.8 input/output correctly', () => {
    expect(estimateCostUsd('claude-opus-4-8', { input_tokens: 1_000_000 })).toBeCloseTo(5);
    expect(estimateCostUsd('claude-opus-4-8', { output_tokens: 1_000_000 })).toBeCloseTo(25);
  });

  it('discounts cache reads and surcharges cache writes', () => {
    expect(estimateCostUsd('claude-opus-4-8', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.5);
    expect(estimateCostUsd('claude-opus-4-8', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(6.25);
  });

  it('matches date-suffixed model ids by prefix', () => {
    expect(estimateCostUsd('claude-haiku-4-5-20251001', { input_tokens: 1_000_000 })).toBeCloseTo(1);
  });

  it('accumulates usage into a run total', () => {
    const run = newRunUsage();
    recordUsage(run, 'claude-opus-4-8', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 });
    recordUsage(run, 'claude-opus-4-8', undefined); // failed call still counts the attempt
    expect(run.apiCalls).toBe(2);
    expect(run.inputTokens).toBe(100);
    expect(run.outputTokens).toBe(50);
    expect(run.cacheReadTokens).toBe(10);
    expect(run.costUsd).toBeGreaterThan(0);
  });

  it('formats dollars and tokens for humans', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.001)).toBe('<$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});
