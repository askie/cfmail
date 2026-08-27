import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate } from "../output.mjs";

const SPEC = { "--limit": "number" };

export const help = `cfmail search <text> [--limit N]

Full-text search over subjects and bodies. Chinese works.`;

export async function run(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const query = positional.join(" ").trim();
  if (!query) fail('missing search text. Usage: cfmail search "关键字"');
  const cfg = requireConfig("user");

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("search_emails", { query, limit: opts.limit ?? 20 });
  const rows = res?.emails || res?.results || [];

  if (isJson()) return json({ ok: true, query, count: rows.length, emails: rows });
  if (!rows.length) return out(`没有匹配「${query}」的邮件。`);
  out(`${rows.length} 封匹配「${query}」：\n`);
  for (const e of rows) {
    out(
      `• [${formatDate(e.date)}] ${e.subject || "(无主题)"}${e.has_attachments ? " 📎" : ""}\n` +
      `  发件人: ${e.from || "(未知)"}\n` +
      (e.snippet ? `  摘要: ${e.snippet}\n` : "") +
      `  id: ${e.id}\n`
    );
  }
}
