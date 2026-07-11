#!/usr/bin/env node
// search-emails.mjs — full-text search over this mailbox (supports Chinese).
//
// Usage:
//   node search-emails.mjs "发票"
//   node search-emails.mjs "invoice" --limit 50 --json
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
  const a = { limit: 20, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--limit") a.limit = Math.max(1, Math.min(100, Number(argv[++i]) || 20));
    else if (v === "--json") a.json = true;
    else if (v === "--help" || v === "-h") { printHelp(); process.exit(0); }
    else if (!v.startsWith("--") && !a.query) a.query = v;
    else fail(`unknown argument: ${v}`);
  }
  if (!a.query) fail(`missing search query. Usage: node search-emails.mjs "<关键字>" [--limit N] [--json]`);
  return a;
}

function printHelp() {
  process.stdout.write(
    `search-emails.mjs — full-text search this mailbox\n\n` +
    `  node search-emails.mjs "<query>"              search, show up to 20 results\n` +
    `  node search-emails.mjs "<query>" --limit 50   cap results (1-100)\n` +
    `  node search-emails.mjs "<query>" --json       machine-readable output\n`
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

// ---- helpers ------------------------------------------------------------------

function fmtDate(ms) {
  if (!ms) return "(no date)";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "(no date)" : d.toISOString().replace("T", " ").slice(0, 16);
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

  const res = await client.callTool("search_emails", { query: opts.query, limit: opts.limit });
  const emails = res?.emails || [];

  if (opts.json) {
    process.stdout.write(JSON.stringify({ query: opts.query, count: emails.length, emails }, null, 2) + "\n");
    return;
  }

  if (!emails.length) {
    process.stdout.write(`没有找到匹配「${opts.query}」的邮件。\n`);
    return;
  }
  process.stdout.write(`找到 ${emails.length} 封匹配「${opts.query}」的邮件：\n\n`);
  for (const e of emails) {
    const clip = e.has_attachments ? " 📎" : "";
    process.stdout.write(
      `• [${fmtDate(e.date)}] ${e.subject || "(无主题)"}${clip}\n` +
      `  发件人: ${e.from_name ? e.from_name + " " : ""}<${e.from}>\n` +
      (e.snippet ? `  摘要: ${e.snippet}\n` : "") +
      `  id: ${e.id}\n\n`
    );
  }
  process.stdout.write(`提示: 用 get-email.mjs <id> 读全文。\n`);
}

main().catch((e) => fail(e.message || String(e)));
