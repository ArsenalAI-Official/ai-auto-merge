# ai-auto-merge

> Automatically resolve merge conflicts in open PRs using Claude AI, the moment another PR lands on `main` — then optionally auto-merge them when CI goes green.

[![CI](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/ci.yml/badge.svg)](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/codeql.yml/badge.svg)](https://github.com/manikyashetty-arch/ai-auto-merge/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Use this template](https://img.shields.io/badge/use%20this-template-2ea44f?logo=github)](https://github.com/manikyashetty-arch/ai-auto-merge/generate)

**How it works:** when PR #1 merges into `main`, ai-auto-merge finds every other open PR that now conflicts with `main`, resolves the conflicted files with Claude (two independent strategies + a judge model), syntax-checks the result, pushes the fix back to each PR branch, and posts a transparent comment with the diff, the reasoning, and the cost. If everything resolved at high confidence, it can arm GitHub auto-merge so the PR lands the moment CI passes — a fully closed loop.

---

## ✨ Features

- **Zero-touch conflict resolution** — triggered by GitHub webhooks on PR merge.
- **Slash commands** — comment `/ai-merge` on any PR to resolve on demand, `/ai-merge dry-run` to preview, `/ai-merge status` to inspect. Write-access gated.
- **Dual-strategy + judge pipeline** — two independent Claude resolutions (conservative & synthesis); convergence = high confidence, divergence goes to a fast judge model.
- **Self-healing syntax gate** — resolved files are syntax-checked before commit; failures are fed back to Claude for a one-shot repair before being flagged for review.
- **Confidence-gated auto-apply** — Claude reports `high` / `medium` / `low` per file; you choose the threshold for auto-push.
- **Auto-merge completion** — optionally enables GitHub native auto-merge after a clean resolution, so conflict → resolve → CI green → merged needs zero humans.
- **Lockfile-aware** — `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum` & friends are never AI-merged; you get the exact regenerate command instead.
- **Live dashboard** — `GET /dashboard` shows runs, outcomes, fast-path vs AI share, token usage and estimated spend. Zero build step, zero CDN.
- **Prometheus metrics** — `GET /metrics` with runs, files, Claude calls, tokens, cost, and queue depth. Hand-rolled, zero extra dependencies.
- **Cost transparency** — every PR comment ends with calls / tokens / % cached / estimated dollars. Prompt caching cuts the second strategy call to ~10% input cost.
- **Per-repo overrides** — drop a `.auto-merge.yml` in any repo to tune behavior without redeploying.
- **Built-in safety** — raw-body HMAC verification, `push --force-with-lease`, fork-PR detection, per-PR locking, file-size caps, rate limiting, max-files cap.
- **Queue-aware** — optional Redis + BullMQ for high-volume orgs; bounded-concurrency in-process fallback with webhook dedup when `REDIS_URL` is unset.

---

## 🚀 Quickstart

```bash
# 1. Use this repo as a template (click "Use this template" above) and clone your copy
git clone https://github.com/YOUR_USER/ai-auto-merge.git && cd ai-auto-merge

# 2. Install + configure
npm install
cp .env.example .env   # fill in GitHub App + Anthropic credentials

# 3. Run
npm run dev            # or: npm run build && npm start
```

Then point your GitHub App's webhook at `POST /webhook` on the resulting server and open `http://localhost:3000/dashboard`.

> **Prefer Docker?** `docker compose up --build` — that brings up the app and a Redis instance for queueing.

> **Make it yours:** if you fork or use this repo as a template, run a single search-and-replace of `manikyashetty-arch` → `your-org` (badges, links, `package.json`, `.github/`, and the bot's comment footer in `src/services/comments.ts`).

---

## Setup

### 1. Create a GitHub App

1. Go to **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**
2. Set:
   - **Webhook URL:** `https://your-server.com/webhook`
   - **Webhook secret:** generate a random string and save it
   - **Permissions:**
     - Repository → Contents: Read & Write
     - Repository → Pull requests: Read & Write
     - Repository → Commit statuses: Read & Write
     - Repository → Issues: Read & Write *(for `/ai-merge` slash commands and reactions)*
   - **Subscribe to events:** Pull request, Issue comment
3. Generate a **private key** and download the `.pem` file
4. Note your **App ID** from the app's settings page
5. Install the app on the repositories you want it to monitor

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your-webhook-secret
ANTHROPIC_API_KEY=sk-ant-...

PORT=3000
NODE_ENV=production

# Auto-resolve files with confidence >= this level (high | medium | low)
AUTO_APPLY_CONFIDENCE_THRESHOLD=high

# Skip PRs with more conflicted files than this
MAX_FILES_TO_AUTO_RESOLVE=20

# Protect /dashboard, /api/* and /metrics in production
DASHBOARD_TOKEN=some-long-random-string

# Optional: enable BullMQ-backed queueing
# REDIS_URL=redis://localhost:6379
```

> **GITHUB_PRIVATE_KEY:** paste the full PEM contents with literal `\n` for newlines.

### 3. Run

```bash
npm run dev                       # development (auto-reload)
npm run build && npm start        # production
```

The server starts on `http://localhost:3000`.

---

## 💬 Slash commands

Anyone with **write access** can drive the bot from PR comments:

| Command | Effect |
|---|---|
| `/ai-merge` or `/ai-merge resolve` | Resolve this PR's conflicts with AI right now |
| `/ai-merge dry-run` | Post proposed resolutions as a comment without pushing |
| `/ai-merge status` | Show mergeability, config, queue and last-run info |
| `/ai-merge help` | List available commands |

The bot reacts 👀 when it picks up a command. Permission is checked live against the repo (with the comment's `author_association` as fallback), so drive-by accounts can't trigger API spend.

---

## 📊 Observability

| Endpoint | What you get |
|---|---|
| `GET /dashboard` | Live HTML dashboard — runs, outcomes, files, fast-path share, tokens, est. spend. Auto-refreshes. |
| `GET /api/stats` | The same aggregates as JSON |
| `GET /api/runs?limit=50` | Recent run records with per-file detail |
| `GET /metrics` | Prometheus text format: `aam_runs_total`, `aam_files_total`, `aam_claude_calls_total`, `aam_tokens_total`, `aam_cost_usd_total`, `aam_run_duration_seconds`, queue gauges |
| `GET /health` | Liveness + version + queue mode + model |

Set `DASHBOARD_TOKEN` in production — then open `/dashboard?token=...` or send `Authorization: Bearer ...`. Without it these endpoints are public (fine for localhost, not for the internet — repo names and PR titles are visible).

---

## Local development with tunneling

```bash
ngrok http 3000
# or
gh webhook forward --events=pull_request,issue_comment --url=http://localhost:3000/webhook
```

Update your GitHub App's webhook URL with the tunnel URL.

---

## Configuration

| Env var | Default | Description |
|---|---|---|
| `GITHUB_APP_ID` | _required_ | Numeric App ID from your GitHub App settings |
| `GITHUB_PRIVATE_KEY` | _required_ | PEM contents of the App's private key (use `\n` for newlines) |
| `GITHUB_WEBHOOK_SECRET` | _required_ | Shared secret used to verify webhook signatures |
| `ANTHROPIC_API_KEY` | _required_ | Anthropic API key for Claude calls |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Model for resolution proposals & syntax repair |
| `ANTHROPIC_JUDGE_MODEL` | `claude-haiku-4-5` | Cheap model that arbitrates diverging proposals |
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `AUTO_APPLY_CONFIDENCE_THRESHOLD` | `high` | Minimum Claude confidence to auto-push (`high`, `medium`, `low`) |
| `MAX_FILES_TO_AUTO_RESOLVE` | `20` | Skip PRs with more conflicted files than this |
| `MAX_FILE_BYTES` | `262144` | Conflicted files larger than this are flagged for manual review instead of sent to the AI |
| `AUTO_MERGE_ON_CI_PASS` | `false` | Arm GitHub auto-merge after a fully-clean resolution (repo must allow auto-merge) |
| `AUTO_MERGE_METHOD` | `SQUASH` | `MERGE`, `SQUASH` or `REBASE` for armed auto-merges |
| `DASHBOARD_TOKEN` | _unset_ | Bearer token guarding `/dashboard`, `/api/*`, `/metrics` |
| `RATE_LIMIT_PER_MIN` | `300` | Per-IP request ceiling; `0` disables |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy so client IPs come from `X-Forwarded-For` |
| `REDIS_URL` | _unset_ | When set, enables BullMQ queueing; otherwise bounded in-process fallback |
| `QUEUE_CONCURRENCY` | `3` | BullMQ worker concurrency |
| `INPROCESS_CONCURRENCY` | `2` | Concurrent merge events without Redis |

Per-repo overrides via `.auto-merge.yml` — see [`.auto-merge.example.yml`](.auto-merge.example.yml). Repo config supports `enabled`, `autoApplyConfidenceThreshold`, `maxFilesToAutoResolve`, `excludePaths`, `dryRun` and `autoMergeOnCIPass`.

---

## What Claude does

For each conflicted file (after fast-path heuristics and lockfile/oversize filters):

1. **Two independent resolutions** are generated with adaptive thinking — a *conservative* strategy (preserve everything from both sides) and a *synthesis* strategy (cleanest unified implementation). Both share a cached prompt prefix (PR title/description, full PR diff, the conflicted file), so the second call reads the cache at ~10% input price.
2. **Convergence check** — if both strategies produce identical content, that is strong evidence of correctness: auto-apply with high confidence, no judge needed.
3. **Judge** — if they diverge, a fast model (Haiku) picks the better proposal or rejects both.
4. **Syntax gate** — TypeScript/JavaScript/Python/Go files are parsed before commit. A failure triggers one AI repair attempt with the exact error message; if it still fails, the file is downgraded to needs-review.

Per file Claude returns **resolved_content**, **confidence** (`high`/`medium`/`low`), an **explanation**, and **needs_review**. Files below your threshold are left for manual resolution and listed clearly in the PR comment, along with token usage and estimated cost.

Files that never reach the AI:

- **Additive conflicts** (both sides added different declarations) — merged deterministically.
- **Import-only conflicts** — merged and deduplicated at the symbol level.
- **Lockfiles** — flagged with the exact regenerate command (`npm install --package-lock-only`, `go mod tidy`, …).
- **Oversized files** (> `MAX_FILE_BYTES`) — flagged for manual review to bound cost.

---

## Architecture

```
GitHub webhook (PR merged / issue_comment)
        ↓  raw-body HMAC verification
  src/handlers/webhook.ts ──── /ai-merge commands (permission-gated)
        ↓
  src/services/queue.ts  (BullMQ if REDIS_URL set, else bounded in-process + dedup)
        ↓  per-PR lock
  src/services/prProcessor.ts
    ├── GitHub API: find conflicted PRs (parallel mergeability polling, fork-PR filter)
    ├── git: clone PR branch, merge base (detect conflicts)
    ├── src/services/conflictClassifier.ts  ← fast paths + lockfile detection
    ├── src/services/conflictResolver.ts    ← Claude: 2 strategies + judge, prompt-cached
    ├── src/services/syntaxCheck.ts         ← parse gate
    │     └── AI syntax repair (one retry with the error)
    ├── git: write resolved files, commit, push --force-with-lease
    ├── GitHub API: post comment (+cost), commit status, optional auto-merge arm
    └── src/services/runHistory.ts + utils/metrics.ts  → /dashboard, /api/*, /metrics
```

---

## FAQ

**Q: What happens if Claude resolves a file incorrectly?**
A: Five layers of defense: dual-strategy convergence (disagreement → judge or human), confidence threshold (don't push low-confidence resolutions), syntax check with AI repair before commit, `--force-with-lease` so concurrent pushes can't be clobbered, and a fully transparent PR comment — a human can revert with one click.

**Q: Does it work on monorepos?**
A: Yes. `MAX_FILES_TO_AUTO_RESOLVE` caps the per-PR fanout, `MAX_FILE_BYTES` caps per-file cost, and `excludePaths` globs keep generated code out of the AI's hands.

**Q: How much does it cost to run?**
A: Each complex conflict costs two cached-prefix Claude calls (+ occasionally a Haiku judge call). Additive/import/lockfile conflicts cost zero AI calls. Every PR comment and the dashboard show the exact token count and estimated dollars, so you never have to guess. Mid-size orgs land at single-digit dollars per week.

**Q: Can the bot merge the PR for me too?**
A: Yes — set `AUTO_MERGE_ON_CI_PASS=true` (or `autoMergeOnCIPass: true` per repo) and enable "Allow auto-merge" in the repo settings. The bot arms GitHub's native auto-merge only when *every* conflicted file resolved at/above your threshold, so partially-resolved PRs always wait for a human.

**Q: What about PRs from forks?**
A: Detected and skipped — a GitHub App can't push to fork branches. The PR is left untouched.

**Q: Can I use a model other than Claude?**
A: Set `ANTHROPIC_MODEL` to any Claude model. For other vendors, the resolver lives in a single file (`src/services/conflictResolver.ts`) — swap the SDK call and open a PR.

**Q: Why TypeScript and not Python / Go?**
A: GitHub's `@octokit/webhooks` + `@anthropic-ai/sdk` are first-class in TypeScript, and Express is the smallest possible webhook surface.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Missing required env var: ...` on boot | `.env` not loaded or var missing. Confirm `dotenv` picks up `./.env`. |
| Webhook returns 401 | `GITHUB_WEBHOOK_SECRET` doesn't match the App's secret. |
| Webhook returns 429 | Rate limiter tripped — raise `RATE_LIMIT_PER_MIN`. |
| `Bad credentials` from GitHub | `GITHUB_PRIVATE_KEY` newlines wrong — must contain literal `\n` escape, not real newlines. |
| Nothing happens after PR merges | The App isn't installed on that repo, or you didn't subscribe to `pull_request` events. |
| `/ai-merge` comments are ignored | Subscribe the App to **Issue comment** events and grant Issues Read & Write. |
| Auto-merge never arms | Enable "Allow auto-merge" in the repository settings. |
| Claude returns low confidence on simple conflicts | PR description is empty — Claude uses it for intent. Add a description and comment `/ai-merge resolve`. |
| `/dashboard` returns 401 | `DASHBOARD_TOKEN` is set — append `?token=...` or send a Bearer header. |

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, commit conventions, and how to add tests.

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

## ⭐ Star history

[![Star History Chart](https://api.star-history.com/svg?repos=manikyashetty-arch/ai-auto-merge&type=Date)](https://star-history.com/#manikyashetty-arch/ai-auto-merge&Date)
