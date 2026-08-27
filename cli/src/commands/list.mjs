import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate, mailboxTag } from "../output.mjs";

const SPEC = {
  "--from": "string", "--to": "string", "--subject": "string",
  "--since": "string", "--until": "string",
  "--limit": "number", "--offset": "number",
};

export const help = `Usage: cfmail list [filters] [paging]

List stored mail matching the given filters, newest first. Doesn't touch the
unread cursor, so browsing freely doesn't affect \`unread\`.

Filters (combinable, all "contains" matches):
  --from <text>      Sender contains this text
  --to <text>        Recipient contains this text
  --subject <text>   Subject contains this text
  --since <time>     Exclude anything before this, ISO format like 2026-08-01
  --until <time>     Exclude anything after this

Paging:
  --limit N          How many per page, 1-100, default 20
  --offset N         Skip the first N. The output tells you the next page's offset

Examples:
  cfmail list --from acme.com --limit 50
  cfmail list --subject invoice --since 2026-08-01
  cfmail list --limit 100 --offset 100     see the second page`;

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = requireConfig("user");

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("list_emails", {
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.to ? { to: opts.to } : {}),
    ...(opts.subject ? { subject: opts.subject } : {}),
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
    limit: opts.limit ?? 20,
    ...(opts.offset ? { offset: opts.offset } : {}),
  });
  const rows = res?.emails || res?.results || [];

  if (isJson()) return json({ ok: true, count: rows.length, emails: rows, next_offset: res?.next_offset });
  const tag = mailboxTag(cfg.email);
  if (!rows.length) return out(`没有匹配的邮件。${tag}`);
  if (tag) out(`${tag.slice(1, -1)}\n`);
  for (const e of rows) {
    out(`[${formatDate(e.date)}] ${e.subject || "(无主题)"}${e.has_attachments ? " 📎" : ""}  ← ${e.from || "?"}\n  id: ${e.id}`);
  }
  if (res?.next_offset) out(`\n还有更多：加 --offset ${res.next_offset}`);
}
