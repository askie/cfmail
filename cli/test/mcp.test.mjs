import { test, expect, vi, afterEach } from "vitest";
import { Mcp } from "../src/mcp.mjs";

// A Response body can only be read once, so build a fresh one per call.
function respond(body, { contentType = "application/json", status = 200, sid = "s1" } = {}) {
  return vi.fn().mockImplementation(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType, "mcp-session-id": sid },
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

test("reads a plain JSON reply", async () => {
  vi.stubGlobal("fetch", respond({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }));
  await expect(new Mcp("https://h", "k").request("ping", {})).resolves.toEqual({ ok: 1 });
});

test("reads a reply delivered as server-sent events", async () => {
  const sse = `: keep-alive\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 2 } })}\n\n`;
  vi.stubGlobal("fetch", respond(sse, { contentType: "text/event-stream" }));
  await expect(new Mcp("https://h", "k").request("ping", {})).resolves.toEqual({ ok: 2 });
});

test("carries the session id returned by the first call", async () => {
  const f = respond({ jsonrpc: "2.0", id: 1, result: {} }, { sid: "sess-9" });
  vi.stubGlobal("fetch", f);
  const mcp = new Mcp("https://h", "k");
  await mcp.request("a", {});
  await mcp.request("b", {});
  expect(f.mock.calls[1][1].headers["mcp-session-id"]).toBe("sess-9");
});

test("a tool result's text block is parsed as JSON", async () => {
  vi.stubGlobal("fetch", respond({
    jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ total: 3 }) }] },
  }));
  await expect(new Mcp("https://h", "k").call("stats")).resolves.toEqual({ total: 3 });
});

test("a non-JSON text block comes back as the raw string", async () => {
  vi.stubGlobal("fetch", respond({
    jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain" }] },
  }));
  await expect(new Mcp("https://h", "k").call("stats")).resolves.toBe("plain");
});

test("401 is reported as an authentication failure", async () => {
  vi.stubGlobal("fetch", respond("nope", { status: 401 }));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(new Mcp("https://h", "k").request("ping", {})).rejects.toThrow("EXIT");
  expect(err.mock.calls.map((c) => c[0]).join("")).toMatch(/authentication failed \(401\)/);

  exit.mockRestore();
  err.mockRestore();
});

test("a JSON-RPC error is surfaced with its message", async () => {
  vi.stubGlobal("fetch", respond({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(new Mcp("https://h", "k").request("ping", {})).rejects.toThrow("EXIT");
  expect(err.mock.calls.map((c) => c[0]).join("")).toMatch(/ping: boom/);

  exit.mockRestore();
  err.mockRestore();
});
