import { test, expect, vi, afterEach } from "vitest";
import { parseArgs } from "../src/args.mjs";

const SPEC = { "--to": "list", "--subject": "string", "--limit": "number", "--peek": "bool" };

// parseArgs exits the process on bad input; capture that instead of dying.
function expectFail(fn) {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT"); });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(fn).toThrow("EXIT");
    return err.mock.calls.map((c) => c[0]).join("");
  } finally {
    exit.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

test("collects lists, scalars, numbers, booleans and positionals", () => {
  const { opts, positional } = parseArgs(
    ["--to", "a@x.com", "--to", "b@x.com", "--limit", "5", "--peek", "id1"], SPEC
  );
  expect(opts).toEqual({ to: ["a@x.com", "b@x.com"], limit: 5, peek: true });
  expect(positional).toEqual(["id1"]);
});

test("kebab-case flags become camelCase keys", () => {
  const { opts } = parseArgs(["--text-file", "/tmp/b"], { "--text-file": "string" });
  expect(opts.textFile).toBe("/tmp/b");
});

test("a flag without its value fails instead of reading undefined", () => {
  const msg = expectFail(() => parseArgs(["--subject"], SPEC));
  expect(msg).toMatch(/--subject requires a value/);
});

test("a flag followed by another flag fails rather than swallowing it", () => {
  const msg = expectFail(() => parseArgs(["--subject", "--peek"], SPEC));
  expect(msg).toMatch(/--subject requires a value/);
});

test("--flag=value carries a value that itself starts with --", () => {
  const { opts } = parseArgs(["--subject=--json"], SPEC);
  expect(opts.subject).toBe("--json");
});

test("--flag=value keeps everything after the first equals sign", () => {
  const { opts } = parseArgs(["--subject=a=b=c"], SPEC);
  expect(opts.subject).toBe("a=b=c");
});

test("a boolean flag rejects an inline value", () => {
  expect(expectFail(() => parseArgs(["--peek=yes"], SPEC))).toMatch(/takes no value/);
});

test("a non-numeric value for a number flag is rejected", () => {
  expect(expectFail(() => parseArgs(["--limit", "many"], SPEC))).toMatch(/expects a number/);
});

test("an unknown option is rejected", () => {
  expect(expectFail(() => parseArgs(["--nope", "x"], SPEC))).toMatch(/unknown option: --nope/);
});
