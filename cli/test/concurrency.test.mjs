import { test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// One config file, several programs writing to it at once — `cfmail sync` moving
// its archive cursor while `cfmail unread` moves the unread one, on a schedule.
// Every write has to survive that: no torn reads, no lost updates, no leftovers.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER = join(ROOT, "test", "fixtures", "cursor-writer.mjs");

let dir, cfg;

const read = () => JSON.parse(readFileSync(cfg, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-conc-"));
  cfg = join(dir, "config.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(count) {
  const fields = Array.from({ length: count }, (_, i) => `w${i}`);
  writeFileSync(cfg, JSON.stringify({
    base: "https://h", email: "me@x.com", key: "k",
    ...Object.fromEntries(fields.map((f) => [f, 0])),
  }));
  return fields;
}

// Run one writer per field, all at once, and wait for them all.
function raceWriters(fields, rounds) {
  const running = fields.map((f) =>
    new Promise((resolve, reject) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("node", [WRITER, cfg, f, String(rounds)], (err, _out, stderr) =>
          err ? reject(new Error(`${f}: ${stderr || err.message}`)) : resolve());
      });
    })
  );
  return Promise.all(running);
}

test("concurrent writers do not lose each other's updates", async () => {
  // Before the config lock this ended with cursors stuck at 2 and one writer
  // dead on a half-written file.
  const fields = seed(4);
  await raceWriters(fields, 30);

  const after = read();
  for (const f of fields) {
    expect(after[f], `${f} lost updates`).toBe(30);
  }
});

test("no writer sees a half-written file", async () => {
  // A plain writeFileSync truncates first; a reader landing in that window got
  // "Unexpected end of JSON input" and exited non-zero.
  const fields = seed(4);
  await expect(raceWriters(fields, 30)).resolves.toBeDefined();
});

test("settings nobody is writing survive the race", async () => {
  await raceWriters(seed(4), 20);

  const after = read();
  expect(after.base).toBe("https://h");
  expect(after.email).toBe("me@x.com");
  expect(after.key).toBe("k");
});

test("nothing is left behind in the config directory", async () => {
  await raceWriters(seed(3), 20);

  const stray = readdirSync(dir).filter((f) => f !== "config.json");
  expect(stray, `leftovers: ${stray.join(", ")}`).toHaveLength(0);
});

test("the config keeps its owner-only permissions after a race", async () => {
  await raceWriters(seed(3), 15);
  expect(statSync(cfg).mode & 0o777).toBe(0o600);
});

test("a stale lock from a crashed writer does not wedge later runs", async () => {
  seed(1);
  writeFileSync(`${cfg}.lock`, "99999");
  // Age it past the point where it can plausibly belong to a live writer.
  const old = new Date(Date.now() - 30_000);
  const { utimesSync } = await import("node:fs");
  utimesSync(`${cfg}.lock`, old, old);

  execFileSync("node", [WRITER, cfg, "w0", "3"], { encoding: "utf8" });
  expect(read().w0).toBe(3);
});
