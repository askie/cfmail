#!/usr/bin/env node
// get-email.mjs — read one email's full body (and attachment list) by id.
//
// fetch-unread.mjs only returns a snippet; this script calls the service's
// `get_email` MCP tool directly so the skill stays usable even when the
// agent hasn't registered the cloudflare-email service as an MCP server.
//
// Usage:
//   node get-email.mjs <id>            # plain text body (if any)
//   node get-email.mjs <id> --html     # also fetch the HTML body
//   node get-email.mjs <id> --json     # machine-readable output
//
// Env overrides (win over the config file): EMAIL_INBOX_BASE, EMAIL_INBOX_KEY,
// EMAIL_INBOX_CONFIG (path to the config file).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function parseArgs(argv) {
  const a = { html: false, json: false };
  for (const v of argv) {
    if (v === "--html") a.html = true;
    else if (v === "--json") a.json = true;
    else if (v === "--help" || v === "-h") { printHelp(); process.exit(0); }
    else if (!v.startsWith("--") && !a.id) a.id = v;
    else fail(`unknown argument: ${v}`);
  }
  if (!a.id) fail("missing email id. Usage: node get-email.mjs <id> [--html] [--json]");
  return a;
}

function printHelp() {
  process.stdout.write(
    `get-email.mjs — read one email's full body by id\n\n` +
    `  node get-email.mjs <id>          plain text body\n` +
    `  node get-email.mjs <id> --html   also fetch the HTML body\n` +
    `  node get-email.mjs <id> --json   machine-readable output\n`
  );
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

  const client = new McpClient(cfg.base, cfg.key);
  await client.connect();

  const args = { id: opts.id };
  if (opts.html) args.include_html = true;
  const email = await client.callTool("get_email", args);
  if (!email) fail(`email not found: ${opts.id}`);

  if (opts.json) {
    process.stdout.write(JSON.stringify(email, null, 2) + "\n");
    return;
  }

  const d = email.date ? new Date(email.date).toISOString() : "(no date)";
  process.stdout.write(
    `主题: ${email.subject || "(无主题)"}\n` +
    `发件人: ${email.from_name ? email.from_name + " " : ""}<${email.from}>\n` +
    `时间: ${d}\n\n`
  );
  if (email.text) process.stdout.write(`${email.text}\n`);
  else if (!opts.html) process.stdout.write(`(纯文本正文为空，加 --html 试试 HTML 正文)\n`);
  if (opts.html && email.html) process.stdout.write(`\n--- HTML ---\n${email.html}\n`);
  const atts = email.attachments || [];
  if (atts.length) {
    process.stdout.write(`\n附件 (${atts.length}):\n`);
    for (const a of atts) process.stdout.write(`  - ${a.filename || a.id} (id: ${a.id})\n`);
    process.stdout.write(`\n用 get-attachment.mjs <attachment_id> --out <保存路径> 下载。\n`);
  }
}

main().catch((e) => fail(e.message || String(e)));
