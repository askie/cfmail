import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { out, json, isJson, formatDate } from "../output.mjs";

export const help = `用法: cfmail stats

打印这把 Key 能看到的邮箱概况：邮件总数、带附件的数量、最近一封的时间。

没有参数。常用来确认配置是否生效、服务是否可达。`;

export async function run() {
  const cfg = requireConfig("user");
  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const s = await mcp.call("stats");

  if (isJson()) return json({ ok: true, ...s });
  out(
    `邮箱: ${cfg.email || "(未填)"}\n` +
    `邮件总数: ${s?.total ?? 0}\n` +
    `带附件: ${s?.with_attachments ?? 0}\n` +
    `最近收到: ${formatDate(s?.last_received_at) || "(无)"}`
  );
}
