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

## Secrets

If you find a leaked secret (API key, private key, webhook secret) in the repository's history, please report it privately so it can be rotated before any disclosure.
