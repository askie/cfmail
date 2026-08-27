import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate } from "../output.mjs";

const SPEC = {
  "--from": "string", "--to": "string", "--subject": "string",
  "--since": "string", "--until": "string",
  "--limit": "number", "--offset": "number",
};

export const help = `用法: cfmail list [筛选条件] [分页]

按条件列出已存邮件，最新的在前。不碰未读游标，随便查不影响 unread。

筛选条件（可组合，都是「包含」匹配）:
  --from <文本>      发件人包含该文本
  --to <文本>        收件人包含该文本
  --subject <文本>   主题包含该文本
  --since <时间>     早于此时间的不要，ISO 格式如 2026-08-01
  --until <时间>     晚于此时间的不要

分页:
  --limit N          每页几封，1-100，默认 20
  --offset N         跳过前 N 封。输出末尾会提示下一页的 offset

示例:
  cfmail list --from acme.com --limit 50
  cfmail list --subject 发票 --since 2026-08-01
  cfmail list --limit 100 --offset 100     看第二页`;

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
