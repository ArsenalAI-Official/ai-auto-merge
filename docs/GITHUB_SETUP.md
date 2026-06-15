# GitHub credential setup — step by step

This guide takes you from nothing to a running ai-auto-merge that resolves
conflicts on your repositories. It is written so anyone on the team can follow
it without prior context. Estimated time: 10-15 minutes.

## Why a GitHub App (and not a token)

ai-auto-merge runs as a **GitHub App**, not a personal access token. A GitHub
App is required because the service must:

- **Receive webhooks** when pull requests merge (so it knows to act), and
- **Act as an installation** to clone branches, push resolved commits, and post
  comments — with permissions scoped to only the repos you choose.

A personal access token cannot receive webhooks or carry the installation
identity the code relies on, so it will not work.

You create **one** App. It produces **three** credentials that go in `.env`:

| `.env` variable | What it is | Where it comes from |
|---|---|---|
| `GITHUB_APP_ID` | The App's numeric ID | The App's General settings page |
| `GITHUB_PRIVATE_KEY_PATH` | Path to the App's `.pem` private key | Generated and downloaded from the App |
| `GITHUB_WEBHOOK_SECRET` | A random string you choose | You pick it; paste the same value into the App |

> One App + one running server handles **every** repository you install it on.
> There is no per-repo configuration or repo URL anywhere.

---

## Step 1 — Create the GitHub App

1. Go to **https://github.com/settings/apps/new**
   (or: your avatar → Settings → Developer settings → GitHub Apps → New GitHub App).
2. Fill in:
   - **GitHub App name:** any unique name, e.g. `acme-ai-auto-merge`.
   - **Homepage URL:** anything (e.g. your repo URL). This field is cosmetic.
   - **Webhook → Active:** checked.
   - **Webhook URL:** your server's public URL + `/webhook`. For local testing
     you will get this from ngrok in Step 5 — put a placeholder like
     `https://example.com/webhook` now and update it later.
   - **Webhook secret:** generate a strong random value and paste it here. Keep
     it; this is your `GITHUB_WEBHOOK_SECRET`. Generate one with:
     ```bash
     openssl rand -hex 32
     ```
3. **Repository permissions** (leave everything else as No access):
   - Contents → **Read and write**
   - Pull requests → **Read and write**
   - Commit statuses → **Read and write**
   - Issues → **Read and write** (needed for `/ai-merge` slash commands and reactions)
4. **Subscribe to events:** check **Pull request** and **Issue comment**.
5. **Where can this app be installed:** "Only on this account" is fine.
6. Click **Create GitHub App**.

> Do not grant the **Workflows** permission. Without it the App physically
> cannot modify `.github/workflows`, which is the safest default.

---

## Step 2 — Collect the three credentials

After creating the App you land on its settings page.

### App ID
On the **General** tab, near the top, you will see **App ID** followed by a
number (for example `123456`). That number is your `GITHUB_APP_ID`.

> Copy the **App ID**, not the **Client ID**. The Client ID looks like
> `Iv23li...` and is a different value — using it causes a
> `401 "A JSON web token could not be decoded"` error at startup.

### Private key
On the same page, scroll to **Private keys** → **Generate a private key**. A
`.pem` file downloads (e.g. `acme-ai-auto-merge.2026-06-15.private-key.pem`).
Keep this file somewhere safe and note its full path; it is your
`GITHUB_PRIVATE_KEY_PATH`.

> A private key belongs to the App it was generated from. If you create the App
> more than once, make sure the key you use was downloaded from the **same** App
> whose ID you put in `.env`. A mismatched key/ID pair also produces
> `401 "A JSON web token could not be decoded"`.

### Webhook secret
The random string you set in Step 1. That is your `GITHUB_WEBHOOK_SECRET`.

---

## Step 3 — Install the App on your repositories

1. Open **https://github.com/settings/apps**, click your App.
2. In the **left sidebar** click **Install App**.
3. Click **Install** next to your account or organization.
4. Choose **All repositories**, or **Only select repositories** and pick the
   ones you want (you can change this anytime — no redeploy needed).

This is what controls which repos the App acts on. It is not tied to any URL.

---

## Step 4 — Configure `.env`

Copy `.env.example` to `.env` and fill in the GitHub block. The **recommended**
way to supply the private key is by file path — it avoids the single most
common setup error (mangling a multi-line key into a single env var):

```env
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=/absolute/path/to/acme-ai-auto-merge.private-key.pem
GITHUB_WEBHOOK_SECRET=the-random-string-from-step-1
```

Also set your LLM provider (see the main README for the full list):

```env
# Use Claude (default)
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# ...or use OpenAI
# LLM_PROVIDER=openai
# OPENAI_API_KEY=sk-...
```

### Alternative: inline the key instead of a path

If you must inline the key (for example, on a platform that only accepts env
vars), convert the `.pem` to a single line with literal `\n`:

```bash
awk 'NF {printf "%s\\n", $0}' your-app.private-key.pem
```

Paste the output inside double quotes:

```env
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
```

The app validates the key on boot and tells you if the PEM markers are missing.
When both `GITHUB_PRIVATE_KEY_PATH` and `GITHUB_PRIVATE_KEY` are set, the path wins.

---

## Step 5 — Expose your server and run it

GitHub must be able to reach your server. For local testing, use a tunnel:

```bash
# Install ngrok (one-time): brew install ngrok && ngrok config add-authtoken <token from ngrok.com>
ngrok http 3000
# Copy the https URL it prints, then update the App's Webhook URL to:
#   https://<subdomain>.ngrok.app/webhook
```

Then start the app:

```bash
npm install
npm run build && npm start     # or: npm run dev
```

On a real deployment, set the Webhook URL to your server's public HTTPS address
+ `/webhook`, and set `DASHBOARD_TOKEN` to protect the dashboard and metrics.

---

## Step 6 — Verify it works

1. Open `http://localhost:3000/health` — it should report `status: ok` and your
   provider and model.
2. In a repo where the App is installed, create two pull requests that change
   the same lines, then merge one. Within about 30 seconds the other PR's
   conflict should be resolved automatically, with a commit pushed to its branch
   and an explanatory comment.
3. On any open PR you can also comment `/ai-merge status` or `/ai-merge dry-run`.
4. Watch activity at `http://localhost:3000/dashboard`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing required env var: GITHUB_APP_ID` (or others) on boot | The variable is blank in `.env`. Fill it in. |
| `GitHub App private key is malformed: missing PEM markers` | The inlined key lost its `-----BEGIN/END-----` lines. Use `GITHUB_PRIVATE_KEY_PATH` pointing at the `.pem` file instead. |
| `Invalid keyData` at startup | The private key value is not a valid PEM. Re-download the `.pem` and use `GITHUB_PRIVATE_KEY_PATH`. |
| `401 "A JSON web token could not be decoded"` | `GITHUB_APP_ID` does not match the private key. Confirm the App ID on the App's General page (not the Client ID), and that the `.pem` was downloaded from that same App. |
| Webhook returns `401` signature error | `GITHUB_WEBHOOK_SECRET` in `.env` does not match the secret configured in the App. Make them identical. |
| Nothing happens after a PR merges | The App is not installed on that repo (Step 3), or you did not subscribe to the **Pull request** event (Step 1). |
| `/ai-merge` comments are ignored | Subscribe the App to **Issue comment** events and grant Issues: Read and write. |
| Events ignored when using `gh webhook forward` | Repo-level webhook forwarding omits the `installation` object the App relies on. Use the App's own webhook via an ngrok URL instead. |
| `health` shows the wrong provider/model | Check `LLM_PROVIDER` and the matching `*_API_KEY` / `*_MODEL` in `.env`. |

---

## Quick reference: minimal working `.env`

```env
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=/abs/path/to/app.private-key.pem
GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32 output>
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
PORT=3000
NODE_ENV=development
```

That is everything required to run. All other variables have sensible defaults —
see the configuration table in the main [README](../README.md).
