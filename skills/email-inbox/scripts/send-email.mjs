#!/usr/bin/env node
// send-email.mjs — send a new email, or reply to a stored one, as the address
// this API key is bound to. The service refuses to send as anyone else.
//
// Usage:
//   node send-email.mjs --to a@x.com --subject "Hi" --text "body"
//   node send-email.mjs --reply <email_id> --text "sure, attached"
//   node send-email.mjs --to a@x.com --subject s --text b --attach ./invoice.pdf
//   node send-email.mjs --reply <id> --text b --forward-attachment <att_id>
//
// Env overrides (win over the config file): EMAIL_INBOX_BASE, EMAIL_INBOX_KEY,
// EMAIL_INBOX_CONFIG (path to the config file).

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";

function resolveConfigPath() {
  if (process.env.EMAIL_INBOX_CONFIG) return process.env.EMAIL_INBOX_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "email-inbox", "config.json");
}

function loadConfig(path) {
  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      fail(`config file is not valid JSON: ${path}\n${e.message}`);
    }
  }
  cfg.base = (process.env.EMAIL_INBOX_BASE || cfg.base || "").replace(/\/+$/, "");
  cfg.key = process.env.EMAIL_INBOX_KEY || cfg.key || "";
  return cfg;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

// Enough to give the recipient's mail client a sensible icon and preview.
const MIME = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html",
  ".pdf": "application/pdf", ".zip": "application/zip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function parseArgs(argv) {
  const a = { to: [], cc: [], attach: [], forward: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--to") a.to.push(argv[++i]);
    else if (v === "--cc") a.cc.push(argv[++i]);
    else if (v === "--subject") a.subject = argv[++i];
    else if (v === "--text") a.text = argv[++i];
    else if (v === "--text-file") a.textFile = argv[++i];
    else if (v === "--reply") a.reply = argv[++i];
    else if (v === "--attach") a.attach.push(argv[++i]);
    else if (v === "--forward-attachment") a.forward.push(argv[++i]);
    else if (v === "--json") a.json = true;
    else if (v === "--help" || v === "-h") { printHelp(); process.exit(0); }
    else fail(`unknown argument: ${v}`);
  }

  if (a.text != null && a.textFile) fail("use either --text or --text-file, not both");
  if (a.textFile) {
    if (!existsSync(a.textFile)) fail(`--text-file not found: ${a.textFile}`);
    a.text = readFileSync(a.textFile, "utf8");
  }
  if (a.text == null) fail("missing body: pass --text \"...\" or --text-file <path>");
  if (!a.reply && !a.to.length) fail("missing recipient: pass --to <address> (or --reply <email_id>)");
  if (!a.reply && !a.subject) fail("missing --subject (only a reply can borrow the original's subject)");
  return a;
}

function printHelp() {
  process.stdout.write(
    `send-email.mjs — send an email, or reply to a stored one\n\n` +
    `  node send-email.mjs --to a@x.com --subject "Hi" --text "body"\n` +
    `  node send-email.mjs --reply <email_id> --text "sure, attached"\n\n` +
    `Options:\n` +
    `  --to <addr>                 recipient; repeat for several\n` +
    `  --cc <addr>                 carbon copy; repeat for several\n` +
    `  --subject <text>            subject; optional with --reply\n` +
    `  --text <body>               plain-text body\n` +
    `  --text-file <path>          read the body from a file (for long or multi-line text)\n` +
    `  --reply <email_id>          reply in-thread; recipient and subject come from that email\n` +
    `  --attach <path>             attach a local file; repeat for several\n` +
    `  --forward-attachment <id>   attach a stored attachment without downloading it first\n` +
    `  --json                      machine-readable output\n`
  );
}

function readAttachment(path) {
  if (!existsSync(path)) fail(`--attach file not found: ${path}`);
  const st = statSync(path);
  if (st.isDirectory()) fail(`--attach is a directory, not a file: ${path}`);
  return {
    filename: basename(path),
    content_type: MIME[extname(path).toLowerCase()] || "application/octet-stream",
    content_base64: readFileSync(path).toString("base64"),
  };
}

// ---- MCP Streamable HTTP client (hand-rolled, no SDK) ------------------------

function parseRpcBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const msgs = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m && m[1].trim()) {
        try { msgs.push(JSON.parse(m[1])); } catch { /* skip keep-alive */ }
      }
    }
    return msgs;
  }
  const t = text.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return Array.isArray(parsed) ? parsed : [parsed];
}

class McpClient {
  constructor(base, key) {
    this.url = `${base}/mcp`;
    this.key = key;
    this.sessionId = null;
    this.id = 0;
  }

  async post(payload) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.key}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401) fail("authentication failed (401): check your API key.");
    const text = await res.text();
    if (!res.ok) fail(`server returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { msgs: parseRpcBody(res.headers.get("content-type") || "", text) };
  }

  async request(method, params) {
    const id = ++this.id;
    const { msgs } = await this.post({ jsonrpc: "2.0", id, method, params });
    const msg = msgs.find((m) => m.id === id) ?? msgs[0];
    if (!msg) fail(`no response to ${method}`);
    if (msg.error) fail(`${method} error: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async connect() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "email-inbox-skill", version: "1.0.0" },
    });
    await this.notify("notifications/initialized", {});
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const block = (result?.content || []).find((c) => c.type === "text");
    if (!block) return null;
    return JSON.parse(block.text);
  }
}

// ---- main --------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfgPath = resolveConfigPath();
  const cfg = loadConfig(cfgPath);

  if (!cfg.base) fail(`no service URL. Set "base" in ${cfgPath} or EMAIL_INBOX_BASE.`);
  if (!cfg.key) fail(`no API key. Set "key" in ${cfgPath} or EMAIL_INBOX_KEY.`);

  const args = { text: opts.text };
  if (opts.to.length) args.to = opts.to;
  if (opts.cc.length) args.cc = opts.cc;
  if (opts.subject) args.subject = opts.subject;
  if (opts.reply) args.in_reply_to = opts.reply;
  if (opts.attach.length) args.attachments = opts.attach.map(readAttachment);
  if (opts.forward.length) args.forward_attachment_ids = opts.forward;

  const client = new McpClient(cfg.base, cfg.key);
  await client.connect();
  const res = await client.callTool("send_email", args);

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    if (!res?.ok) process.exit(1);
    return;
  }

  if (!res?.ok) {
    // The service explains what the operator must fix; pass it through verbatim.
    process.stderr.write(`发送失败: ${res?.error || "unknown error"}\n`);
    if (res?.code) process.stderr.write(`错误码: ${res.code}\n`);
    if (res?.hint) process.stderr.write(`怎么办: ${res.hint}\n`);
    process.exit(1);
  }

  const files = [
    ...opts.attach.map((p) => basename(p)),
    ...opts.forward.map((id) => `(转发 ${id.slice(0, 8)}…)`),
  ];
  process.stdout.write(
    `已发送\n` +
    `收件人: ${(res.to || []).join(", ")}\n` +
    `主  题: ${res.subject || "(无)"}\n` +
    (files.length ? `附  件: ${files.join(", ")}\n` : "") +
    `通  道: ${res.provider || "?"}   Message-ID: ${res.message_id || "?"}\n`
  );
}

main().catch((e) => fail(e.message || String(e)));
