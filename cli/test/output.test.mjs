import { test, expect, vi, afterEach, beforeEach } from "vitest";
import { setJsonMode, isJson, fail, formatDate } from "../src/output.mjs";

beforeEach(() => setJsonMode(false));
afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
});

function capture(fn) {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try { fn(); } catch (e) { if (e.message !== "EXIT") throw e; }
  return {
    code: exit.mock.calls[0]?.[0],
    out: stdout.mock.calls.map((c) => c[0]).join(""),
    err: stderr.mock.calls.map((c) => c[0]).join(""),
  };
}

test("failures exit non-zero and write to stderr in text mode", () => {
  const r = capture(() => fail("boom", { code: "E_X", hint: "do this" }));
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/error: boom/);
  expect(r.err).toMatch(/code: E_X/);
  expect(r.err).toMatch(/hint: do this/);
  expect(r.out).toBe("");
});

test("in --json mode a failure is structured on stdout, still exiting non-zero", () => {
  setJsonMode(true);
  const r = capture(() => fail("boom", { code: "E_X" }));

  expect(r.code).toBe(1);
  expect(r.err).toBe("");
  expect(JSON.parse(r.out)).toEqual({ ok: false, error: "boom", code: "E_X" });
});

test("json mode is off by default", () => {
  expect(isJson()).toBe(false);
});

test("formatDate renders a local timestamp and tolerates nothing", () => {
  expect(formatDate(0)).toBe("");
  expect(formatDate(undefined)).toBe("");
  expect(formatDate(Date.parse("2026-08-27T09:05:00"))).toBe("2026-08-27 09:05");
});
