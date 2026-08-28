import { test, expect } from "vitest";
import { parseRaw, inferContentType } from "../src/parse";

const RAW = [
  "From: Alice <alice@example.com>",
  "To: inbox@example.com",
  "Cc: ops@example.com",
  "Subject: Test Invoice 2026",
  "Message-ID: <test-123@example.com>",
  "Date: Sat, 14 Jun 2026 06:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="BOUND"',
  "",
  "--BOUND",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "你好，这是一封测试邮件，包含发票信息。Hello world.",
  "--BOUND",
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  "",
  "attachment body content",
  "--BOUND--",
  "",
].join("\r\n");

const THREADED = [
  "From: Bob <bob@example.com>",
  "To: inbox@example.com",
  "Subject: Re: Test Invoice 2026",
  "Message-ID: <reply-2@example.com>",
  "In-Reply-To: <test-123@example.com>",
  "References: <root-1@example.com>",
  "\t<test-123@example.com>",
  "",
  "sure, sending it over.",
  "",
].join("\r\n");

test("parseRaw keeps the References header, unfolding continuation lines", async () => {
  const parsed = await parseRaw(THREADED);

  expect(parsed.msg_id).toContain("reply-2@example.com");
  expect(parsed.refs).toContain("<root-1@example.com>");
  expect(parsed.refs).toContain("<test-123@example.com>");
  // Folded onto two source lines, but one logical header value.
  expect(parsed.refs).not.toContain("\r\n");
});

test("parseRaw returns null refs for a message that starts a thread", async () => {
  expect((await parseRaw(RAW)).refs).toBeNull();
});

test("parseRaw extracts headers, Chinese body, and attachment", async () => {
  const parsed = await parseRaw(RAW);

  expect(parsed.from_addr).toBe("alice@example.com");
  expect(parsed.from_name).toBe("Alice");
  expect(parsed.to_addr).toContain("inbox@example.com");
  expect(parsed.cc_addr).toContain("ops@example.com");
  expect(parsed.subject).toBe("Test Invoice 2026");
  expect(parsed.msg_id).toContain("test-123@example.com");
  expect(parsed.date).toBe(Date.parse("Sat, 14 Jun 2026 06:00:00 +0000"));
  expect(parsed.text_body).toContain("测试邮件");

  expect(parsed.attachments).toHaveLength(1);
  expect(parsed.attachments[0].filename).toBe("note.txt");
  expect(parsed.attachments[0].content.byteLength).toBeGreaterThan(0);
});

test("an octet-stream attachment gets its type from the filename extension", async () => {
  const raw = RAW.replace(
    'Content-Type: text/plain; name="note.txt"\r\nContent-Disposition: attachment; filename="note.txt"',
    'Content-Type: application/octet-stream; name="shot.PNG"\r\nContent-Disposition: attachment; filename="shot.PNG"'
  );
  const parsed = await parseRaw(raw);
  expect(parsed.attachments[0].filename).toBe("shot.PNG");
  expect(parsed.attachments[0].content_type).toBe("image/png");
});

test("inferContentType only overrides a missing or generic declared type", () => {
  expect(inferContentType("a.xlsx", "application/octet-stream")).toBe(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  expect(inferContentType("a.jpg", null)).toBe("image/jpeg");
  expect(inferContentType("a.jpg", "text/csv")).toBe("text/csv");   // declared wins when specific
  expect(inferContentType("blob.unknownext", "application/octet-stream")).toBe("application/octet-stream");
  expect(inferContentType(null, null)).toBeNull();
});
