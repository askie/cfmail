import { test, expect, vi, beforeEach } from "vitest";
import {
  injectPixel, textToHtml, pixelUrl, handleOpen, recordSent, listSent, sentStats,
  _resetSentTableCacheForTests,
} from "../src/track";

function dbSpy() {
  const calls: { sql: string; args: any[] }[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          run: async () => { calls.push({ sql, args }); return {}; },
          first: async () => { calls.push({ sql, args }); return { total: 4, tracked: 3, opened: 2, opens: 5 }; },
          all: async () => { calls.push({ sql, args }); return { results: [] }; },
        }),
        run: async () => { calls.push({ sql, args: [] }); return {}; },
      }),
    },
  } as any;
  return { env, calls };
}

beforeEach(() => _resetSentTableCacheForTests());

test("the pixel lands just before </body>, or at the end when there is none", () => {
  const url = "https://m.example.com/o/abc.gif";
  expect(injectPixel("<html><body><p>hi</p></body></html>", url))
    .toBe(`<html><body><p>hi</p><img src="${url}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0"></body></html>`);
  expect(injectPixel("<p>hi</p>", url)).toMatch(/^<p>hi<\/p><img src=/);
  expect(injectPixel("<p>x</p></BODY >", url)).toMatch(/<img [^>]+><\/BODY >$/);
});

test("a text body becomes escaped, line-preserving HTML", () => {
  const html = textToHtml("a < b & \"c\"\nline2");
  expect(html).toContain("a &lt; b &amp; &quot;c&quot;\nline2");
  expect(html).toContain("white-space:pre-wrap");
});

test("pixelUrl tolerates a trailing slash on the base", () => {
  expect(pixelUrl("https://m.example.com/", "0123456789abcdef0123456789abcdef"))
    .toBe("https://m.example.com/o/0123456789abcdef0123456789abcdef.gif");
});

test("GET /o/<id>.gif serves a GIF, never caches, and bumps the counters in the background", async () => {
  const { env, calls } = dbSpy();
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any;
  const id = "0123456789abcdef0123456789abcdef";

  const res = handleOpen(new Request(`https://m.example.com/o/${id}.gif`), env, ctx);
  expect(res).not.toBeNull();
  expect(res!.headers.get("content-type")).toBe("image/gif");
  expect(res!.headers.get("cache-control")).toContain("no-store");
  expect((await res!.arrayBuffer()).byteLength).toBe(43);

  await Promise.all(waits);
  const update = calls.find((c) => c.sql.includes("UPDATE sent"));
  expect(update).toBeDefined();
  expect(update!.args[2]).toBe(id);
  expect(update!.sql).toContain("open_count = open_count + 1");
});

test("paths that are not a tracking URL are left to other handlers", () => {
  const { env } = dbSpy();
  const ctx = { waitUntil: vi.fn() } as any;
  expect(handleOpen(new Request("https://m.example.com/o/not-hex.gif"), env, ctx)).toBeNull();
  expect(handleOpen(new Request("https://m.example.com/health"), env, ctx)).toBeNull();
  expect(ctx.waitUntil).not.toHaveBeenCalled();
});

test("recordSent creates the table on first use and stores a lowercased sender", async () => {
  const { env, calls } = dbSpy();
  await recordSent(env, {
    id: "x", provider: "resend", provider_id: "r1", from_addr: "KF@grix.im",
    to_addr: ["a@x.com", "b@x.com"], cc_addr: [], subject: "s", tracked: true,
  });
  expect(calls[0].sql).toContain("CREATE TABLE IF NOT EXISTS sent");
  const ins = calls.find((c) => c.sql.includes("INSERT INTO sent"))!;
  expect(ins.args.slice(0, 6)).toEqual(["x", "resend", "r1", "kf@grix.im", "a@x.com, b@x.com", null]);
  expect(ins.args[8]).toBe(1);
});

test("a mailbox key is pinned to its own address even when it asks for another", async () => {
  const { env, calls } = dbSpy();
  await listSent(env, { from: "other@x.com", limit: 5 }, "me@x.com");
  const q = calls.find((c) => c.sql.includes("FROM sent"))!;
  expect(q.sql).toContain("from_addr = ?");
  expect(q.args[0]).toBe("me@x.com");
});

test("sentStats reports the open rate over tracked mail only", async () => {
  const { env } = dbSpy();
  expect(await sentStats(env, {})).toEqual({ total: 4, tracked: 3, opened: 2, opens: 5, open_rate: 66.7 });
});
