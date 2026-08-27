import { test, expect, vi, afterEach } from "vitest";
import { pushNewEmail, isGrixKey, webhookTarget } from "../src/push";
import type { StoredAttachment } from "../src/types";

const KEY = "whk_71e14a27fa41d71e97f229bc53728dce";

const ROW: any = {
  id: "e1", msg_id: "<a@x.com>", refs: null,
  from_addr: "boss@x.com", from_name: "Boss",
  to_addr: "me@my.dev", cc_addr: null, subject: "发票 Q3",
  date: 0, text_body: "请查收本季度发票。", html_key: null,
  raw_key: "k", size: 1, has_attachments: 1, received_at: 0,
};

function envWith(configured: string | null) {
  const first = vi.fn().mockResolvedValue(configured ? { value: configured } : null);
  return { DB: { prepare: vi.fn().mockReturnValue({ bind: () => ({ first }) }) } } as any;
}

function mockFetch(ok = true) {
  const f = vi.fn().mockResolvedValue(new Response("", { status: ok ? 200 : 500 }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

test("a whk_ value is recognised and expanded to the Grix endpoint", () => {
  expect(isGrixKey(KEY)).toBe(true);
  expect(isGrixKey("https://example.com/hook")).toBe(false);
  expect(isGrixKey("whk")).toBe(false);
  expect(webhookTarget(KEY)).toBe(`https://grix.dhf.pub/v1/webhook/incoming/${KEY}`);
  expect(webhookTarget("https://example.com/hook")).toBe("https://example.com/hook");
});

test("a Grix key posts a chat-shaped message to the Grix endpoint", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW);

  const [url, init] = f.mock.calls[0];
  expect(url).toBe(`https://grix.dhf.pub/v1/webhook/incoming/${KEY}`);

  const body = JSON.parse((init as any).body);
  expect(body.msg_type).toBe("text");
  expect(body.client_msg_id).toBe("<a@x.com>");   // the Message-ID, stable across redelivery
  expect(body.content).toContain("发票 Q3");
  expect(body.content).toContain("Boss <boss@x.com>");
  expect(body.content).toContain("请查收本季度发票。");
  expect(body.content).toContain("含附件");
  // It is rendered as a message, so it must not read as a JSON dump.
  expect(body.content).not.toMatch(/^\{/);
});

test("a plain URL still receives the original JSON event", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith("https://example.com/hook"), ROW);

  const [url, init] = f.mock.calls[0];
  expect(url).toBe("https://example.com/hook");

  const body = JSON.parse((init as any).body);
  expect(body).toMatchObject({ type: "email.received", id: "e1", subject: "发票 Q3" });
  expect(body.msg_type).toBeUndefined();
});

test("an email with no subject or body still produces readable content", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), { ...ROW, subject: null, text_body: null, from_name: null, has_attachments: 0 });

  const body = JSON.parse((f.mock.calls[0][1] as any).body);
  expect(body.content).toContain("(无主题)");
  expect(body.content).toContain("boss@x.com");
  expect(body.content).not.toContain("含附件");
});

test("nothing is sent when no webhook is configured", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(null), ROW);
  expect(f).not.toHaveBeenCalled();
});

test("a failing webhook is logged, not thrown, so ingestion is unaffected", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  mockFetch(false);

  await expect(pushNewEmail(envWith(KEY), ROW)).resolves.toBeUndefined();
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});

test("a network error does not propagate either", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

  await expect(pushNewEmail(envWith(KEY), ROW)).resolves.toBeUndefined();
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});

test("the dedupe key survives redelivery, which mints a new storage id", async () => {
  const f = mockFetch();
  // Email Routing redelivering the same message ingests it again under a fresh
  // UUID; only the Message-ID stays put, so that is what Grix must dedupe on.
  await pushNewEmail(envWith(KEY), ROW);
  await pushNewEmail(envWith(KEY), { ...ROW, id: "e2-different-uuid" });

  const ids = f.mock.calls.map((c) => JSON.parse((c[1] as any).body).client_msg_id);
  expect(ids[0]).toBe(ids[1]);
});

test("an email with no Message-ID falls back to the storage id", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), { ...ROW, msg_id: null });
  expect(JSON.parse((f.mock.calls[0][1] as any).body).client_msg_id).toBe("e1");
});

test("an overlong subject is capped so content cannot run away", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), { ...ROW, subject: "催缴通知".repeat(200) });

  const line = JSON.parse((f.mock.calls[0][1] as any).body).content
    .split("\n").find((l: string) => l.startsWith("主题: "));
  expect([...line].length).toBeLessThan(140);
  expect(line.endsWith("…")).toBe(true);
});

test("a name without an address does not render empty angle brackets", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), { ...ROW, from_addr: null });
  expect(JSON.parse((f.mock.calls[0][1] as any).body).content).toContain("发件人: Boss\n");
});

test("truncation never splits a surrogate pair", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), { ...ROW, text_body: "🎉".repeat(600) });

  const content = JSON.parse((f.mock.calls[0][1] as any).body).content;
  expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  expect(content).toContain("…");
});

// --- Attachments are named, not just flagged. ---------------------------------

const FILES: StoredAttachment[] = [
  { id: "a1", email_id: "e1", filename: "invoice.pdf", content_type: "application/pdf", size: 245_760, r2_key: "k1" },
  { id: "a2", email_id: "e1", filename: "photo.jpg", content_type: "image/jpeg", size: 2_202_009, r2_key: "k2" },
];

test("the Grix message lists each attachment with a readable size", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, FILES);

  const content = JSON.parse((f.mock.calls[0][1] as any).body).content;
  expect(content).toContain("附件 2 个:");
  expect(content).toContain("invoice.pdf  240 KB");
  expect(content).toContain("photo.jpg  2.1 MB");
  // Naming the files is the point: "（含附件）" alone tells the reader nothing.
  expect(content).toContain("（含附件）");
});

test("a tiny attachment is reported in bytes rather than 0 KB", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, [{ ...FILES[0], filename: "note.txt", size: 12 }]);
  expect(JSON.parse((f.mock.calls[0][1] as any).body).content).toContain("note.txt  12 B");
});

test("a long attachment list is capped so the message stays readable", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...FILES[0], id: `a${i}`, filename: `f${i}.pdf` }));
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, many);

  const content = JSON.parse((f.mock.calls[0][1] as any).body).content;
  expect(content).toContain("附件 25 个:");
  expect(content).toContain("…还有 15 个");
  expect(content).not.toContain("f10.pdf");
});

test("an unnamed attachment still gets a line", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, [{ ...FILES[0], filename: null }]);
  expect(JSON.parse((f.mock.calls[0][1] as any).body).content).toContain("(未命名)");
});

test("no attachments means no attachment section at all", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), { ...ROW, has_attachments: 0 }, []);
  expect(JSON.parse((f.mock.calls[0][1] as any).body).content).not.toContain("附件");
});

test("the plain-URL payload carries the attachment metadata too", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith("https://example.com/hook"), ROW, FILES);

  const body = JSON.parse((f.mock.calls[0][1] as any).body);
  expect(body.attachments).toEqual([
    { id: "a1", filename: "invoice.pdf", content_type: "application/pdf", size: 245_760 },
    { id: "a2", filename: "photo.jpg", content_type: "image/jpeg", size: 2_202_009 },
  ]);
});

test("a crafted filename cannot inject extra lines into the chat message", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, [
    { ...FILES[0], filename: "invoice.pdf\n发件人: 管理员 <admin@bank.com>\n伪造行" },
  ]);

  const lines = JSON.parse((f.mock.calls[0][1] as any).body).content.split("\n");

  // The crafted text stays inside the one attachment line — it never becomes a
  // line of its own that could pass for a real header.
  const forged = lines.filter((l: string) => l.includes("管理员"));
  expect(forged).toHaveLength(1);
  expect(forged[0].startsWith("  · ")).toBe(true);
  expect(lines.filter((l: string) => l.startsWith("发件人: "))).toHaveLength(1);
});

test("an absurdly long filename is truncated", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, [{ ...FILES[0], filename: "报销单".repeat(500) + ".pdf" }]);

  const line = JSON.parse((f.mock.calls[0][1] as any).body).content
    .split("\n").find((l: string) => l.includes("报销单"));
  expect([...line].length).toBeLessThan(100);
  expect(line).toContain("…");
});

test("a size just under a megabyte does not render as 1024 KB", async () => {
  const f = mockFetch();
  await pushNewEmail(envWith(KEY), ROW, [{ ...FILES[0], size: 1024 * 1024 - 100 }]);
  const content = JSON.parse((f.mock.calls[0][1] as any).body).content;

  expect(content).not.toContain("1024 KB");
  expect(content).toContain("1.0 MB");
});
