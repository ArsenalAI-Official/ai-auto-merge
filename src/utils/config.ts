import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  github: {
    appId: parseInt(requireEnv('GITHUB_APP_ID'), 10),
    privateKey: requireEnv('GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n'),
    webhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),
  },
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    /** Model used for conflict resolution proposals. Must support adaptive thinking for best results. */
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    /** Cheaper model used to judge between diverging proposals. */
    judgeModel: process.env.ANTHROPIC_JUDGE_MODEL || 'claude-haiku-4-5',
  },
  server: {
    port: intEnv('PORT', 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    /** When set, /dashboard, /api/* and /metrics require this bearer token (or ?token=). */
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
    /** Per-IP request ceiling per minute; <= 0 disables rate limiting. */
    rateLimitPerMinute: intEnv('RATE_LIMIT_PER_MIN', 300),
    /**
     * Only set true when running behind a reverse proxy / load balancer.
     * When false (default), client IPs come from the socket and cannot be
     * spoofed via X-Forwarded-For — which matters for the rate limiter.
     */
    trustProxy: process.env.TRUST_PROXY === 'true',
  },
  settings: {
    autoMergeOnCIPass: process.env.AUTO_MERGE_ON_CI_PASS === 'true',
    autoMergeMethod: (process.env.AUTO_MERGE_METHOD || 'SQUASH') as 'MERGE' | 'SQUASH' | 'REBASE',
    autoApplyConfidenceThreshold: (process.env.AUTO_APPLY_CONFIDENCE_THRESHOLD || 'high') as 'high' | 'medium' | 'low',
    maxFilesToAutoResolve: intEnv('MAX_FILES_TO_AUTO_RESOLVE', 20),
    /** Conflicted files larger than this (bytes) are never sent to the AI. */
    maxFileBytes: intEnv('MAX_FILE_BYTES', 262_144),
    /** BullMQ worker concurrency when REDIS_URL is set. */
    queueConcurrency: intEnv('QUEUE_CONCURRENCY', 3),
    /** Concurrent PR-merge events processed in-process when Redis is absent. */
    inProcessConcurrency: intEnv('INPROCESS_CONCURRENCY', 2),
  },
};
