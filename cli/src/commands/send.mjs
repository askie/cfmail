import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Mcp } from "../mcp.mjs";
import { requireConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = {
  "--to": "list", "--cc": "list", "--subject": "string",
  "--text": "string", "--text-file": "string",
  "--reply": "string", "--attach": "list", "--forward-attachment": "list",
};

export const help = `cfmail send --to <address> --subject <text> --text <body> [options]
cfmail reply <email-id> --text <body> [options]

Send as the address this key is bound to; the sender cannot be spoofed.

  --to <addr>                 recipient; repeat for several
  --cc <addr>                 carbon copy; repeat for several
  --subject <text>            subject; optional when replying
  --text <body>               plain-text body
  --text-file <path>          read the body from a file (long or multi-line text)
  --reply <email-id>          reply in-thread; recipient, subject and threading
                              headers are derived from that email
  --attach <path>             attach a local file; repeat for several
  --forward-attachment <id>   attach a stored attachment without downloading it`;

// Enough for the recipient's mail client to show a sensible icon and preview.
const MIME = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".heic": "image/heic",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function readAttachment(path) {
  if (!existsSync(path)) fail(`--attach file not found: ${path}`);
  if (statSync(path).isDirectory()) fail(`--attach is a directory, not a file: ${path}`);
  return {
    filename: basename(path),
    content_type: MIME[extname(path).toLowerCase()] || "application/octet-stream",
    content_base64: readFileSync(path).toString("base64"),
  };
}

// `replyId` is set when invoked as `cfmail reply <id>`, which is the same
// operation with the id given positionally.
export async function run(argv, replyId) {
  const { opts, positional } = parseArgs(argv, SPEC);
  const reply = replyId ? positional[0] : opts.reply;
  if (replyId && !reply) fail("missing email id. Usage: cfmail reply <email-id> --text \"...\"");

  if (opts.text != null && opts.textFile) fail("use either --text or --text-file, not both");
  let text = opts.text;
  if (opts.textFile) {
    if (!existsSync(opts.textFile)) fail(`--text-file not found: ${opts.textFile}`);
    text = readFileSync(opts.textFile, "utf8");
  }
  if (text == null) fail('missing body: pass --text "..." or --text-file <path>');
  if (!reply && !opts.to?.length) fail("missing recipient: pass --to <address> (or reply to an email)");
  if (!reply && !opts.subject) fail("missing --subject (only a reply can borrow the original's subject)");

  const cfg = requireConfig("user");
  const args = { text };
  if (opts.to?.length) args.to = opts.to;
  if (opts.cc?.length) args.cc = opts.cc;
  if (opts.subject) args.subject = opts.subject;
  if (reply) args.in_reply_to = reply;
  if (opts.attach?.length) args.attachments = opts.attach.map(readAttachment);
  if (opts.forwardAttachment?.length) args.forward_attachment_ids = opts.forwardAttachment;

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("send_email", args);

  if (isJson()) {
    json(res);
    if (!res?.ok) process.exit(1);
    return;
  }
  // The service explains what an operator must fix; pass it through verbatim.
  if (!res?.ok) fail(res?.error || "unknown error", { code: res?.code, hint: res?.hint });

  const files = [
    ...(opts.attach || []).map((p) => basename(p)),
    ...(opts.forwardAttachment || []).map((id) => `(转发 ${id.slice(0, 8)}…)`),
  ];
  out(
    `已发送\n` +
    `收件人: ${(res.to || []).join(", ")}\n` +
    `主  题: ${res.subject || "(无)"}\n` +
    (files.length ? `附  件: ${files.join(", ")}\n` : "") +
    `通  道: ${res.provider || "?"}   Message-ID: ${res.message_id || "?"}`
  );
}
