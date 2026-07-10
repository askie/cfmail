#!/usr/bin/env node
// fetch-unread.mjs — pull the latest *unread* emails from a cloudflare-email
// service over its MCP (Streamable HTTP) endpoint.
//
// Zero dependencies: uses only Node's built-in fetch (Node 18+). It speaks the
// MCP JSON-RPC handshake by hand so the skill works in any agent without
// installing the MCP SDK.
//
// "Unread" is tracked on THIS machine: a local cursor remembers the timestamp
// of the newest email already seen. Each run returns only emails newer than the
// cursor, then advances it. The server has no read/unread flag — read state is
// per-client and lives in the config file.
//
// Config & cursor live in one JSON file (see resolveConfigPath):
//   { "base": "https://mail.example.com", "email": "you@example.com",
//     "key": "<你的Key>", "cursor": 0 }
//
// Usage:
//   node fetch-unread.mjs                # list new unread, advance cursor
//   node fetch-unread.mjs --peek         # list new unread, do NOT advance cursor
//   node fetch-unread.mjs --all          # ignore cursor, list latest (default 20)
//   node fetch-unread.mjs --limit 50     # cap how many to scan/return
//   node fetch-unread.mjs --reset        # set cursor to "now" (mark all read)
//   node fetch-unread.mjs --json         # machine-readable output
//
// Env overrides (win over the config file): EMAIL_INBOX_BASE, EMAIL_INBOX_EMAIL,
// EMAIL_INBOX_KEY, EMAIL_INBOX_CONFIG (path to the config file).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---- config -----------------------------------------------------------------

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
  cfg.email = process.env.EMAIL_INBOX_EMAIL || cfg.email || "";
  cfg.key = process.env.EMAIL_INBOX_KEY || cfg.key || "";
  cfg.cursor = Number(cfg.cursor) || 0;
  return cfg;
}

function saveCursor(path, cfg, cursor) {
  cfg.cursor = cursor;
  mkdirSync(dirname(path), { recursive: true });
  // Persist only the user-owned fields; never widen the file shape.
  const out = { base: cfg.base, email: cfg.email, key: cfg.key, cursor };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
}

// ---- MCP Streamable HTTP client (hand-rolled, no SDK) ------------------------

// The endpoint may answer a POST with either application/json or an SSE stream
// (text/event-stream). Parse both; return the first JSON-RPC message that has
// our request id (or the lone message for notifications).
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
    return { msgs: parseRpcBody(res.headers.get("content-type") || "", text), isNotification: !("id" in payload) };
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

// ---- helpers -----------------------------------------------------------------

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { advance: true, all: false, limit: 20, json: false, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--peek") a.advance = false;
    else if (v === "--all") a.all = true;
    else if (v === "--reset") a.reset = true;
    else if (v === "--json") a.json = true;
    else if (v === "--limit") a.limit = Math.max(1, Math.min(100, Number(argv[++i]) || 20));
    else if (v === "--help" || v === "-h") { printHelp(); process.exit(0); }
    else fail(`unknown argument: ${v}`);
  }
  return a;
}

function printHelp() {
  process.stdout.write(
    `fetch-unread.mjs — pull latest unread emails from a cloudflare-email service\n\n` +
    `  (no args)     list new unread emails and mark them read (advance cursor)\n` +
    `  --peek        list new unread without marking read\n` +
    `  --all         ignore read state, show latest emails\n` +
    `  --limit N     cap results (1-100, default 20)\n` +
    `  --reset       mark everything as read (cursor = now)\n` +
    `  --json        machine-readable output\n`
  );
}

function fmtDate(ms) {
  if (!ms) return "(no date)";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "(no date)" : d.toISOString().replace("T", " ").slice(0, 16);
}

function renderHuman(emails, mailbox) {
  if (!emails.length) {
    process.stdout.write(`没有新的未读邮件（${mailbox}）。\n`);
    return;
  }
  process.stdout.write(`${emails.length} 封未读邮件（${mailbox}）：\n\n`);
  for (const e of emails) {
    const clip = e.attachment ? " 📎" : "";
    process.stdout.write(
      `• [${fmtDate(e.date)}] ${e.subject || "(无主题)"}${clip}\n` +
      `  发件人: ${e.from_name ? e.from_name + " " : ""}<${e.from}>\n` +
      (e.snippet ? `  摘要: ${e.snippet}\n` : "") +
      `  id: ${e.id}\n\n`
    );
  }
  process.stdout.write(`提示: 用 get_email(id) 读全文，get_attachment 取附件。\n`);
}

// ---- main --------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfgPath = resolveConfigPath();
  const cfg = loadConfig(cfgPath);

  if (!cfg.base) fail(`no service URL. Set "base" in ${cfgPath} or EMAIL_INBOX_BASE.`);
  if (!cfg.key) fail(`no API key. Set "key" in ${cfgPath} or EMAIL_INBOX_KEY.`);

  const client = new McpClient(cfg.base, cfg.key);
  await client.connect();

  // list_emails returns newest-first; the key scopes the mailbox server-side.
  const res = await client.callTool("list_emails", { limit: opts.all ? opts.limit : 100 });
  const all = (res?.emails || []).map((e) => ({
    id: e.id, from: e.from, from_name: e.from_name, subject: e.subject,
    date: e.date, snippet: e.snippet, attachment: e.has_attachments,
  }));

  if (opts.reset) {
    const newest = all.length ? Math.max(...all.map((e) => e.date || 0)) : Date.now();
    saveCursor(cfgPath, cfg, newest);
    process.stdout.write(`已将全部邮件标记为已读（cursor=${newest}）。\n`);
    return;
  }

  let emails = all;
  if (!opts.all) emails = all.filter((e) => (e.date || 0) > cfg.cursor);
  emails.sort((a, b) => (a.date || 0) - (b.date || 0)); // oldest-first for reading
  if (emails.length > opts.limit) emails = emails.slice(-opts.limit);

  const mailbox = cfg.email || "your mailbox";
  if (opts.json) {
    process.stdout.write(JSON.stringify({ mailbox, count: emails.length, emails }, null, 2) + "\n");
  } else {
    renderHuman(emails, mailbox);
  }

  if (opts.advance && !opts.all && emails.length) {
    const newest = Math.max(cfg.cursor, ...emails.map((e) => e.date || 0));
    saveCursor(cfgPath, cfg, newest);
  }
}

main().catch((e) => fail(e.message || String(e)));
