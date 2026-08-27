import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate } from "../output.mjs";

const SPEC = { "--html": "bool" };

export const help = `Usage: cfmail read <email-id> [--html]

Print one email in full: headers, body, attachment list.

Options:
  <email-id>  Required. Comes from the output of unread / list / search
  --html      Also print the HTML body (only the plain-text body by default)

The output lists each attachment's id at the end, use it with:
  cfmail attachment <attachment-id> --out <path>       download it locally
  cfmail reply <email-id> --forward-attachment <attachment-id>   forward it without downloading first

Examples:
  cfmail read 57d74fd6-c6b0-4b0f-a1ba-59f8f7d0b6cf
  cfmail read 57d74fd6 --html`;

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
