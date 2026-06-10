/**
 * Minimal Prometheus-format metrics registry. Hand-rolled on purpose: zero
 * dependencies, no supply-chain surface, and we only need counters, gauges
 * and a duration summary.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Counter {
  private values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private value = 0;

  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  set(v: number): void {
    this.value = v;
  }

  inc(v = 1): void {
    this.value += v;
  }

  dec(v = 1): void {
    this.value -= v;
  }

  get(): number {
    return this.value;
  }

  render(): string {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${this.value}`].join('\n');
  }
}

/** Exposes `<name>_sum` and `<name>_count` — enough for rate/avg queries. */
class Summary {
  private sum = 0;
  private count = 0;

  constructor(
    public readonly name: string,
    public readonly help: string
  ) {}

  observe(v: number): void {
    this.sum += v;
    this.count++;
  }

  render(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} summary`,
      `${this.name}_sum ${this.sum}`,
      `${this.name}_count ${this.count}`,
    ].join('\n');
  }
}

export const metrics = {
  webhookEvents: new Counter('aam_webhook_events_total', 'GitHub webhook events received, by event type'),
  runsTotal: new Counter('aam_runs_total', 'Conflict-resolution runs, by outcome'),
  filesTotal: new Counter('aam_files_total', 'Conflicted files processed, by resolution method and applied flag'),
  claudeCalls: new Counter('aam_claude_calls_total', 'Anthropic API calls, by model and outcome'),
  tokensTotal: new Counter('aam_tokens_total', 'Anthropic tokens consumed, by type'),
  costUsd: new Counter('aam_cost_usd_total', 'Estimated Anthropic spend in USD'),
  httpRequests: new Counter('aam_http_requests_total', 'HTTP requests served, by route and status'),
  rateLimited: new Counter('aam_rate_limited_total', 'Requests rejected by the rate limiter'),
  learningSignals: new Counter('aam_learning_signals_total', 'Human accept/override signals on AI resolutions, by method'),
  learningGates: new Counter('aam_learning_gates_total', 'Resolutions forced to manual review by the learning loop'),
  notifications: new Counter('aam_notifications_total', 'Outbound notifications, by channel and outcome'),
  runDuration: new Summary('aam_run_duration_seconds', 'Duration of conflict-resolution runs'),
  inflightRuns: new Gauge('aam_inflight_runs', 'Conflict-resolution runs currently executing'),
};

/** Render all metrics plus any caller-supplied point-in-time gauges (e.g. queue depth). */
export function renderPrometheus(extraGauges: Record<string, { help: string; value: number }> = {}): string {
  const parts = Object.values(metrics).map((m) => m.render());
  for (const [name, { help, value }] of Object.entries(extraGauges)) {
    parts.push(`# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`);
  }
  return parts.join('\n\n') + '\n';
}
