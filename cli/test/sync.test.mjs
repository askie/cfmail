import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir, archive, printed;

const EMAIL = {
  id: "e1", msg_id: "<a@x.com>", from: "boss@x.com", from_name: "Boss",
  to: "me@my.dev", cc: null, subject: "发票 2026/08 — Q3",
  date: Date.parse("2026-08-27T09:30:00"), received_at: 0,
  text: "正文内容", html: "<p>正文内容</p>",
  attachments: [{ id: "a1", filename: "invoice.pdf", content_type: "application/pdf", size: 5 }],
};

// A service that answers the three calls sync makes.
function stubMcp(email = EMAIL) {
  return {
    connect: async () => stubMcp(email),
    call: async (name, args) => {
      if (name === "list_emails") return { emails: [{ ...email, has_attachments: !!email.attachments?.length }] };
      if (name === "get_email") return email;
      if (name === "get_attachment") return { content_base64: Buffer.from("hello").toString("base64") };
      return null;
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-sync-"));
  archive = join(dir, "mail");
  process.env.EMAIL_INBOX_CONFIG = join(dir, "cfg.json");
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, JSON.stringify({ base: "https://h", key: "k" }));
  printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => { printed.push(s); return true; });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.EMAIL_INBOX_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

async function runSync(argv, email) {
  vi.doMock("../src/mcp.mjs", () => ({ Mcp: class { constructor() { return stubMcp(email); } } }));
  const { run } = await import("../src/commands/sync.mjs");
  await run(argv);
}

test("writes one folder per email, under its own date", async () => {
  await runSync(["--dir", archive, "--all", "--html"]);

  const day = join(archive, "2026-08-27");
  const [folder] = readdirSync(day);
  expect(folder).toMatch(/^0930-/);

  const p = join(day, folder);
  expect(readFileSync(join(p, "body.txt"), "utf8")).toBe("正文内容");
  expect(readFileSync(join(p, "body.html"), "utf8")).toBe("<p>正文内容</p>");
  expect(readFileSync(join(p, "attachments", "invoice.pdf"), "utf8")).toBe("hello");

  const meta = JSON.parse(readFileSync(join(p, "meta.json"), "utf8"));
  expect(meta).toMatchObject({ id: "e1", from: "boss@x.com", subject: "发票 2026/08 — Q3" });
});

test("path separators and other unsafe characters never reach the folder name", async () => {
  await runSync(["--dir", archive, "--all"]);
  const [folder] = readdirSync(join(archive, "2026-08-27"));
  // "发票 2026/08 — Q3" must not create a nested "08" directory.
  expect(folder).not.toContain("/");
  expect(readdirSync(join(archive, "2026-08-27"))).toHaveLength(1);
});

test("body.html is only written when asked for", async () => {
  await runSync(["--dir", archive, "--all"]);
  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  expect(existsSync(join(p, "body.html"))).toBe(false);
});

test("an already archived email is skipped on the next run", async () => {
  await runSync(["--dir", archive, "--all"]);
  printed = [];
  await runSync(["--dir", archive, "--all"]);
  expect(printed.join("")).toMatch(/已归档 0 封，跳过 1 封/);
});

test("--dry-run writes nothing to disk", async () => {
  await runSync(["--dir", archive, "--all", "--dry-run"]);
  expect(existsSync(archive)).toBe(false);
  expect(printed.join("")).toMatch(/将归档 1 封/);
});

test("a subject-less email still gets a usable folder name", async () => {
  await runSync(["--dir", archive, "--all"], { ...EMAIL, subject: null, attachments: [] });
  expect(readdirSync(join(archive, "2026-08-27"))[0]).toBe("0930-no-subject");
});

test("an attachment with no filename falls back to its id", async () => {
  await runSync(["--dir", archive, "--all"], {
    ...EMAIL, attachments: [{ id: "att-9", filename: null, content_type: null, size: 5 }],
  });
  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  expect(readdirSync(join(p, "attachments"))).toEqual(["att-9"]);
});

test("the archive folder is remembered so later runs need no --dir", async () => {
  await runSync(["--dir", archive, "--all"]);
  const cfg = JSON.parse(readFileSync(process.env.EMAIL_INBOX_CONFIG, "utf8"));
  expect(cfg.syncDir).toBe(archive);
  expect(cfg.syncCursor).toBe(EMAIL.date);
});
