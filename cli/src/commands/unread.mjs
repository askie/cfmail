import { Mcp } from "../mcp.mjs";
import { loadConfig, saveConfig, requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate } from "../output.mjs";

const SPEC = {
  "--peek": "bool", "--all": "bool", "--reset": "bool", "--limit": "number",
};

export const help = `cfmail unread [--peek] [--all] [--limit N] [--reset]

List mail newer than the local cursor, then advance it.
  --peek    show them without advancing the cursor
  --all     ignore the cursor and show the most recent mail
  --reset   mark everything as read without printing`;

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = requireConfig("user");
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("list_emails", { limit });
  const all = res?.emails || res?.results || [];

  const cursor = cfg.cursor ?? 0;
  const rows = opts.all ? all : all.filter((e) => (e.date ?? 0) > cursor);
  const newest = all.reduce((m, e) => Math.max(m, e.date ?? 0), cursor);

  if (opts.reset) {
    saveConfig({ ...loadConfig("user"), cursor: newest }, "user");
    if (isJson()) return json({ ok: true, reset: true, cursor: newest });
    return out(`已把当前全部邮件标记为已读（游标 ${formatDate(newest)}）`);
  }

  // Only a plain run advances the cursor: --peek and --all are for looking.
  if (!opts.peek && !opts.all && rows.length) {
    saveConfig({ ...loadConfig("user"), cursor: newest }, "user");
  }

  if (isJson()) return json({ ok: true, count: rows.length, emails: rows });

  if (!rows.length) return out(opts.all ? "没有邮件。" : "没有新邮件。");
  out(`${rows.length} 封${opts.all ? "邮件" : "未读邮件"}${cfg.email ? `（${cfg.email}）` : ""}：\n`);
  for (const e of rows) {
    out(
      `• [${formatDate(e.date)}] ${e.subject || "(无主题)"}${e.has_attachments ? " 📎" : ""}\n` +
      `  发件人: ${e.from_name ? `${e.from_name} <${e.from}>` : e.from || "(未知)"}\n` +
      (e.snippet ? `  摘要: ${e.snippet}\n` : "") +
      `  id: ${e.id}\n`
    );
  }
  out(`提示: cfmail read <id> 看全文，cfmail reply <id> --text "..." 回信。`);
}
