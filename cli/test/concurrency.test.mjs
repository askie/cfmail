import { test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Several agents drive this CLI at once. The config is shared, so every write
// has to survive that: no torn reads, no lost updates, no leftover temp files.

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
  const accounts = {};
  for (let i = 0; i < count; i++) {
    accounts[`m${i}@x.com`] = { base: "https://h", key: `k${i}`, cursor: 0 };
  }
  writeFileSync(cfg, JSON.stringify({ current: "m0@x.com", accounts }));
  return Object.keys(accounts);
}

// Run one writer per mailbox, all at once, and wait for them all.
function raceWriters(mailboxes, rounds) {
  const running = mailboxes.map((m) =>
    new Promise((resolve, reject) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("node", [WRITER, cfg, m, String(rounds)], (err, _out, stderr) =>
          err ? reject(new Error(`${m}: ${stderr || err.message}`)) : resolve());
      });
    })
  );
  return Promise.all(running);
}

test("concurrent writers do not lose each other's updates", async () => {
  // Before the config lock this ended with cursors stuck at 2 and one writer
  // dead on a half-written file.
  const boxes = seed(4);
  await raceWriters(boxes, 30);

  const after = read();
  for (const m of boxes) {
    expect(after.accounts[m].cursor, `${m} lost updates`).toBe(30);
  }
});

test("no writer sees a half-written file", async () => {
  // A plain writeFileSync truncates first; a reader landing in that window got
  // "Unexpected end of JSON input" and exited non-zero.
  const boxes = seed(4);
  await expect(raceWriters(boxes, 30)).resolves.toBeDefined();
});

test("unrelated mailboxes keep their settings through the race", async () => {
  const boxes = seed(4);
  await raceWriters(boxes, 20);

  const after = read();
  expect(Object.keys(after.accounts).sort()).toEqual(boxes.sort());
  for (const m of boxes) {
    expect(after.accounts[m].key).toBe(`k${m.slice(1, m.indexOf("@"))}`);
    expect(after.accounts[m].base).toBe("https://h");
  }
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

  execFileSync("node", [WRITER, cfg, "m0@x.com", "3"], { encoding: "utf8" });
  expect(read().accounts["m0@x.com"].cursor).toBe(3);
});
