import { writeFileSync } from "node:fs";
import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--out": "string" };

export const help = `cfmail attachment <attachment-id> --out <path>

Download one stored attachment. To attach it to an outgoing mail there is no
need to download it first — use \`cfmail send --forward-attachment <id>\`.`;

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
