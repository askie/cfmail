// Minimal MCP client over Streamable HTTP. The service speaks JSON-RPC and may
// answer as SSE, so both shapes are parsed. No SDK: this keeps the CLI
// dependency-free and installable with a single `npm i -g`.

import { fail } from "./output.mjs";

function parseBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const msgs = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m && m[1].trim()) {
        try { msgs.push(JSON.parse(m[1])); } catch { /* keep-alive */ }
      }
    }
    return msgs;
  }
  const t = text.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class Mcp {
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

    let res;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (e) {
      fail(`cannot reach ${this.url}: ${e.message}`);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401) fail("authentication failed (401): check your API key");
    const text = await res.text();
    if (!res.ok) fail(`server returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    return parseBody(res.headers.get("content-type") || "", text);
  }

  async request(method, params) {
    const id = ++this.id;
    const msgs = await this.post({ jsonrpc: "2.0", id, method, params });
    const msg = msgs.find((m) => m.id === id) ?? msgs[0];
    if (!msg) fail(`no response to ${method}`);
    if (msg.error) fail(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async connect() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cfmail", version: "1.0.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return this;
  }

  async call(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const block = (result?.content || []).find((c) => c.type === "text");
    if (!block) return null;
    try { return JSON.parse(block.text); } catch { return block.text; }
  }

  async toolNames() {
    const r = await this.request("tools/list", {});
    return (r?.tools ?? []).map((t) => t.name);
  }
}
