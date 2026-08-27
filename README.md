# cfmail · Give your Agent a mailbox it can use on its own

English | [简体中文](./README.zh-CN.md)

## What is this

**The goal is simple: let an Agent receive and send email on its own, with no human forwarding, approving, or clicking "send" in the middle.** It runs on [Cloudflare](https://cloudflare.com) and **has no web UI** — this isn't an inbox for you to browse; it's a mailbox for an AI/program to use as its own.

> Mail sent to `anything@your-domain` is caught and stored automatically. The Agent searches it, reads the full text, replies, and forwards attachments on its own — you don't have to forward mail to it, and it doesn't have to wait for you to click send.

```
Someone emails you ──▶ Cloudflare receives it ──▶ parsed automatically, stored in a database and object storage
                                                              │
Agent ──asks a question / sends mail──▶ cfmail CLI (or MCP directly) ──▶ this service's API ──┘
```

**Startup cost is close to zero** — Cloudflare's and Resend's free tiers are enough, and neither requires a credit card:

| Piece | Free tier |
| --- | --- |
| Receiving mail (Cloudflare Email Routing) | Unlimited, free by design |
| Running the service (Cloudflare Workers) | 100,000 requests/day |
| Storing mail bodies/index (Cloudflare D1) | 5 GB, 5M reads/day |
| Storing raw attachments (Cloudflare R2) | 10 GB/month |
| Sending mail (Resend, default backend) | 3,000/month, 100/day |

For a small project used by one person or a handful of Agents, these limits are hard to hit; upgrade later if volume actually grows.

It fits these situations:

- Give an Agent a mailbox that is genuinely its own, so it can independently complete the whole "receive → understand → reply/forward" loop with no manual step in between.
- Receive **verification codes, notifications, bills, invoices** on your own domain and let AI find and organize them for you.
- Sync mail — body and attachments — to local disk on a schedule, and get pushed a chat message with a clickable local file the moment new mail arrives.

Technical details (database schema, search design, component breakdown, the dual send-backend design) are in [ARCHITECTURE.md](./ARCHITECTURE.md).

This document has two parts: **Setup** — deploying the service to your own Cloudflare account; and **Usage** — once it's deployed, how to let an Agent use it to send and receive mail.

---

## Setup: deploy to Cloudflare (~10 minutes)

> Everything happens in **your own Cloudflare account** — mail only ever lives under your account, no one else can reach it.

### What you need

1. A **Cloudflare account** (the free plan is enough).
2. A **domain already added to that account** (used both to receive mail and to reach the service).
3. **Node.js 18 or newer** installed locally.

### Step 0: get the code, log in, create your local config

```bash
git clone <this-repo> && cd cfmail
npm install
npx wrangler login                       # log into your Cloudflare account in the browser
cp wrangler.jsonc wrangler.local.jsonc   # your private config, never pushed to the repo
```

> Anything tied to your account — your domain, database ID — goes in `wrangler.local.jsonc`. It's gitignored already; every command below picks it up automatically.

### Step 1: create the database (stores mail metadata and bodies)

```bash
npx wrangler d1 create email_db
```

The command prints a `database_id` — copy it into `wrangler.local.jsonc` at `d1_databases[0].database_id`.

### Step 2: create object storage (stores raw mail and attachments)

```bash
npx wrangler r2 bucket create email-store
```

### Step 3: set your domain

Open `wrangler.local.jsonc` and change `routes[0].pattern` to whatever subdomain you want, e.g. `mail.yourdomain.com` (it must be a domain in your Cloudflare account). This address is what the Agent will connect to.

### Step 4: create the tables, set an access password, deploy

```bash
npm run db:remote                        # create the tables
npx wrangler secret put MCP_TOKEN        # set an access password (see below)
npm run deploy                           # deploy
```

> **Access password**: after running that command, paste in a sufficiently long random string as the password — `openssl rand -hex 32` works. The Agent needs this password to connect; **never leak it**. To rotate it, just rerun the command — the old password stops working immediately.

### Step 5: route incoming mail to this service

Send every email addressed to your domain into this service (a one-time setup):

```bash
# replace <ZONE_ID> with your domain's Zone ID, and <API_TOKEN> with a Cloudflare API token that has "Email Routing edit" permission
curl -X PUT "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/email/routing/rules/catch_all" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  --data '{"enabled":true,"name":"catch-all to worker","matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["cloudflare-email"]}]}'
```

Prefer clicking through the dashboard instead: **Cloudflare dashboard → your domain → Email Routing → Catch-all → action "Send to a Worker" → pick `cloudflare-email`**.

> If this domain has never had Email Routing turned on, enable it in the dashboard first (it adds the DNS records mail delivery needs automatically).

**Done!** Mail to `anything@your-domain` is now caught, and the service is live at `https://your-subdomain`. To check: send a test email to `test@your-domain`, then within a few seconds `npx wrangler tail cloudflare-email` should show it being processed; the Agent will be able to find it once you've set up "Usage" below.

### Optional: enable sending

Skip this step and the service can only receive mail, not send it. Two backends are supported, and **Resend is the default**:

**Option one, Resend (recommended):**

1. Sign up at [Resend](https://resend.com) and add your domain — use the root domain (`yourdomain.com`) directly, no need for a subdomain.
2. Add the three DNS records it gives you, in Cloudflare DNS:

   | Type | Name | Value | Proxy |
   | --- | --- | --- | --- |
   | MX | `send` | the address Resend gives you, priority 10 | — |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
   | TXT | `resend._domainkey` | the DKIM public key Resend gives you | **DNS only (grey-cloud it)** |

   > This MX record lives on `send.yourdomain.com`, so it doesn't conflict with Email Routing on the root domain. The DKIM record must have the proxy turned off — leaving it proxied fails verification.

3. Set the key as a secret: `npx wrangler secret put RESEND_API_KEY -c wrangler.local.jsonc`

The free tier is 3,000 emails/month, 100/day — enough to get started; pay as you grow, or switch to the option below.

**Option two, Cloudflare's built-in sending:** confirm `wrangler.local.jsonc` has `"send_email": [{ "name": "EMAIL" }]` (already in the template), then do a one-time Email Sending onboarding for your domain under Cloudflare's Email dashboard. If you're only sending to addresses you've already verified under Email Routing → Destination addresses, you can skip onboarding entirely and send for free right away.

With neither configured, sending returns a "no send backend available" message that explains what to set up; receiving and querying are unaffected. For details on sending — attachment size limits, sender restrictions, how to debug a failure — see [ARCHITECTURE.md](./ARCHITECTURE.md) and [cli/README.md](./cli/README.md); when a send fails, the Agent reads the error code and tells you what went wrong, so you don't need to memorize these limits up front.

### Ongoing maintenance after deploying

```bash
npx wrangler tail cloudflare-email        # tail incoming mail and errors live
npx wrangler secret put MCP_TOKEN         # rotate the access password
npx wrangler d1 execute email_db --remote --command "SELECT id,subject,from_addr,date FROM emails ORDER BY date DESC LIMIT 10"
```

> `wrangler.local.jsonc` only exists on your machine — don't delete it by accident. If you do, redo "Step 0" and fill your database ID and domain back in.

---

## Usage: let an Agent send and receive mail

Once deployed, there are three ways to wire it up to an Agent. **Skills are the recommended path** — it's the least fuss, and closest to the goal of "the Agent handles mail on its own."

### Preferred: use the skills (recommended)

The `skills/` directory has two skills that teach an Agent to work through the `cfmail` command-line tool:

```
skills/
  email-inbox/   for a regular user: read and send mail with a bound Key
  email-admin/   for an admin: open mailboxes, issue/revoke Keys, configure new-mail alerts
```

The two work together: the **admin** uses `email-admin` to issue a Key for a mailbox address, and the **user** puts that Key into `email-inbox` to send and receive mail.

**Step 0, install `cfmail`** (needs Node 20+):

```bash
npm install -g cfmail
```

**Step 1, copy the skills into the Agent's skills directory.** For Claude Code, that's `.claude/skills/`:

```bash
cp -r skills/email-inbox  your-project/.claude/skills/
cp -r skills/email-admin  your-project/.claude/skills/
```

> You can also symlink the whole `skills/` directory: `ln -s /path/to/cfmail/skills your-project/.claude/skills`.

**Step 2 (admin), open a mailbox:**

```bash
cfmail admin setup --base https://your-subdomain --key <admin-MCP_TOKEN>   # one-time
cfmail admin create-key alice@your-domain                                 # prints a plaintext Key, shown only once
```

Other admin commands: `list-keys` (see what's been issued), `delete-key <address>` (revoke), `webhook --set whk_xxx` (push new mail to chat, optional — see [cli/README.md](./cli/README.md)).

**Step 3 (user), configure that Key:**

```bash
cfmail setup --base https://your-subdomain --email alice@your-domain --key <the-key-from-step-2>
```

**Once it's configured, just talk to the Agent:**

- "Check if there's any new mail" / "Find that verification code email"
- "Reply to that invoice email and confirm we got it"
- "Forward that attachment to accounting"

It picks the right command on its own, reading full text, fetching attachments, and replying as needed. Mail is always sent from the address bound to the Key — that's enforced server-side and can't be changed.

**If you also want mail synced to local disk, with a chat push carrying a clickable file link when new mail arrives** — that's a separate, optional add-on outside the skills flow:

```bash
cfmail sync --dir ~/cfmail --notify whk_your-key
```

Put it on a schedule with launchd/cron. Directory layout, dedup rules, and how this differs from `admin webhook` are all in [cli/README.md](./cli/README.md).

> Security note: `email-admin` holds the highest-privilege admin key — **keep it on the admin's own machine only, never hand it to a regular user**.

### Alternative: use the `cfmail` command line directly

Without the skills, an Agent (or you) can just run commands:

```bash
cfmail unread                                              # fetch the latest unread mail
cfmail search "invoice"                                    # full-text search, Chinese included
cfmail read <email-id>                                     # read the full text and attachment list
cfmail send --to a@x.com --subject "subject" --text "body"  # send one
cfmail reply <email-id> --text "reply text"                 # reply within the original thread
cfmail config                                              # see which mailbox this config points at
```

Managing multiple mailboxes on one machine, running several Agents concurrently, the local archive layout, and every flag — the full reference is [cli/README.md](./cli/README.md) (every command also answers `--help`).

### Alternative: skip the CLI, connect the service as MCP directly

If you'd rather not install the CLI, you can point an MCP-capable AI client straight at the service:

```bash
claude mcp add --transport http email https://your-subdomain/mcp \
  --header "Authorization: Bearer your-password"
```

Other MCP clients use a config file:

```json
{
  "mcpServers": {
    "email": {
      "url": "https://your-subdomain/mcp",
      "headers": { "Authorization": "Bearer your-password" }
    }
  }
}
```

Once connected, just ask in plain language: "search for mail containing 'invoice'", "open the first one and download the attachment" — under the hood this uses tools like `search_emails` / `list_emails` / `get_email` / `get_attachment` / `send_email`, chosen automatically by the AI; you don't need to remember their names. This path doesn't get you local archiving or multi-mailbox management — those are `cfmail`-only.

---

## FAQ

- **The service URL won't load / connection reset**: don't use the default `*.workers.dev` (blocked in some regions) — use your own domain (which is what this project does by default).
- **A test email you sent bounced (550 SPF)**: that's a sender-side validation issue; sending from a normal mailbox (Gmail, QQ, Outlook, etc.) isn't affected.
- **A mail you just sent doesn't show up yet**: there's a few seconds of delay between receiving and indexing — wait and check again, or use `npx wrangler tail cloudflare-email` to see if it arrived.
- **Getting a 401**: check that `Authorization: Bearer your-password` is set correctly.

## For contributors: local development

```bash
cp .dev.vars.example .dev.vars                 # fill in a local access password
npm run db:local                               # create local database tables
npm run dev                                     # start locally on :8787
MCP_TOKEN=your-local-password node scripts/mcp-smoke.mjs    # smoke-test the local API
npm test                                        # unit tests
npm run typecheck                               # type checking
```

Smoke-test against production: `BASE="https://your-subdomain" TOKEN="your-password" node scripts/remote-check.mjs`

## License

[MIT](./LICENSE) — free to use, modify, and distribute.
