import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate } from "../output.mjs";

const SPEC = {
  "--from": "string", "--to": "string", "--subject": "string",
  "--since": "string", "--until": "string",
  "--limit": "number", "--offset": "number",
};

export const help = `cfmail list [--from X] [--to X] [--subject X] [--since DATE] [--until DATE] [--limit N] [--offset N]

List stored mail newest first, without touching the unread cursor.`;

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
  if (!rows.length) return out("没有匹配的邮件。");
  for (const e of rows) {
    out(`[${formatDate(e.date)}] ${e.subject || "(无主题)"}${e.has_attachments ? " 📎" : ""}  ← ${e.from || "?"}\n  id: ${e.id}`);
  }
  if (res?.next_offset) out(`\n还有更多：加 --offset ${res.next_offset}`);
}
