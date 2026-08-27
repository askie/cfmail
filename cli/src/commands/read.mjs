import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate } from "../output.mjs";

const SPEC = { "--html": "bool" };

export const help = `cfmail read <email-id> [--html]

Print one email's full body. Attachment ids are listed at the end — pass one to
\`cfmail attachment\` to download it, or to \`cfmail reply --forward-attachment\`.`;

export async function run(argv) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const id = positional[0];
  if (!id) fail("missing email id. Usage: cfmail read <email-id>");
  const cfg = requireConfig("user");

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const e = await mcp.call("get_email", { id, include_html: !!opts.html });
  if (!e || e.error) fail(`email not found or not yours: ${id}`);

  if (isJson()) return json({ ok: true, email: e });

  out(
    `主题: ${e.subject || "(无主题)"}\n` +
    `发件人: ${e.from_name ? `${e.from_name} <${e.from}>` : e.from || "(未知)"}\n` +
    `收件人: ${e.to || "(未知)"}${e.cc ? `\n抄送: ${e.cc}` : ""}\n` +
    `时间: ${formatDate(e.date)}\n` +
    `${"-".repeat(60)}\n` +
    `${e.text || "(无纯文本正文)"}\n`
  );
  if (opts.html && e.html) out(`${"-".repeat(60)}\nHTML 正文:\n${e.html}\n`);
  if (e.attachments?.length) {
    out(`${"-".repeat(60)}\n附件 ${e.attachments.length} 个：`);
    for (const a of e.attachments) {
      out(`  ${a.filename || "(未命名)"}  ${a.content_type || ""}  ${a.size ?? "?"} 字节\n    id: ${a.id}`);
    }
  }
}
