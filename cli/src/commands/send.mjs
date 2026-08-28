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
  "--no-track": "bool",
};

export const replyHelp = `Usage: cfmail reply <email-id> --text <body> [options]

Reply within the original thread. Recipient, subject, and threading headers
(In-Reply-To / References) are all derived from the original email, so the
other side sees one continuous conversation even across many replies.

Hand-assembling --to plus --subject "Re: ..." can't do this — always use this
command to reply.

Options:
  <email-id>          Required. Which email to reply to, from the output of
                      unread / list / search
  --text <body>       Body text. Pick either this or --text-file
  --text-file <path>  Read the body from a file
  --to <address>      Extra recipient. Replies to the original sender by default
  --cc <address>      Cc, repeatable
  --subject <subject> Override the auto-generated "Re: " subject. Required if
                      the original had no subject
  --attach <path>     Attach a local file, repeatable
  --no-track          Skip the open-tracking pixel for this reply
  --forward-attachment <id>
                      Forward an already-stored attachment, repeatable
  --json              Print JSON

Examples:
  cfmail reply 57d74fd6 --text "Got it, will handle later"
  cfmail reply 57d74fd6 --text "See attached" --attach ./report.pdf
  cfmail reply 57d74fd6 --text "Forwarding to you" --forward-attachment ed0ee1cf

To send a brand-new email instead, see cfmail send --help`;

export const help = `Usage: cfmail send --to <recipient> --subject <subject> --text <body> [options]

Send an email. The sender is always the address this key is bound to — that's
enforced server-side and can't be changed, so you can't send from someone
else's address.

Recipient and subject:
  --to <address>      Recipient, repeat for more than one. Optional when
                      replying (derived from the original)
  --cc <address>      Cc, repeatable
  --subject <subject> Subject. Optional when replying (auto-prefixed with "Re: ")

Body (required, pick one):
  --text <body>       Give the body directly
  --text-file <path>  Read the body from a file — easier for long, multi-line,
                      or Chinese text

Attachments (both repeatable):
  --attach <path>            Attach a local file; MIME type is guessed from
                             the extension
  --forward-attachment <id>  Forward an already-stored attachment — the bytes
                             move server-side, no need to download it first

Replying:
  --reply <email-id>  Reply within the original thread. Equivalent to
                      cfmail reply <email-id>

Tracking:
  --no-track          Do not embed the open-tracking pixel in this message
                      (tracking is on by default when the service enables it;
                      see cfmail sent)

Other:
  --json              Print JSON; failures are JSON too, with a non-zero exit code

Size limits: attachments are base64-encoded, inflating them by a third, and
the service checks the encoded size. Roughly 29 MB over Resend, 3.6 MB over
Cloudflare, 32 attachments max either way. You're told before anything is
sent if you're over.

Examples:
  cfmail send --to a@x.com --subject "subject" --text "body"
  cfmail send --to a@x.com --cc b@x.com --subject "Report" --text "See attached" --attach ./q3.pdf
  cfmail send --to a@x.com --subject "Long text" --text-file ./body.txt

If the body or subject starts with --, use the = form: --subject=--Important notice--`;

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

// `cfmail reply <id>` is the same operation with the id given positionally,
// so both entry points share this one implementation.
export async function run(argv, { replyPositional = false } = {}) {
  const { opts, positional } = parseArgs(argv, SPEC);

  const allowed = replyPositional ? 1 : 0;
  if (positional.length > allowed) {
    fail(`unexpected argument: ${positional[allowed]}` +
      (replyPositional ? "" : "\n(recipients go in --to, the body in --text)"));
  }

  if (replyPositional && opts.reply) fail("--reply is implied by `cfmail reply <email-id>`; drop it");

  const reply = replyPositional ? positional[0] : opts.reply;
  if (replyPositional && !reply) fail("missing email id. Usage: cfmail reply <email-id> --text \"...\"");

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
  if (opts.noTrack) args.track = false;

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
