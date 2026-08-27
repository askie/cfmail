import { test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cfmail.mjs");

let dir, cfg;
const run = (...args) =>
  execFileSync("node", [BIN, "config", ...args], {
    encoding: "utf8",
    env: { ...process.env, EMAIL_INBOX_CONFIG: cfg },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-cfgcmd-"));
  cfg = join(dir, "config.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("config says which mailbox this file is for", () => {
  writeFileSync(cfg, JSON.stringify({ email: "me@x.com", base: "https://h", key: "s3cret", syncDir: "/archive" }));
  const text = run();

  expect(text).toContain("me@x.com");
  expect(text).toContain("https://h");
  expect(text).toContain("/archive");
  expect(text).toContain(cfg);
});

test("config never prints the API key", () => {
  // It is read out loud in shared terminals and pasted into chats.
  writeFileSync(cfg, JSON.stringify({ email: "me@x.com", base: "https://h", key: "s3cret" }));
  expect(run()).not.toContain("s3cret");
  expect(run("--json")).not.toContain("s3cret");
});

test("an unconfigured file points at setup rather than looking configured", () => {
  expect(run()).toMatch(/cfmail setup/);
});

test("config reports the file it actually read, so two programs can tell them apart", () => {
  const other = join(dir, "work.json");
  writeFileSync(cfg, JSON.stringify({ email: "a@x.com", base: "https://a", key: "k" }));
  writeFileSync(other, JSON.stringify({ email: "b@x.com", base: "https://b", key: "k" }));

  const text = execFileSync("node", [BIN, "config"], {
    encoding: "utf8",
    env: { ...process.env, EMAIL_INBOX_CONFIG: other },
  });
  expect(text).toContain("b@x.com");
  expect(text).not.toContain("a@x.com");
});
