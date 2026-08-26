import { test, expect, vi } from "vitest";
import { sendEmail } from "../src/send";

function envWith(send: any, row?: any) {
  const first = vi.fn().mockResolvedValue(row ?? null);
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ first, all });
  return { EMAIL: { send }, DB: { prepare: vi.fn().mockReturnValue({ bind }) }, BUCKET: {} } as any;
}

test("sends with the caller's bound address as from", async () => {
  const send = vi.fn().mockResolvedValue({ messageId: "m-1" });
  const r = await sendEmail(envWith(send), "me@my.dev", { to: ["a@x.com"], subject: "Hi", text: "body" });

  expect(r.ok).toBe(true);
  expect(r.message_id).toBe("m-1");
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ from: "me@my.dev", to: ["a@x.com"], subject: "Hi", text: "body" })
  );
});

test("reply derives recipient, subject and threading headers from the source email", async () => {
  const send = vi.fn().mockResolvedValue({ messageId: "m-2" });
  const env = envWith(send, {
    id: "e1", msg_id: "<orig@x.com>", from_addr: "boss@x.com", to_addr: "me@my.dev",
    cc_addr: null, subject: "Report", date: 0, received_at: 0, text_body: null,
    html_key: null, has_attachments: 0,
  });

  const r = await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");

  expect(r.ok).toBe(true);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: ["boss@x.com"],
      subject: "Re: Report",
      headers: { "In-Reply-To": "<orig@x.com>", References: "<orig@x.com>" },
    })
  );
});

test("reply does not double-prefix an existing Re: subject", async () => {
  const send = vi.fn().mockResolvedValue({ messageId: "m-3" });
  const env = envWith(send, {
    id: "e1", msg_id: null, from_addr: "boss@x.com", to_addr: "me@my.dev",
    cc_addr: null, subject: "RE: Report", has_attachments: 0,
  });

  await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "RE: Report" }));
});

test("reply to an email outside the caller's mailbox is denied", async () => {
  const send = vi.fn();
  const env = envWith(send, {
    id: "e1", msg_id: null, from_addr: "boss@x.com", to_addr: "someone-else@my.dev",
    cc_addr: null, subject: "Report", has_attachments: 0,
  });

  const r = await sendEmail(env, "me@my.dev", { text: "ok", in_reply_to: "e1" }, "me@my.dev");

  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not found or access denied/);
  expect(send).not.toHaveBeenCalled();
});

test("missing recipient or subject is rejected before calling Cloudflare", async () => {
  const send = vi.fn();
  const env = envWith(send);

  expect((await sendEmail(env, "me@my.dev", { subject: "s", text: "b" })).error).toMatch(/to is required/);
  expect((await sendEmail(env, "me@my.dev", { to: ["a@x.com"], text: "b" })).error).toMatch(/subject is required/);
  expect(send).not.toHaveBeenCalled();
});

test("more than 50 recipients is rejected", async () => {
  const send = vi.fn();
  const to = Array.from({ length: 49 }, (_, i) => `u${i}@x.com`);
  const r = await sendEmail(envWith(send), "me@my.dev", { to, cc: ["a@x.com", "b@x.com"], subject: "s", text: "b" });

  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/at most 50 recipients/);
  expect(send).not.toHaveBeenCalled();
});

test("duplicate recipients are collapsed", async () => {
  const send = vi.fn().mockResolvedValue({ messageId: "m-4" });
  await sendEmail(envWith(send), "me@my.dev", { to: [" a@x.com ", "a@x.com", ""], subject: "s", text: "b" });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ["a@x.com"] }));
});

test("a Cloudflare error code is surfaced with an actionable hint", async () => {
  const send = vi.fn().mockRejectedValue(Object.assign(new Error("nope"), { code: "E_RECIPIENT_NOT_ALLOWED" }));
  const r = await sendEmail(envWith(send), "me@my.dev", { to: ["a@x.com"], subject: "s", text: "b" });

  expect(r.ok).toBe(false);
  expect(r.code).toBe("E_RECIPIENT_NOT_ALLOWED");
  expect(r.hint).toMatch(/verified destination address/);
});

test("a missing binding is reported instead of throwing", async () => {
  const r = await sendEmail({ DB: {}, BUCKET: {} } as any, "me@my.dev", { to: ["a@x.com"], subject: "s", text: "b" });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not configured/);
});
