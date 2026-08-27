import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/commands/prune.mjs";
import { setJsonMode } from "../src/output.mjs";

let dir, archive, printed;

// Build a day folder holding `count` archived emails.
function day(name, count = 1) {
  for (let i = 0; i < count; i++) {
    const f = join(archive, name, `09${i}0-mail-${i}`);
    mkdirSync(f, { recursive: true });
    writeFileSync(join(f, "meta.json"), "{}");
  }
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400_000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-prune-"));
  archive = join(dir, "mail");
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, ".cfmail-archive"), "cfmail archive\n");
  process.env.EMAIL_INBOX_CONFIG = join(dir, "cfg.json");
  printed = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => { printed.push(s); return true; });
  setJsonMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.EMAIL_INBOX_CONFIG;
  rmSync(dir, { recursive: true, force: true });
  setJsonMode(false);
});

const output = () => printed.join("");

test("a plain run reports without deleting anything", async () => {
  day(daysAgo(100), 3);
  await run(["--dir", archive, "--older-than", "30d"]);

  expect(existsSync(join(archive, daysAgo(100)))).toBe(true);
  expect(output()).toMatch(/将删除 1 天共 3 封/);
  expect(output()).toMatch(/这是预演/);
});

test("--yes actually removes the aged-out day folders", async () => {
  day(daysAgo(100), 2);
  day(daysAgo(1), 1);
  await run(["--dir", archive, "--older-than", "30d", "--yes"]);

  expect(existsSync(join(archive, daysAgo(100)))).toBe(false);
  expect(existsSync(join(archive, daysAgo(1)))).toBe(true);
});

test("--dry-run wins over --yes", async () => {
  day(daysAgo(100));
  await run(["--dir", archive, "--older-than", "30d", "--yes", "--dry-run"]);
  expect(existsSync(join(archive, daysAgo(100)))).toBe(true);
});

test("a partially aged day is kept until the whole day is past the cutoff", async () => {
  // Exactly at the boundary: some of that day is still inside the window.
  day(daysAgo(30));
  await run(["--dir", archive, "--older-than", "30d", "--yes"]);
  expect(existsSync(join(archive, daysAgo(30)))).toBe(true);
});

test("anything that is not a sync day folder is left alone", async () => {
  mkdirSync(join(archive, "important-notes"), { recursive: true });
  writeFileSync(join(archive, "README.md"), "keep me");
  day(daysAgo(100));

  await run(["--dir", archive, "--older-than", "30d", "--yes"]);

  expect(existsSync(join(archive, "important-notes"))).toBe(true);
  expect(existsSync(join(archive, "README.md"))).toBe(true);
  expect(readdirSync(archive).sort()).toEqual([".cfmail-archive", "README.md", "important-notes"]);
});

test("weeks, months and years are accepted as ages", async () => {
  for (const [age, ago] of [["2w", 20], ["6m", 200], ["1y", 400]]) {
    day(daysAgo(ago));
    await run(["--dir", archive, "--older-than", age, "--yes"]);
    expect(existsSync(join(archive, daysAgo(ago)))).toBe(false);
  }
});

test("a malformed age is rejected before anything is touched", async () => {
  day(daysAgo(100));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(run(["--dir", archive, "--older-than", "30"])).rejects.toThrow("EXIT");
  expect(existsSync(join(archive, daysAgo(100)))).toBe(true);
  exit.mockRestore();
});

test("--json reports what was removed", async () => {
  day(daysAgo(100), 2);
  setJsonMode(true);
  await run(["--dir", archive, "--older-than", "30d", "--yes"]);

  const r = JSON.parse(output());
  expect(r).toMatchObject({ ok: true, applied: true, days: 1, emails: 2 });
  expect(r.removed).toEqual([daysAgo(100)]);
});

test("refuses to touch a folder that is not a cfmail archive", async () => {
  const stranger = join(dir, "not-an-archive");
  mkdirSync(join(stranger, "2020-01-01"), { recursive: true });
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  await expect(run(["--dir", stranger, "--older-than", "30d", "--yes"])).rejects.toThrow("EXIT");

  expect(existsSync(join(stranger, "2020-01-01"))).toBe(true);
  expect(err.mock.calls.map((c) => c[0]).join("")).toMatch(/not a cfmail archive/);
  exit.mockRestore();
});

test("the marker file itself is never deleted", async () => {
  day(daysAgo(100));
  await run(["--dir", archive, "--older-than", "30d", "--yes"]);
  expect(existsSync(join(archive, ".cfmail-archive"))).toBe(true);
});
