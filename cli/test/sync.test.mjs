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

async function runSync(argv, emails, opts = {}) {
  const stub = stubMcp(emails ?? [EMAIL], opts);
  vi.doMock("../src/mcp.mjs", () => ({ Mcp: class { constructor() { return stub; } } }));

  // Notifications go out over the network; capture them instead.
  const sent = [];
  vi.doMock("../src/notify.mjs", async () => {
    const real = await vi.importActual("../src/notify.mjs");
    return {
      ...real,
      sendToGrix: async (key, payload) => {
        if (opts.notifyFails) throw new Error("HTTP 500");
        sent.push({ key, payload });
        return {};
      },
    };
  });

  const { run } = await import("../src/commands/sync.mjs");
  await run(argv);
  stub.sent = sent;
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

test("an archive with no new mail this run is still marked", async () => {
  // The case that bit older archives: nothing to write, so the marker never
  // appeared and prune refused to clean a folder that was genuinely ours.
  await runSync(["--dir", archive, "--all"], []);
  expect(existsSync(join(archive, ".cfmail-archive"))).toBe(true);
});

// --- Notifications. ------------------------------------------------------------

const KEY = "whk_abc123";

function storedConfig() {
  return JSON.parse(readFileSync(process.env.EMAIL_INBOX_CONFIG, "utf8"));
}

test("turning notifications on marks existing mail as seen instead of replaying it", async () => {
  // Announcing a whole mailbox into a chat the moment someone opts in would be
  // unusable; only mail arriving afterwards should be pushed.
  const stub = await runSync(["--dir", archive, "--all", "--notify", KEY]);

  expect(stub.sent).toHaveLength(0);
  expect(printed.join("")).toMatch(/已把现有 1 封标记为「已通知」/);
  expect(existsSync(join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0], ".notified"))).toBe(true);
  expect(storedConfig().notifyKey).toBe(KEY);
});

test("mail arriving after opt-in is pushed with its local links", async () => {
  await runSync(["--dir", archive, "--all", "--notify", KEY]);   // opt in, nothing sent
  vi.resetModules();
  printed = [];

  const later = { ...EMAIL, id: "e2", subject: "第二封", date: EMAIL.date + 60_000 };
  const stub = await runSync(["--dir", archive, "--all"], [EMAIL, later]);

  expect(stub.sent).toHaveLength(1);
  expect(stub.sent[0].key).toBe(KEY);
  expect(stub.sent[0].payload.content).toContain("第二封");
  expect(stub.sent[0].payload.content).toContain("file:///");
});

test("a failed push leaves no marker, so the next run retries it", async () => {
  await runSync(["--dir", archive, "--all", "--notify", KEY]);
  vi.resetModules();
  printed = [];

  const later = { ...EMAIL, id: "e2", subject: "会失败的", date: EMAIL.date + 60_000, attachments: [] };
  await runSync(["--dir", archive, "--all"], [EMAIL, later], { notifyFails: true });

  const folder = readdirSync(join(archive, "2026-08-27")).find((f) => f.includes("会失败的"));
  expect(existsSync(join(archive, "2026-08-27", folder, ".notified"))).toBe(false);
  expect(printed.join("")).toMatch(/推送失败.*下次 sync 会重试/s);

  // Retry: same mail, working transport.
  vi.resetModules();
  printed = [];
  const stub = await runSync(["--dir", archive, "--all"], [EMAIL, later]);
  expect(stub.sent).toHaveLength(1);
  expect(existsSync(join(archive, "2026-08-27", folder, ".notified"))).toBe(true);
});

test("an email is never announced twice", async () => {
  await runSync(["--dir", archive, "--all", "--notify", KEY]);
  vi.resetModules();
  const later = { ...EMAIL, id: "e2", subject: "只推一次", date: EMAIL.date + 60_000, attachments: [] };
  await runSync(["--dir", archive, "--all"], [EMAIL, later]);

  vi.resetModules();
  const again = await runSync(["--dir", archive, "--all"], [EMAIL, later]);
  expect(again.sent).toHaveLength(0);
});

test("--no-notify skips pushing for that run without losing the setting", async () => {
  await runSync(["--dir", archive, "--all", "--notify", KEY]);
  vi.resetModules();

  const later = { ...EMAIL, id: "e2", subject: "静默这次", date: EMAIL.date + 60_000, attachments: [] };
  const stub = await runSync(["--dir", archive, "--all", "--no-notify"], [EMAIL, later]);

  expect(stub.sent).toHaveLength(0);
  expect(storedConfig().notifyKey).toBe(KEY);   // still configured for next time
});

test("a --notify value that is not a Grix key is rejected", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(runSync(["--dir", archive, "--notify", "https://example.com"])).rejects.toThrow("EXIT");
  exit.mockRestore();
});

test("a relative archive path from an older config is made absolute", async () => {
  // A relative syncDir would produce file://mail/... links that open nothing,
  // and saving it back would keep it broken forever.
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, JSON.stringify({
    base: "https://h", key: "k", syncDir: "relative-archive", notifyKey: KEY,
  }));
  const cwd = process.cwd();
  process.chdir(dir);

  try {
    const later = { ...EMAIL, id: "e9", subject: "绝对路径", attachments: [] };
    const stub = await runSync(["--all"], [later]);

    expect(stub.sent).toHaveLength(1);
    const link = stub.sent[0].payload.content.match(/file:\/\/\S+/)[0];
    expect(link.startsWith("file:///")).toBe(true);
    expect(link).not.toContain("file://relative-archive");
    expect(storedConfig().syncDir.startsWith("/")).toBe(true);
  } finally {
    process.chdir(cwd);
  }
});

test("the marker records when the push happened, not the email's date", async () => {
  await runSync(["--dir", archive, "--all", "--notify", KEY]);
  vi.resetModules();

  const later = { ...EMAIL, id: "e2", subject: "时间戳", date: Date.parse("2020-01-01T00:00:00"), attachments: [] };
  await runSync(["--dir", archive, "--all"], [EMAIL, later]);

  const folder = readdirSync(join(archive, "2020-01-01"))[0];
  const stamp = readFileSync(join(archive, "2020-01-01", folder, ".notified"), "utf8").trim();
  // The email is from 2020; the push is now.
  expect(new Date(stamp).getFullYear()).toBe(new Date().getFullYear());
});

test("--dry-run neither pushes nor remembers the key", async () => {
  const stub = await runSync(["--dir", archive, "--all", "--notify", KEY, "--dry-run"]);
  expect(stub.sent).toHaveLength(0);
  expect(storedConfig().notifyKey).toBeUndefined();
});

// --- HTML-only mail. -----------------------------------------------------------

const HTML_ONLY = {
  ...EMAIL, id: "h1", subject: "Your verification code", text: "", attachments: [],
  html: '<html><body><h2>Your code</h2><p>It is <strong>558213</strong>, valid 10&nbsp;min.</p>' +
        '<p><a href="https://app.example.com/v?t=x">Verify</a></p></body></html>',
};

test("an HTML-only email gets a markdown body written next to the empty text one", async () => {
  await runSync(["--dir", archive, "--all"], [HTML_ONLY]);

  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);
  expect(readFileSync(join(p, "body.txt"), "utf8")).toBe("");

  const md = readFileSync(join(p, "body.md"), "utf8");
  expect(md).toContain("## Your code");
  expect(md).toContain("**558213**");
  expect(md).toContain("[Verify](https://app.example.com/v?t=x)");
  expect(md).not.toContain("<");
});

test("a message with a plain-text part gets no body.md", async () => {
  await runSync(["--dir", archive, "--all"], [{ ...EMAIL, attachments: [] }]);
  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);

  expect(existsSync(join(p, "body.md"))).toBe(false);
});

test("the notification for an HTML-only email carries the converted text", async () => {
  // Without the conversion this message would announce an email with no content
  // at all — which is what HTML-only verification mails used to look like.
  await runSync(["--dir", archive, "--all", "--notify", KEY]);
  vi.resetModules();

  const later = { ...HTML_ONLY, date: EMAIL.date + 60_000 };
  const stub = await runSync(["--dir", archive, "--all"], [later]);

  expect(stub.sent).toHaveLength(1);
  expect(stub.sent[0].payload.content).toContain("558213");
});

test("body.html is still only written with --html", async () => {
  await runSync(["--dir", archive, "--all"], [HTML_ONLY]);
  const p = join(archive, "2026-08-27", readdirSync(join(archive, "2026-08-27"))[0]);

  // The HTML is fetched regardless (body.md needs it), but not kept unless asked.
  expect(existsSync(join(p, "body.html"))).toBe(false);
  expect(existsSync(join(p, "body.md"))).toBe(true);
});
