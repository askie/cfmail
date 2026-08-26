import { test, expect, vi, afterEach } from "vitest";
import { sendEmail, resolveSender } from "../src/send";

const KEY = "re_test_key";

function envWith(opts: { resend?: boolean; cf?: any; row?: any; dbThrows?: boolean } = {}) {
  const first = opts.dbThrows
    ? vi.fn().mockRejectedValue(new Error("D1 down"))
    : vi.fn().mockResolvedValue(opts.row ?? null);
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ first, all });
  return {
    ...(opts.resend ? { RESEND_API_KEY: KEY } : {}),
    ...(opts.cf ? { EMAIL: { send: opts.cf } } : {}),
    DB: { prepare: vi.fn().mockReturnValue({ bind }) },
    BUCKET: {},
  } as any;
}

function mockFetch(status: number, body: unknown) {
  const f = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", f);
  return f;
}

const inboundRow = (over: Record<string, unknown> = {}) => ({
  id: "e1", msg_id: "<orig@x.com>", refs: null, from_addr: "boss@x.com", to_addr: "me@my.dev",
  cc_addr: null, subject: "Report", date: 0, received_at: 0, text_body: null,
  html_key: null, has_attachments: 0, ...over,
});

afterEach(() => vi.unstubAllGlobals());

// --- Sender resolution: the anti-spoofing rule. -------------------------------

test("a bound address always wins over a caller-supplied from", () => {
  expect(resolveSender("me@my.dev", "ceo@bank.com")).toBe("me@my.dev");
});

test("the admin identity falls back to the supplied from, and is rejected without one", () => {
  expect(resolveSender(undefined, "admin@my.dev")).toBe("admin@my.dev");
  expect(resolveSender(undefined, "   ")).toBeNull();
  expect(resolveSender(undefined, undefined)).toBeNull();
});

// --- Resend is the default backend. -------------------------------------------

test("sends via Resend when a key is configured, using the given from", async () => {
  const f = mockFetch(200, { id: "re-1" });
  const r = await sendEmail(envWith({ resend: true }), "me@my.dev", {
    to: ["a@x.com"], subject: "Hi", text: "body",
  });

  expect(r.ok).toBe(true);
  expect(r.provider).toBe("resend");
  expect(r.message_id).toBe("re-1");

  const [url, init] = f.mock.calls[0];
  expect(url).toBe("https://api.resend.com/emails");
  expect((init as any).headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(JSON.parse((init as any).body)).toMatchObject({
    from: "me@my.dev", to: ["a@x.com"], subject: "Hi", text: "body",
  });
});

test("a Resend error name is surfaced with an actionable hint", async () => {
  mockFetch(403, { name: "validation_error", message: "The my.dev domain is not verified." });
  const r = await sendEmail(envWith({ resend: true }), "me@my.dev", {
    to: ["a@x.com"], subject: "s", text: "b",
  });

  expect(r.ok).toBe(false);
  expect(r.code).toBe("validation_error");
  expect(r.hint).toMatch(/not verified/);
});

test("a non-JSON error response degrades to the HTTP status", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }))
  );
  const r = await sendEmail(envWith({ resend: true }), "me@my.dev", {
    to: ["a@x.com"], subject: "s", text: "b",
  });

  expect(r.ok).toBe(false);
  expect(r.error).toBe("HTTP 502");
  expect(r.hint).toBeUndefined();
});

test("a network failure is reported instead of throwing", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
  const r = await sendEmail(envWith({ resend: true }), "me@my.dev", {
    to: ["a@x.com"], subject: "s", text: "b",
  });

  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/ECONNRESET/);
});

// --- Cloudflare stays available as the fallback. ------------------------------

test("falls back to the Cloudflare binding when no Resend key is set", async () => {
  const cf = vi.fn().mockResolvedValue({ messageId: "cf-1" });
  const r = await sendEmail(envWith({ cf }), "me@my.dev", { to: ["a@x.com"], subject: "Hi", text: "b" });

  expect(r.ok).toBe(true);
  expect(r.provider).toBe("cloudflare");
  expect(r.message_id).toBe("cf-1");
  expect(cf).toHaveBeenCalledWith(expect.objectContaining({ from: "me@my.dev", to: ["a@x.com"] }));
});

test("Resend takes precedence when both backends are configured", async () => {
  const cf = vi.fn();
  mockFetch(200, { id: "re-2" });
  const r = await sendEmail(envWith({ resend: true, cf }), "me@my.dev", {
    to: ["a@x.com"], subject: "s", text: "b",
  });

  expect(r.provider).toBe("resend");
  expect(cf).not.toHaveBeenCalled();
});

test("a Cloudflare error code is surfaced with an actionable hint", async () => {
  const cf = vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { code: "E_RECIPIENT_NOT_ALLOWED" }));
  const r = await sendEmail(envWith({ cf }), "me@my.dev", { to: ["a@x.com"], subject: "s", text: "b" });

  expect(r.code).toBe("E_RECIPIENT_NOT_ALLOWED");
  expect(r.hint).toMatch(/verified destination address/);
});

test("with no backend configured the caller is told how to configure one", async () => {
  const r = await sendEmail(envWith(), "me@my.dev", { to: ["a@x.com"], subject: "s", text: "b" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/no sending backend/);
  expect(r.hint).toMatch(/RESEND_API_KEY/);
});

// --- Replies. -----------------------------------------------------------------

test("reply derives recipient, subject and threading headers from the source email", async () => {
  const f = mockFetch(200, { id: "re-3" });
  const env = envWith({ resend: true, row: inboundRow() });

  const r = await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");

  expect(r.ok).toBe(true);
  expect(JSON.parse((f.mock.calls[0][1] as any).body)).toMatchObject({
    to: ["boss@x.com"],
    subject: "Re: Report",
    headers: { "In-Reply-To": "<orig@x.com>", References: "<orig@x.com>" },
  });
});

async function replyHeaders(row: Record<string, unknown>) {
  const f = mockFetch(200, { id: "re-x" });
  const env = envWith({ resend: true, row: inboundRow(row) });
  await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");
  return JSON.parse((f.mock.calls[0][1] as any).body).headers ?? {};
}

test("References continues the parent's chain, ending with the parent's Message-ID", async () => {
  const h = await replyHeaders({ refs: "<root@x.com> <mid@x.com>" });

  expect(h["References"]).toBe("<root@x.com> <mid@x.com> <orig@x.com>");
  expect(h["In-Reply-To"]).toBe("<orig@x.com>");
});

test("a Message-ID already present in the parent's chain is not repeated", async () => {
  const h = await replyHeaders({ refs: "<root@x.com> <orig@x.com>" });
  expect(h["References"]).toBe("<root@x.com> <orig@x.com>");
});

test("a long chain keeps the thread root and the most recent ancestors", async () => {
  const chain = Array.from({ length: 40 }, (_, i) => `<a${i}@x.com>`);
  const h = await replyHeaders({ refs: chain.join(" ") });
  const kept = h["References"].split(" ");

  expect(kept).toHaveLength(20);
  expect(kept[0]).toBe("<a0@x.com>");                       // thread root survives
  expect(kept[kept.length - 1]).toBe("<orig@x.com>");        // parent is last
  expect(kept[1]).toBe("<a22@x.com>");                       // the middle is dropped
});

test("malformed tokens in the parent's chain are dropped", async () => {
  const h = await replyHeaders({ refs: "not-an-id <good@x.com> <bad id@x.com>" });
  expect(h["References"]).toBe("<good@x.com> <orig@x.com>");
});

test("a malformed parent Message-ID drops In-Reply-To but keeps the inherited chain", async () => {
  const h = await replyHeaders({ msg_id: "junk", refs: "<root@x.com>" });

  expect(h["In-Reply-To"]).toBeUndefined();
  expect(h["References"]).toBe("<root@x.com>");
});

test("reply does not double-prefix an existing Re: subject", async () => {
  const f = mockFetch(200, { id: "re-4" });
  const env = envWith({ resend: true, row: inboundRow({ subject: "RE: Report" }) });

  await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");
  expect(JSON.parse((f.mock.calls[0][1] as any).body).subject).toBe("RE: Report");
});

test("a malformed inbound Message-ID is not copied into the outbound headers", async () => {
  const f = mockFetch(200, { id: "re-5" });
  const env = envWith({ resend: true, row: inboundRow({ msg_id: "<a@x.com>\r\nBcc: evil@x.com" }) });

  await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");
  expect(JSON.parse((f.mock.calls[0][1] as any).body).headers).toBeUndefined();
});

test("replying to a subject-less email asks the caller for a subject", async () => {
  const f = mockFetch(200, { id: "re-6" });
  const env = envWith({ resend: true, row: inboundRow({ subject: null }) });

  const r = await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");

  expect(r.ok).toBe(false);
  expect(r.error).toBe("subject is required (the replied-to email has no subject)");
  expect(f).not.toHaveBeenCalled();
});

test("reply to an email outside the caller's mailbox is denied", async () => {
  const f = mockFetch(200, { id: "re-7" });
  const env = envWith({ resend: true, row: inboundRow({ to_addr: "someone-else@my.dev" }) });

  const r = await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");

  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not found or access denied/);
  expect(f).not.toHaveBeenCalled();
});

test("a database failure during reply lookup is returned, not thrown", async () => {
  const f = mockFetch(200, { id: "re-8" });
  const env = envWith({ resend: true, dbThrows: true });

  const r = await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");

  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/lookup failed: D1 down/);
  expect(f).not.toHaveBeenCalled();
});

// --- Validation happens before any provider call. -----------------------------

test("missing recipient or subject is rejected before calling the provider", async () => {
  const f = mockFetch(200, { id: "x" });
  const env = envWith({ resend: true });

  expect((await sendEmail(env, "me@my.dev", { subject: "s", text: "b" })).error).toMatch(/to is required/);
  // A plain send must not be told that some replied-to email lacked a subject.
  expect((await sendEmail(env, "me@my.dev", { to: ["a@x.com"], text: "b" })).error).toBe("subject is required");
  expect(f).not.toHaveBeenCalled();
});

test("more than 50 recipients is rejected", async () => {
  const f = mockFetch(200, { id: "x" });
  const to = Array.from({ length: 49 }, (_, i) => `u${i}@x.com`);
  const r = await sendEmail(envWith({ resend: true }), "me@my.dev", {
    to, cc: ["a@x.com", "b@x.com"], subject: "s", text: "b",
  });

  expect(r.error).toMatch(/at most 50 recipients/);
  expect(f).not.toHaveBeenCalled();
});

test("duplicate recipients are collapsed", async () => {
  const f = mockFetch(200, { id: "x" });
  await sendEmail(envWith({ resend: true }), "me@my.dev", {
    to: [" a@x.com ", "a@x.com", ""], subject: "s", text: "b",
  });
  expect(JSON.parse((f.mock.calls[0][1] as any).body).to).toEqual(["a@x.com"]);
});
