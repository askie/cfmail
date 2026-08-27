import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate, mailboxTag } from "../output.mjs";

const SPEC = { "--limit": "number" };

export const help = `用法: cfmail search "<关键字>" [--limit N]

在所有已存邮件的主题和正文里做全文搜索，中文可以搜。

参数:
  <关键字>     必需。含空格时用引号括起来
  --limit N    最多返回几条，1-100，默认 20

示例:
  cfmail search 发票
  cfmail search "verification code" --limit 5`;

export async function run(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const query = positional.join(" ").trim();
  if (!query) fail('missing search text. Usage: cfmail search "关键字"');
  const cfg = requireConfig("user");

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("search_emails", { query, limit: opts.limit ?? 20 });
  const rows = res?.emails || res?.results || [];

  if (isJson()) return json({ ok: true, query, count: rows.length, emails: rows });
  const tag = mailboxTag(cfg.email);
  if (!rows.length) return out(`没有匹配「${query}」的邮件。${tag}`);
  out(`${rows.length} 封匹配「${query}」${tag}：\n`);
  for (const e of rows) {
    out(
      `• [${formatDate(e.date)}] ${e.subject || "(无主题)"}${e.has_attachments ? " 📎" : ""}\n` +
      `  发件人: ${e.from || "(未知)"}\n` +
      (e.snippet ? `  摘要: ${e.snippet}\n` : "") +
      `  id: ${e.id}\n`
    );
  }
}
