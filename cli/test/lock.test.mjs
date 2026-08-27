import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lockHolder, LOCK } from "../src/lock.mjs";

let dir;
const lockPath = () => join(dir, LOCK);
const age = (ms) => {
  const t = new Date(Date.now() - ms);
  utimesSync(lockPath(), t, t);
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cfmail-lock-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the first caller takes the lock and the second is turned away", () => {
  const first = acquireLock(dir);
  expect(first).not.toBeNull();
  expect(acquireLock(dir)).toBeNull();
  first.release();
});

test("releasing removes the file so the next run can take it", () => {
  const first = acquireLock(dir);
  expect(existsSync(lockPath())).toBe(true);

  first.release();
  expect(existsSync(lockPath())).toBe(false);

  const second = acquireLock(dir);
  expect(second).not.toBeNull();
  second.release();
});

test("releasing twice is harmless", () => {
  const lock = acquireLock(dir);
  lock.release();
  expect(() => lock.release()).not.toThrow();
});

test("the holder can be identified, for a message worth reading", () => {
  const lock = acquireLock(dir);
  const held = lockHolder(dir);

  expect(held.pid).toBe(process.pid);
  expect(held.age).toBeLessThan(1000);
  lock.release();

  expect(lockHolder(dir)).toBeNull();
});

test("a lock left by a crashed run is taken over once it goes stale", () => {
  acquireLock(dir);          // never released, as if the process died
  expect(acquireLock(dir)).toBeNull();

  age(6 * 60_000);
  const recovered = acquireLock(dir);
  expect(recovered).not.toBeNull();
  recovered.release();
});

test("a long run keeps its lock alive by touching it", () => {
  const lock = acquireLock(dir);
  age(6 * 60_000);           // as though it had been working a while

  lock.touch();
  // Still fresh, so a concurrent run must not steal it mid-flight.
  expect(acquireLock(dir)).toBeNull();
  lock.release();
});

test("a takeover does not let the abandoned holder delete the new lock", () => {
  const dead = acquireLock(dir);
  age(6 * 60_000);

  const live = acquireLock(dir);
  expect(live).not.toBeNull();

  // The old handle releasing must not remove the lock the new run holds.
  dead.release();
  expect(existsSync(lockPath())).toBe(true);
  expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);

  live.release();
});

test("an unreadable lock file is treated as stale rather than blocking forever", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(), "not json");
  age(6 * 60_000);

  const lock = acquireLock(dir);
  expect(lock).not.toBeNull();
  lock.release();
});

test("the archive directory is created if the lock is the first thing written", () => {
  const fresh = join(dir, "nested", "archive");
  const lock = acquireLock(fresh);

  expect(lock).not.toBeNull();
  expect(existsSync(join(fresh, LOCK))).toBe(true);
  lock.release();
});
