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

export const replyHelp = `用法: cfmail reply <邮件id> --text <正文> [选项]

在原会话里回信。收件人、主题、会话线索（In-Reply-To / References）全部从原邮件
推导，所以对方看到的是同一串对话，多轮往返也不会断。

手工拼 --to 加 --subject "Re: ..." 做不到这一点，回信一律用这个命令。

参数:
  <邮件id>           必需。要回复哪封，从 unread / list / search 的输出里拿
  --text <正文>      正文。与 --text-file 二选一
  --text-file <路径> 从文件读正文
  --to <地址>        额外收件人。默认只回给原发件人
  --cc <地址>        抄送，可重复
  --subject <主题>   覆盖自动生成的 Re: 主题。原邮件没主题时必须给
  --attach <路径>    附上本地文件，可重复
  --forward-attachment <id>
                     转发已存附件，可重复
  --json             输出 JSON

示例:
  cfmail reply 57d74fd6 --text "收到，稍后处理"
  cfmail reply 57d74fd6 --text "见附件" --attach ./report.pdf
  cfmail reply 57d74fd6 --text "转给你" --forward-attachment ed0ee1cf

发一封新邮件见 cfmail send --help`;

export const help = `用法: cfmail send --to <收件人> --subject <主题> --text <正文> [选项]

发一封邮件。发件人恒为这把 Key 绑定的地址，服务端强制，改不了，所以你发不出
别人的地址。

收件人与主题:
  --to <地址>        收件人，可重复给多个。回信时可省略（从原邮件推导）
  --cc <地址>        抄送，可重复
  --subject <主题>   主题。回信时可省略（自动用 Re: 原主题）

正文（二选一，必需）:
  --text <正文>      直接给正文
  --text-file <路径> 从文件读正文。正文长、含多行或中文时更省事

附件（都可重复）:
  --attach <路径>            附上本地文件，MIME 类型按扩展名自动判断
  --forward-attachment <id>  转发已存附件，字节在服务端内部流转，不用先下载

回信:
  --reply <邮件id>   在原会话里回信。等价于 cfmail reply <邮件id>

其它:
  --json             输出 JSON，失败时也是 JSON 且退出码非 0

能发多大: 附件会被 base64 编码、体积涨三分之一，服务按编码后大小判断。走
Resend 约 29 MB，走 Cloudflare 约 3.6 MB，最多 32 个附件。超了会在发送前告诉你。

示例:
  cfmail send --to a@x.com --subject "标题" --text "正文"
  cfmail send --to a@x.com --cc b@x.com --subject 报表 --text 见附件 --attach ./q3.pdf
  cfmail send --to a@x.com --subject 长文 --text-file ./body.txt

正文或主题以 -- 开头时，用等号形式: --subject=--重要通知--`;

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
