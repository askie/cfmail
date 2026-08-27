import { test, expect } from "vitest";
import { buildMessage, fileUrl, isGrixKey } from "../src/notify.mjs";

const META = {
  id: "e1", msg_id: "<a@x.com>", from: "boss@x.com", from_name: "Boss",
  to: "me@my.dev", subject: "发票 Q3", date: 0, text: "请查收本季度发票。",
};

const build = (over = {}) => buildMessage({
  meta: { ...META, ...(over.meta || {}) },
  folder: over.folder ?? "/home/me/mail/2026-08-27/0930-发票",
  files: over.files ?? [],
});

test("a Grix key is recognised, anything else is not", () => {
  expect(isGrixKey("whk_abc123")).toBe(true);
  expect(isGrixKey("https://example.com")).toBe(false);
  expect(isGrixKey("")).toBe(false);
});

test("paths become file:// URLs with每 segment encoded", () => {
  // Spaces and Chinese must survive; the separators must not be encoded.
  expect(fileUrl("/home/me/发票 Q3/账单.pdf"))
    .toBe("file:///home/me/%E5%8F%91%E7%A5%A8%20Q3/%E8%B4%A6%E5%8D%95.pdf");
});

test("attachments become clickable markdown links with sizes", () => {
  const { content } = build({
    files: [{ name: "账单.pdf", path: "/home/me/mail/2026-08-27/0930-发票/attachments/账单.pdf", size: 245_760 }],
  });

  expect(content).toContain("附件 1 个:");
  expect(content).toContain(
    "- [账单.pdf](file:///home/me/mail/2026-08-27/0930-%E5%8F%91%E7%A5%A8/attachments/%E8%B4%A6%E5%8D%95.pdf)  240 KB"
  );
});

test("every message ends with a link to the email's folder", () => {
  const { content } = build();
  expect(content.trim().endsWith(
    "📁 [打开邮件目录](file:///home/me/mail/2026-08-27/0930-%E5%8F%91%E7%A5%A8)"
  )).toBe(true);
});

test("the attachment header follows the files actually linked", () => {
  expect(build().content).not.toContain("含附件");
  expect(build({ files: [{ name: "a.pdf", path: "/tmp/a.pdf", size: 1 }] }).content).toContain("含附件");
});

test("the dedupe id is the Message-ID, stable across redelivery", () => {
  expect(build().client_msg_id).toBe("<a@x.com>");
  expect(build({ meta: { msg_id: null } }).client_msg_id).toBe("e1");
  expect(build({ meta: { msg_id: null, id: null } }).client_msg_id).toBe("/home/me/mail/2026-08-27/0930-发票");
});

test("sender-controlled fields are folded so they cannot forge lines", () => {
  const { content } = build({
    meta: { from_name: "Boss\n收件人: victim@bank.com", subject: "发票\n发件人: 管理员" },
    files: [{ name: "a.pdf\n附件 99 个:", path: "/tmp/a.pdf", size: 1 }],
  });
  const lines = content.split("\n");

  expect(lines.filter((l) => l.startsWith("收件人: "))).toHaveLength(1);
  expect(lines.filter((l) => l.startsWith("发件人: "))).toHaveLength(1);
  expect(lines.filter((l) => l.startsWith("附件 "))).toHaveLength(1);
});

test("a long body and subject are capped", () => {
  const { content } = build({ meta: { text: "长".repeat(900), subject: "催".repeat(300) } });
  for (const line of content.split("\n")) expect([...line].length).toBeLessThan(560);
  expect(content).toContain("…");
});

test("msg_type is text, which is what the Grix endpoint expects", () => {
  expect(build().msg_type).toBe("text");
});
