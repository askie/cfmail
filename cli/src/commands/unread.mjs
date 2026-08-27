import { Mcp } from "../mcp.mjs";
import { readStoredConfig, saveConfig, requireConfig, listAccounts } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate, mailboxTag } from "../output.mjs";

const SPEC = {
  "--peek": "bool", "--all": "bool", "--reset": "bool", "--limit": "number",
};

export const help = `用法: cfmail unread [选项]

收取比上次更新的邮件，然后把游标推进到最新。

服务端不记录已读/未读，本机用一个游标记住「看到哪儿了」，所以已读状态是每台
机器各自独立的。

参数:
  --peek        只看，不推进游标（下次还会再列出来）
  --all         忽略游标，直接看最近的邮件（也不推进游标）
  --limit N     最多列几封，1-100，默认 20
  --reset       把当前所有邮件标记为已读，不打印内容

示例:
  cfmail unread                 收新邮件并标记已读
  cfmail unread --peek          先看看有什么，不标记
  cfmail unread --all --limit 5 最近 5 封，不管读没读过
  cfmail unread --reset         从现在开始只看新的`;

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

  const tag = mailboxTag(cfg.email, listAccounts("user").names.length);
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
