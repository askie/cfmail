import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailboxDir, migrateFlatArchive, isDayDir, MARKER } from "../src/archive.mjs";

let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cfmail-arch-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mail = (dir, day, name) => {
  const f = join(dir, day, name);
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, "meta.json"), "{}");
  return f;
};

// --- Where a mailbox's mail goes. ----------------------------------------------

test("mail is filed under the address it arrived at", () => {
  expect(mailboxDir("/archive", "me@example.com")).toBe(join("/archive", "me@example.com"));
});

test("two mailboxes sharing a root get separate folders", () => {
  // Without this level they would interleave inside each day and become
  // indistinguishable — which is the whole reason for the address folder.
  const a = mailboxDir(root, "a@x.com");
  const b = mailboxDir(root, "b@x.com");
  expect(a).not.toBe(b);
});

test("characters a filesystem would reject are replaced", () => {
  const dir = mailboxDir("/archive", 'bad:name?<>|"@x.com');
  expect(dir).not.toMatch(/[:?<>|"]/);
  expect(dir.startsWith(join("/archive", "bad"))).toBe(true);
});

test("an address-less account still gets a folder", () => {
  expect(mailboxDir("/archive", "")).toBe(join("/archive", "(default)"));
});

test("only YYYY-MM-DD counts as a day folder", () => {
  expect(isDayDir("2026-08-27")).toBe(true);
  expect(isDayDir("attachments")).toBe(false);
  expect(isDayDir("2026-8-7")).toBe(false);
  expect(isDayDir(MARKER)).toBe(false);
});

// --- Moving an archive written before mail was filed by address. ---------------

test("day folders at the root move under the mailbox that syncs", () => {
  mail(root, "2026-08-27", "0930-one-aaa111");
  mail(root, "2026-08-26", "1015-two-bbb222");
  writeFileSync(join(root, MARKER), "cfmail archive\n");

  expect(migrateFlatArchive(root, "me@x.com")).toBe(2);

  const box = mailboxDir(root, "me@x.com");
  expect(readdirSync(box).sort()).toEqual(["2026-08-26", "2026-08-27"]);
  expect(existsSync(join(box, "2026-08-27", "0930-one-aaa111", "meta.json"))).toBe(true);
  // The root keeps only the marker and the mailbox folder.
  expect(readdirSync(root).sort()).toEqual([MARKER, "me@x.com"]);
});

test("an already-migrated archive is left alone", () => {
  mail(mailboxDir(root, "me@x.com"), "2026-08-27", "0930-one-aaa111");
  expect(migrateFlatArchive(root, "me@x.com")).toBe(0);
});

test("a half-finished migration merges instead of clobbering", () => {
  // Interrupted mid-move: the same day exists in both places.
  mail(root, "2026-08-27", "0930-old-aaa111");
  mail(mailboxDir(root, "me@x.com"), "2026-08-27", "1015-new-bbb222");

  migrateFlatArchive(root, "me@x.com");

  const day = join(mailboxDir(root, "me@x.com"), "2026-08-27");
  expect(readdirSync(day).sort()).toEqual(["0930-old-aaa111", "1015-new-bbb222"]);
});

test("a missing root is not an error", () => {
  expect(migrateFlatArchive(join(root, "nope"), "me@x.com")).toBe(0);
});

test("files that are not day folders stay at the root", () => {
  writeFileSync(join(root, MARKER), "x");
  writeFileSync(join(root, "notes.txt"), "keep me");
  mail(root, "2026-08-27", "0930-one-aaa111");

  migrateFlatArchive(root, "me@x.com");

  expect(existsSync(join(root, "notes.txt"))).toBe(true);
  expect(existsSync(join(root, MARKER))).toBe(true);
});
