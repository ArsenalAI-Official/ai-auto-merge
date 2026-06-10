# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, report them privately via GitHub's [Private Vulnerability Reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) on the repository, or email the maintainers at the address listed in the repository's GitHub profile.

When reporting, please include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected versions
- Any suggested mitigation

## Disclosure timeline

We aim to:

- Acknowledge your report within **2 business days**
- Provide an initial assessment within **7 days**
- Release a fix or mitigation within **30 days** for confirmed vulnerabilities (longer if the fix requires significant rework)
- Publish a coordinated advisory after the fix ships

## Scope

In scope: the source code in this repository, including the GitHub App handler, conflict resolution pipeline, and dependencies pinned in `package.json`.

Out of scope: third-party services (GitHub API, Anthropic API), user misconfiguration of their deployed instance, and DoS via the public webhook endpoint when not behind a rate limiter.

## Threat model

What a deployed instance holds and what an attacker could want:

| Asset | Exposure |
|---|---|
| GitHub App private key & webhook secret | Env vars only; never logged, never written to disk |
| Anthropic API key | Env var only |
| Installation tokens | Minted per run, short-lived, passed to git via `http.extraHeader` (never embedded in URLs, so they don't reach reflogs or process listings) |
| Write access to PR branches | The blast radius of the App: it can push commits to non-fork PR branches of repos it's installed on — nothing else |

Untrusted inputs and their defenses:

- **Webhook payloads** — HMAC-verified against the exact raw bytes before any processing; events without an installation id are dropped; owner/repo/ref names are validated against strict allow-lists before reaching git (no leading `-`, no `..`, no revision syntax).
- **PR branch contents** (anyone who can open a PR controls these) — workspaces are cloned with `core.symlinks=false` so symlinks materialize as inert text; every read/write is containment-checked against the workspace root; non-regular files are skipped; client-side git hooks never run (`--no-verify`, hooks aren't cloned); syntax checkers are invoked via `execFile` (no shell) on generated temp filenames.
- **Prompt injection** (PR titles/descriptions/diffs/file contents can address the model) — system prompts instruct Claude to treat all repo content as data, not instructions, and to flag manipulation as `needs_review`; inputs are size-capped. **Residual risk is real**: an LLM resolving conflicts can be steered into producing subtly wrong code. The layered mitigations are dual-strategy convergence, the judge model, the confidence threshold, the syntax gate, and — decisively — that every resolution is an ordinary commit on a PR branch that humans review before merge. Do not treat auto-resolved PRs as exempt from code review.
- **Fork PRs** — skipped entirely (the App cannot and should not push to forks).
- **Slash commands** — gated on live collaborator permission (write+), with `author_association` fallback; bot comments are ignored to prevent loops.

## Deployment hardening checklist

- Terminate TLS in front of the app; set `TRUST_PROXY=true` **only** when behind a proxy (otherwise X-Forwarded-For spoofing defeats the per-IP rate limiter).
- Set `DASHBOARD_TOKEN` — without it `/dashboard`, `/api/*` and `/metrics` expose repo names, PR titles and spend to anyone who can reach the port.
- Grant the GitHub App only Contents, Pull requests, Commit statuses, and Issues (R/W). Do **not** grant Workflows: the App then physically cannot push `.github/workflows` changes.
- Use `excludePaths` in `.auto-merge.yml` for sensitive files (CI config, infra, codeowners) you never want AI-touched.
- Keep `MAX_FILE_BYTES` / `MAX_FILES_TO_AUTO_RESOLVE` bounded — they are your cost-DoS guards.
- If you enable Redis, require auth on it (`REDIS_URL` with password) and keep it off the public network.
- The Docker image runs as a non-root user with lifecycle scripts disabled at install time.
- Outbound notifications (`SLACK_WEBHOOK_URL`, `NOTIFY_WEBHOOK_URL`) are operator-configured trusted destinations; payloads contain repository names, PR titles, file paths, and spend — point them only at channels cleared to see that.
- The learning store keeps file paths and accept/override counts in process memory only; it holds no file contents and is not persisted.

## Secrets

If you find a leaked secret (API key, private key, webhook secret) in the repository's history, please report it privately so it can be rotated before any disclosure.
