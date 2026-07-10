#!/usr/bin/env node
// setup.mjs — one-shot "set up the access point" for the email-inbox skill.
// Writes the connection config and immediately verifies it by hitting the
// service, so a green check means you're ready to fetch mail.
//
// Usage:
//   node setup.mjs --base https://mail.example.com --email you@example.com --key <你的Key>
//
// Writes to EMAIL_INBOX_CONFIG, else $XDG_CONFIG_HOME/email-inbox/config.json,
// else ~/.config/email-inbox/config.json. Re-running overwrites the connection
// fields. The unread cursor starts at 0, so the first `fetch-unread` returns
// your recent backlog (bounded by --limit) and later runs return only new mail.
// Use `fetch-unread.mjs --reset` if you'd rather mark the backlog as read.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function resolveConfigPath() {
  if (process.env.EMAIL_INBOX_CONFIG) return process.env.EMAIL_INBOX_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "email-inbox", "config.json");
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--base") a.base = argv[++i];
    else if (k === "--email") a.email = argv[++i];
    else if (k === "--key") a.key = argv[++i];
    else if (k === "--help" || k === "-h") {
      process.stdout.write("Usage: node setup.mjs --base <url> --email <addr> --key <你的Key>\n");
      process.exit(0);
    } else fail(`unknown argument: ${k}`);
  }
  return a;
}

// Minimal MCP handshake to confirm the key works (calls the `stats` tool).
async function verify(base, key) {
  const url = `${base}/mcp`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${key}`,
  };
  let sessionId = null;
  const post = async (payload) => {
    const h = { ...headers };
    if (sessionId) h["mcp-session-id"] = sessionId;
    const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(payload) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (res.status === 401) fail("authentication failed (401): the API key was rejected.");
    const text = await res.text();
    if (!res.ok) fail(`server returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^data:\s?(.*)$/);
        if (m && m[1].trim()) { try { return JSON.parse(m[1]); } catch { /* keep-alive */ } }
      }
      return null;
    }
    return text.trim() ? JSON.parse(text) : null;
  };

  await post({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "email-inbox-setup", version: "1.0.0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stats", arguments: {} } });
  if (r?.error) fail(`stats call failed: ${r.error.message || JSON.stringify(r.error)}`);
  const block = (r?.result?.content || []).find((c) => c.type === "text");
  return block ? JSON.parse(block.text) : {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = resolveConfigPath();

  // Fall back to existing config values so you can update one field at a time.
  let prev = {};
  if (existsSync(path)) { try { prev = JSON.parse(readFileSync(path, "utf8")); } catch { /* ignore */ } }

  const base = (args.base || prev.base || "").replace(/\/+$/, "");
  const email = args.email || prev.email || "";
  const key = args.key || prev.key || "";
  if (!base) fail("missing --base (the service URL, e.g. https://mail.example.com)");
  if (!key) fail("missing --key (your API key, e.g. 32位十六进制字符串)");

  process.stdout.write(`Verifying connection to ${base} ...\n`);
  const stats = await verify(base, key);

  mkdirSync(dirname(path), { recursive: true });
  // Cursor starts at 0: the first fetch treats the existing backlog as unread
  // (bounded by --limit), then advances so later runs return only new mail.
  // Preserve an existing cursor when only updating connection fields.
  const cursor = Number(prev.cursor) || 0;
  writeFileSync(path, JSON.stringify({ base, email, key, cursor }, null, 2) + "\n");

  process.stdout.write(
    `\n✅ Connected. Mailbox: ${email || "(scoped by key)"}\n` +
    `   Stored emails visible to this key: ${stats.total ?? "?"}` +
    (stats.with_attachments != null ? ` (with attachments: ${stats.with_attachments})` : "") + `\n` +
    `   Config saved to: ${path}\n\n` +
    `Now run:  node fetch-unread.mjs   to pull new mail.\n`
  );
}

main().catch((e) => fail(e.message || String(e)));
