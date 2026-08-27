// One config file holds one mailbox. These lock down that shape, the migration
// from the version that packed several into one file, and the isolation two
// programs get from pointing EMAIL_INBOX_CONFIG at different files.

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, readStoredConfig, requireConfig } from "../src/config.mjs";

let dir, path;
const ENV = ["EMAIL_INBOX_CONFIG", "EMAIL_INBOX_BASE", "EMAIL_INBOX_KEY", "EMAIL_ADMIN_CONFIG"];

const write = (data, p = path) => writeFileSync(p, JSON.stringify(data, null, 2));
const read = (p = path) => JSON.parse(readFileSync(p, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-box-"));
  path = join(dir, "config.json");
  for (const k of ENV) delete process.env[k];
  process.env.EMAIL_INBOX_CONFIG = path;
});

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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

// --- The stored shape. ---------------------------------------------------------

test("the file holds one mailbox at the top level", () => {
  saveConfig({ base: "https://h", email: "me@x.com", key: "k" }, "user");
  expect(read()).toMatchObject({ base: "https://h", email: "me@x.com", key: "k" });
  expect(read().accounts).toBeUndefined();
  expect(read().current).toBeUndefined();
});

test("saving one field leaves the rest alone", () => {
  write({ base: "https://h", email: "me@x.com", key: "k", syncDir: "/archive" });
  saveConfig({ cursor: 42 }, "user");

  expect(read()).toEqual({
    base: "https://h", email: "me@x.com", key: "k", syncDir: "/archive", cursor: 42,
  });
});

test("environment credentials override the file for that run only", () => {
  write({ base: "https://file", email: "me@x.com", key: "fk" });
  process.env.EMAIL_INBOX_KEY = "from-env";

  expect(loadConfig("user").key).toBe("from-env");
  // ...and must not be what a later save writes back.
  expect(readStoredConfig("user").key).toBe("fk");
  saveConfig({ cursor: 1 }, "user");
  expect(read().key).toBe("fk");
});

// --- Two config files are two mailboxes, with nothing in common. ---------------

test("a second config file is a fully separate mailbox", () => {
  const other = join(dir, "work.json");
  write({ base: "https://a", email: "a@x.com", key: "ka", cursor: 100 });
  write({ base: "https://b", email: "b@x.com", key: "kb", cursor: 200, syncDir: "/tmp/b" }, other);

  expect(loadConfig("user")).toMatchObject({ email: "a@x.com", cursor: 100 });

  process.env.EMAIL_INBOX_CONFIG = other;
  expect(loadConfig("user")).toMatchObject({ email: "b@x.com", cursor: 200, syncDir: "/tmp/b" });

  // Advancing one cursor cannot touch the other.
  saveConfig({ cursor: 999 }, "user");
  expect(read(other).cursor).toBe(999);
  expect(read(path).cursor).toBe(100);
});

// --- Migration off the multi-account file. -------------------------------------

test("an old multi-account file is read as the mailbox it had selected", () => {
  write({
    current: "b@x.com",
    accounts: {
      "a@x.com": { base: "https://a", key: "ka" },
      "b@x.com": { base: "https://b", key: "kb", cursor: 7 },
    },
  });
  expect(loadConfig("user")).toMatchObject({ email: "b@x.com", base: "https://b", key: "kb", cursor: 7 });
});

test("the first write flattens the old shape without losing anything", () => {
  write({ current: "old@x.com", accounts: { "old@x.com": { base: "https://old", key: "k", cursor: 42, syncDir: "/archive" } } });
  saveConfig({ cursor: 43 }, "user");

  expect(read()).toEqual({
    email: "old@x.com", base: "https://old", key: "k", cursor: 43, syncDir: "/archive",
  });
});

test("a sole account needs no current marker", () => {
  write({ accounts: { "only@x.com": { base: "https://o", key: "k" } } });
  expect(loadConfig("user").email).toBe("only@x.com");
});

test("an old file holding several mailboxes says how to split it", () => {
  // Picking one for the user would silently point every later command at a
  // mailbox they did not choose.
  write({ accounts: { "a@x.com": { base: "https://a", key: "ka" }, "b@x.com": { base: "https://b", key: "kb" } } });
  const msg = expectFail(() => loadConfig("user"));

  expect(msg).toMatch(/2 mailboxes/);
  expect(msg).toMatch(/a@x\.com/);
  expect(msg).toMatch(/b@x\.com/);
  expect(msg).toMatch(/EMAIL_INBOX_CONFIG/);
});

test("a non-string current falls back to the sole account", () => {
  write({ current: 42, accounts: { "a@x.com": { base: "https://a", key: "k" } } });
  expect(loadConfig("user").email).toBe("a@x.com");
});

test("a null account entry reads as empty rather than throwing", () => {
  write({ current: "a@x.com", accounts: { "a@x.com": null } });
  expect(loadConfig("user")).toMatchObject({ email: "a@x.com", base: "", key: "" });
});

test("an accounts field that is not a map of mailboxes is ignored, not obeyed", () => {
  write({ accounts: "not an object", base: "https://x", key: "k" });
  expect(loadConfig("user")).toMatchObject({ base: "https://x", key: "k" });
});

// --- Telling the user what to do. ----------------------------------------------

test("with nothing configured at all, the error points at setup", () => {
  expect(expectFail(() => requireConfig("user"))).toMatch(/cfmail setup/);
});

test("the admin config is a separate file and stays untouched", () => {
  const adminPath = join(dir, "admin.json");
  process.env.EMAIL_ADMIN_CONFIG = adminPath;
  writeFileSync(adminPath, JSON.stringify({ base: "https://svc", key: "MCP" }));
  write({ base: "https://user", email: "me@x.com", key: "uk" });

  expect(loadConfig("admin")).toEqual({ base: "https://svc", key: "MCP" });
  saveConfig({ cursor: 5 }, "user");
  expect(read(adminPath)).toEqual({ base: "https://svc", key: "MCP" });
});
