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

// A service that answers the three calls sync makes, paging like the real one
// (newest first, capped page size) so the paging logic is actually exercised.
function stubMcp(emails = [EMAIL], { attachmentFails = false } = {}) {
  const sorted = [...emails].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  const calls = { list: [] };
  const api = {
    calls,
    connect: async () => api,
    call: async (name, args) => {
      if (name === "list_emails") {
        calls.list.push(args);
        const { limit = 20, offset = 0 } = args || {};
        return {
          emails: sorted.slice(offset, offset + limit)
            .map((e) => ({ ...e, has_attachments: !!e.attachments?.length })),
        };
      }
      if (name === "get_email") return sorted.find((e) => e.id === args.id) ?? null;
      if (name === "get_attachment") {
        return attachmentFails ? { content_base64: null } : { content_base64: Buffer.from("hello").toString("base64") };
      }
      return null;
    },
  };
  return api;
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

async function runSync(argv, emails, opts) {
  const stub = stubMcp(emails ?? [EMAIL], opts);
  vi.doMock("../src/mcp.mjs", () => ({ Mcp: class { constructor() { return stub; } } }));
  const { run } = await import("../src/commands/sync.mjs");
  await run(argv);
  return stub;
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
  await runSync(["--dir", archive, "--all"], [{ ...EMAIL, subject: null, attachments: [] }]);
  expect(readdirSync(join(archive, "2026-08-27"))[0]).toBe("0930-no-subject-e1");
});

test("an attachment with no filename falls back to its id", async () => {
  await runSync(["--dir", archive, "--all"], [{
    ...EMAIL, attachments: [{ id: "att-9", filename: null, content_type: null, size: 5 }],
  }]);
  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  expect(readdirSync(join(p, "attachments"))).toEqual(["att-9"]);
});

test("the archive folder is remembered so later runs need no --dir", async () => {
  await runSync(["--dir", archive, "--all"]);
  const cfg = JSON.parse(readFileSync(process.env.EMAIL_INBOX_CONFIG, "utf8"));
  expect(cfg.syncDir).toBe(archive);
  expect(cfg.syncCursor).toBe(EMAIL.date);
});

// --- The two ways mail could silently go missing. ------------------------------

test("a mailbox larger than one page is archived in full", async () => {
  // 250 emails, page size 100: without paging only the newest 100 would ever
  // land, and the cursor would seal the rest off forever.
  const many = Array.from({ length: 250 }, (_, i) => ({
    ...EMAIL, id: `e${i}`, subject: `mail ${i}`, attachments: [],
    date: Date.parse("2026-08-27T09:30:00") - i * 60_000,
  }));

  const stub = await runSync(["--dir", archive, "--all"], many);

  const count = readdirSync(archive)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .reduce((n, d) => n + readdirSync(join(archive, d)).length, 0);
  expect(count).toBe(250);
  expect(stub.calls.list.map((c) => c.offset)).toEqual([0, 100, 200]);
});

test("two emails in the same minute with the same subject both survive", async () => {
  const twins = [
    { ...EMAIL, id: "aaa111", attachments: [] },
    { ...EMAIL, id: "bbb222", attachments: [] },   // same date, same subject
  ];
  await runSync(["--dir", archive, "--all"], twins);

  const folders = readdirSync(join(archive, "2026-08-27"));
  expect(folders).toHaveLength(2);
  expect(folders.some((f) => f.endsWith("-aaa111"))).toBe(true);
  expect(folders.some((f) => f.endsWith("-bbb222"))).toBe(true);
});

test("an email whose attachments cannot be fetched is retried next run", async () => {
  await runSync(["--dir", archive, "--all"], [EMAIL], { attachmentFails: true });

  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  // No meta.json means "not fully archived", and the cursor must not move past it.
  expect(existsSync(join(p, "meta.json"))).toBe(false);
  expect(JSON.parse(readFileSync(process.env.EMAIL_INBOX_CONFIG, "utf8")).syncCursor).toBe(0);
  expect(printed.join("")).toMatch(/附件没取全/);
});

test("attachments sharing a filename do not overwrite each other", async () => {
  await runSync(["--dir", archive, "--all"], [{
    ...EMAIL,
    attachments: [
      { id: "att-1", filename: "photo.jpg", content_type: "image/jpeg", size: 5 },
      { id: "att-2", filename: "photo.jpg", content_type: "image/jpeg", size: 5 },
    ],
  }]);

  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  expect(readdirSync(join(p, "attachments"))).toHaveLength(2);
});

test("an overlong attachment name is truncated but keeps its extension", async () => {
  await runSync(["--dir", archive, "--all"], [{
    ...EMAIL,
    attachments: [{ id: "att-1", filename: "报销单".repeat(60) + ".pdf", content_type: "application/pdf", size: 5 }],
  }]);

  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  const [name] = readdirSync(join(p, "attachments"));
  expect(name.endsWith(".pdf")).toBe(true);
  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(100);
});

test("the archive root is marked so prune can recognise it", async () => {
  await runSync(["--dir", archive, "--all"], [{ ...EMAIL, attachments: [] }]);
  expect(existsSync(join(archive, ".cfmail-archive"))).toBe(true);
});
