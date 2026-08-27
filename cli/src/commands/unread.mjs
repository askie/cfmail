import { Mcp } from "../mcp.mjs";
import { readStoredConfig, saveConfig, requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate, mailboxTag } from "../output.mjs";

const SPEC = {
  "--peek": "bool", "--all": "bool", "--reset": "bool", "--limit": "number",
};

export const help = `Usage: cfmail unread [options]

Fetch mail newer than last time, then advance the cursor to the latest.

The server doesn't track read/unread — a local cursor remembers "seen up to
here", so read state is independent on every machine.

Options:
  --peek        Look only, don't advance the cursor (shows up again next time)
  --all         Ignore the cursor, show the most recent mail (doesn't advance it either)
  --limit N     How many to list, 1-100, default 20
  --reset       Mark everything currently there as read, without printing it

Examples:
  cfmail unread                 fetch new mail and mark it read
  cfmail unread --peek          look without marking anything
  cfmail unread --all --limit 5 the last 5, regardless of read state
  cfmail unread --reset         only see new mail from now on`;

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
    saveConfig({ ...readStoredConfig("user"), cursor: newest }, "user");
    if (isJson()) return json({ ok: true, reset: true, cursor: newest });
    return out(`已把当前全部邮件标记为已读（游标 ${formatDate(newest)}）`);
  }

  // Only a plain run advances the cursor: --peek and --all are for looking.
  if (!opts.peek && !opts.all && rows.length) {
    saveConfig({ ...readStoredConfig("user"), cursor: newest }, "user");
  }

  if (isJson()) return json({ ok: true, count: rows.length, emails: rows });

  const tag = mailboxTag(cfg.email);
  if (!rows.length) return out(`没有${opts.all ? "" : "新"}邮件。${tag}`);
  out(`${rows.length} 封${opts.all ? "邮件" : "未读邮件"}${tag}：\n`);
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
