# newsletterapp

A personal reader for email newsletters (and, in later phases, RSS feeds and websites), built on Cloudflare's free plan.

Phase 1, in this repo today:

- Dedicated sign-up addresses on your own domain (`money-matters@yourdomain.com`), one per newsletter.
- Emails are received by a Cloudflare Email Worker, stored (original `.eml` in R2, metadata in D1) and shown in a phone-first web app that installs as a PWA.
- Inbox with unread / saved / archived views, per-newsletter filter, newest or oldest sort, swipe left to mark read and swipe right to save.
- Reader with remote images blocked until you ask, web version and original download, unsubscribe link, and reading events (opens, time spent, finishes, link clicks) recorded for later stats.
- Spam screening: the first sender to a new address is allowed automatically, anyone else waits on the **Senders** screen until you allow or block them. Blocked addresses and senders are dropped silently.
- Sign-in through Cloudflare Access (one-time PIN to your email). No passwords to manage.

Later phases add AI summaries and tags (local Ollama via a PC helper, hosted model for the digest), feeds and website pulls, related-article links, source statistics, search, and the retention budgets. See the plan document for the full design.

## Layout

```
apps/worker     Cloudflare Worker: email handler + JSON API (Hono) + serves the web app
apps/web        React + Vite PWA
apps/helper     PC helper (Node, Windows): pulls AI jobs, runs Ollama, posts summaries back
packages/shared Types shared by all three
scripts/        prepare-deploy.mjs, run by the deploy workflow
```

## One-time setup

Everything below is clicking around the Cloudflare and GitHub dashboards. Nothing needs to be pasted into this repo; secrets live in GitHub Actions.

### 1. Cloudflare account and domain

1. Create a Cloudflare account (or sign in) and turn on two-factor authentication under **My Profile → Authentication**.
2. **Domain Registration → Register Domains**, buy your domain (a `.com` is about US$10.50 a year at cost). If the domain is registered elsewhere, use **Add a site** instead and point its nameservers at Cloudflare.

### 2. Email Routing

1. Open the domain → **Email → Email Routing → Get started**. Accept the MX and SPF records it offers.
2. Leave the catch-all rule alone for now; it needs the Worker to exist first (step 6).

### 3. Cloudflare Access (sign-in)

1. **Zero Trust** (left menu). On first visit pick a team name and the **Free** plan. The team name becomes your team domain: `<team>.cloudflareaccess.com`.
2. **Access → Applications → Add an application → Self-hosted**.
   - Application name: `Reader`
   - Session duration: `1 month` (or whatever you like)
   - Domain: `app.yourdomain.com`
3. Add a policy: name `Me`, action **Allow**, Include → **Emails** → your email address.
4. Save, then open the application's **Overview** and copy the **Application Audience (AUD) tag**.

### 4. API token and account id

1. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template.
2. Make sure the permissions include **Account → D1 → Edit** and **Account → Workers R2 Storage → Edit** (add them if the template doesn't).
3. Account Resources: your account. Zone Resources: your domain.
4. Create the token and copy it once. Treat it like a password.
5. Your **Account ID** is on the domain's **Overview** page, right-hand column.

### 5. GitHub secrets and variables

In this repository: **Settings → Secrets and variables → Actions**.

Secrets:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 4 |
| `CLOUDFLARE_ACCOUNT_ID` | your account id |

Variables:

| Name | Value |
| --- | --- |
| `APP_HOSTNAME` | `app.yourdomain.com` |
| `MAIL_DOMAIN` | `yourdomain.com` |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | the AUD tag from step 3 |
| `ALLOWED_EMAILS` | your email address (comma-separate several) |

### 6. First deploy and the catch-all rule

1. Merge to `main` (or run the **Deploy** workflow by hand). The workflow creates the D1 database and R2 bucket if they don't exist, applies migrations, deploys the Worker and attaches `app.yourdomain.com` as a custom domain.
2. Back in Cloudflare: **Email → Email Routing → Routing rules → Catch-all address → Edit**: action **Send to a Worker**, destination `newsletterapp`. Save and make sure the catch-all is enabled.
3. Open `https://app.yourdomain.com`, sign in with the PIN Cloudflare emails you, and create your first address under **Add**.

If you also want ordinary mailboxes on the domain (say `jeff@`), add explicit routing rules forwarding them to Gmail; explicit rules win over the catch-all.

## AI summaries (PC helper)

Every item gets a quick summary from rules when it arrives (preview line, reading time, sponsored flag, rules-based category). AI summaries come from a small helper on your PC that only makes outbound requests:

1. It checks in with `POST /api/helper/heartbeat` every minute (models it can see, PC load), and gets back whether AI is paused and the switched-on models in your preferred order.
2. It claims up to 5 waiting items (`/api/helper/claim`), summarises each with the first switched-on model, and posts the JSON result (`/api/helper/result`). A claimed item goes back in the queue after 10 minutes; after 3 failed tries it is set aside. Five failures in a row pause all AI until you press Resume.
3. Which items qualify is decided at claim time from the AI switches (per source kind in Settings, overridable per newsletter).

The helper signs in with a Cloudflare Access **service token**. Set it up once:

1. Zero Trust → Access → Service credentials → Service Tokens → Create. Copy the Client ID and Secret.
2. Your Access application → Policies → add a policy with action **Service Auth**, include that service token.
3. Add the repository variable `HELPER_CLIENT_ID` (the Client ID only) and redeploy. The Worker only lets that token use `/api/helper/*`, and people can't call those endpoints.
4. On the PC: Node.js 20+ and Ollama, then download `newsletter-helper.mjs` and `install-helper.ps1` from **Settings → PC helper, models and prompts** and run `powershell -ExecutionPolicy Bypass -File install-helper.ps1`.

The helper keeps its config and log in `%LOCALAPPDATA%\NewsletterHelper` and updates itself when `HELPER_VERSION` in `packages/shared` changes; bump it with every helper change. For local testing against `wrangler dev`, run it with `HELPER_DEV=1 HELPER_CONFIG=path/to/config.json`.

## How screening works

- Each address is either created in the app (**Add**) or appears on its own when mail arrives for it.
- A sender is keyed by (from address, your address). The first sender to an address you created in the app, within `AUTO_ALLOW_DAYS` (14) of creating it, is allowed automatically, unless its SPF/DKIM/DMARC checks failed.
- Any other new sender lands in **Senders → New**, where you allow or block it. Allowing moves its held emails to the inbox; blocking drops them.
- Mail to a blocked address, from a blocked sender, or to an unknown address with failed authentication is dropped and counted. Nothing is bounced, so senders can't tell an address exists.

## Local development

```sh
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # sets DEV_BYPASS_AUTH=1 and your email
pnpm migrate:local
pnpm dev:worker          # API + email handler on http://localhost:8787
pnpm dev                 # web app on http://localhost:5173, proxied to the worker
```

Send a test email to the local Worker:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=hello@example.com&to=test@yourdomain.com' \
  -H 'content-type: message/rfc822' --data-binary @some-message.eml
```

`DEV_BYPASS_AUTH` only works when running locally with wrangler; a deployed Worker with Access not configured refuses every request (503).

## Costs

Cloudflare free plan covers Email Routing, Workers (100k requests/day), D1 (5 GB), R2 (10 GB) and Access (up to 50 users). The only recurring cost is the domain. Workers Paid (US$5/month) stays an option if the free CPU limits or storage become a problem.
