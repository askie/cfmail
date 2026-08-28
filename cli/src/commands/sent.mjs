import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate, mailboxTag } from "../output.mjs";

const SPEC = {
  "--since": "string", "--until": "string", "--from": "string",
  "--limit": "number", "--offset": "number", "--stats": "bool",
};

export const help = `Usage: cfmail sent [filters] [paging] [--stats]

List mail sent from this mailbox, newest first, with whether each one was
opened. Opens are counted by a 1x1 image the service embeds in every outgoing
message, so the numbers are a floor: clients that block remote images never
register, while some privacy proxies fetch the image without a human looking.

Filters:
  --since <time>     Only mail sent at or after this, ISO like 2026-08-01
  --until <time>     Only mail sent at or before this
  --from <address>   Admin key only: another sending address

Paging:
  --limit N          How many per page, 1-100, default 20
  --offset N         Skip the first N

  --stats            Only the summary line (total / tracked / opened / open rate)

Examples:
  cfmail sent
  cfmail sent --since 2026-08-01 --stats
  cfmail sent --limit 50 --offset 50`;

function summary(s) {
  const rate = s?.open_rate == null ? "—" : `${s.open_rate}%`;
  return `已发 ${s?.total ?? 0} 封，其中带统计 ${s?.tracked ?? 0} 封，被打开 ${s?.opened ?? 0} 封（打开率 ${rate}，累计打开 ${s?.opens ?? 0} 次）`;
}

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = requireConfig("user");
  const scope = {
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
    ...(opts.from ? { from: opts.from } : {}),
  };

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const stats = await mcp.call("sent_stats", scope);
  if (opts.stats) {
    if (isJson()) return json({ ok: true, ...stats });
    return out(summary(stats));
  }

  const res = await mcp.call("list_sent", {
    ...scope, limit: opts.limit ?? 20, ...(opts.offset ? { offset: opts.offset } : {}),
  });
  const rows = res?.sent || [];
  if (isJson()) return json({ ok: true, stats, count: rows.length, sent: rows, next_offset: res?.next_offset });

  const tag = mailboxTag(cfg.email);
  if (tag) out(`${tag.slice(1, -1)}`);
  out(summary(stats) + "\n");
  if (!rows.length) return out("没有已发邮件。");
  for (const e of rows) {
    const state = !e.tracked ? "未统计"
      : e.opened ? `已打开 ${e.open_count} 次，首次 ${formatDate(e.first_opened_at)}`
      : "未打开";
    out(`[${formatDate(e.sent_at)}] ${e.subject || "(无主题)"}  → ${e.to || "?"}\n  ${state}  id: ${e.id}`);
  }
  if (res?.next_offset) out(`\n还有更多：加 --offset ${res.next_offset}`);
}
