#!/usr/bin/env node
// get-attachment.mjs — download one attachment (by id) to a local file.
//
// Usage:
//   node get-attachment.mjs <attachment_id> --out ./invoice.pdf
//
// Env overrides (win over the config file): EMAIL_INBOX_BASE, EMAIL_INBOX_KEY,
// EMAIL_INBOX_CONFIG (path to the config file).

import { readFileSync, existsSync, writeFileSync } from "node:fs";
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
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--out") a.out = argv[++i];
    else if (v === "--help" || v === "-h") { printHelp(); process.exit(0); }
    else if (!v.startsWith("--") && !a.id) a.id = v;
    else fail(`unknown argument: ${v}`);
  }
  if (!a.id) fail("missing attachment id. Usage: node get-attachment.mjs <attachment_id> --out <path>");
  if (!a.out) fail("missing --out <path> to save the attachment to");
  return a;
}

function printHelp() {
  process.stdout.write(
    `get-attachment.mjs — download one attachment by id\n\n` +
    `  node get-attachment.mjs <attachment_id> --out ./file.pdf\n`
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

  const res = await client.callTool("get_attachment", { attachment_id: opts.id });
  if (!res || res.error) fail(`attachment not found: ${opts.id}${res?.error ? ` (${res.error})` : ""}`);
  if (!res.content_base64) fail(`attachment has no content: ${opts.id}`);

  writeFileSync(opts.out, Buffer.from(res.content_base64, "base64"));
  const meta = res.meta || {};
  process.stdout.write(
    `已保存: ${opts.out}\n` +
    `文件名: ${meta.filename || "(未知)"}  类型: ${meta.content_type || "(未知)"}  大小: ${meta.size ?? "?"} 字节\n`
  );
}

main().catch((e) => fail(e.message || String(e)));
