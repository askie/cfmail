// `cfmail list | head -3` is ordinary use. Node turns the closed pipe into an
// unhandled 'error' event, so without a handler the user gets a stack trace
// where they expected three lines.

import { test, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cfmail.mjs");

let dir, cfg;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-pipe-"));
  cfg = join(dir, "config.json");
  // `config` touches no network, so this stays offline. Every field is set on
  // purpose: the crash needs writes still pending when the reader leaves, so a
  // config one line shorter reproduces nothing.
  writeFileSync(cfg, JSON.stringify({
    email: "me@x.com", base: "https://h", key: "k",
    syncDir: "/archive", notifyKey: "whk_x", cursor: 1787788697000,
  }));
  chmodSync(cfg, 0o600);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Runs through a real shell pipeline so the pipe really does close early.
function piped(command) {
  return execSync(command, {
    encoding: "utf8",
    env: { ...process.env, EMAIL_INBOX_CONFIG: cfg },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("a reader that leaves early does not produce a stack trace", () => {
  // stderr goes to a file rather than into the pipe: merged with 2>&1 the
  // reader would cut the trace off and the check would pass by luck.
  const err = join(dir, "stderr");
  const out = piped(`node ${BIN} config 2> ${err} | head -2`);

  expect(out).toContain("me@x.com");
  expect(readFileSync(err, "utf8")).toBe("");
});

test("the writer's own exit status stays clean", () => {
  // A script checking cfmail's status (not head's) must not see a crash. The
  // status is captured inside the pipeline, since $? there belongs to `head`.
  const status = join(dir, "status");
  piped(`{ node ${BIN} config; echo $? > ${status}; } | head -2 > /dev/null`);
  expect(readFileSync(status, "utf8").trim()).toBe("0");
});

test("json output survives the same treatment", () => {
  // --json prints one long line, so cut the reader off mid-line instead.
  const err = join(dir, "stderr");
  piped(`node ${BIN} config --json 2> ${err} | head -c 20 > /dev/null`);
  expect(readFileSync(err, "utf8")).toBe("");
});
