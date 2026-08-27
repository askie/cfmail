import { writeFileSync } from "node:fs";
import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--out": "string" };

export const help = `用法: cfmail attachment <附件id> --out <保存路径>

把一个已存附件下载到本地。

参数:
  <附件id>          必需。从 cfmail read <邮件id> 的输出里拿
  --out <保存路径>  必需。存到哪，含文件名

如果只是想把这个附件转发出去，不用先下载:
  cfmail send --to someone@x.com --subject 转发 --text 见附件 --forward-attachment <附件id>

示例:
  cfmail attachment ed0ee1cf-ea48-4a49-9bfd-1001025d538d --out ./invoice.pdf`;

export async function run(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const id = positional[0];
  if (!id) fail("missing attachment id. Usage: cfmail attachment <id> --out <path>");
  if (!opts.out) fail("missing --out <path>");
  const cfg = requireConfig("user");

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("get_attachment", { attachment_id: id });
  if (!res || res.error) fail(`attachment not found or not yours: ${id}`);
  if (res.content_base64 == null) fail(`attachment has no stored content: ${id}`);

  writeFileSync(opts.out, Buffer.from(res.content_base64, "base64"));
  const meta = res.meta || {};
  if (isJson()) return json({ ok: true, saved: opts.out, meta });
  out(
    `已保存: ${opts.out}\n` +
    `文件名: ${meta.filename || "(未知)"}  类型: ${meta.content_type || "(未知)"}  大小: ${meta.size ?? "?"} 字节`
  );
}
