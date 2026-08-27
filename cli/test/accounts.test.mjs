import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig, saveConfig, readStoredConfig, listAccounts,
  setCurrentAccount, removeAccount, selectAccount, requireConfig,
} from "../src/config.mjs";

let dir, path;
const ENV = ["EMAIL_INBOX_CONFIG", "EMAIL_INBOX_BASE", "EMAIL_INBOX_KEY", "EMAIL_INBOX_EMAIL"];

const write = (data) => writeFileSync(path, JSON.stringify(data, null, 2));
const read = () => JSON.parse(readFileSync(path, "utf8"));

const TWO = {
  current: "a@x.com",
  accounts: {
    "a@x.com": { base: "https://a.example", key: "ka", cursor: 100 },
    "b@x.com": { base: "https://b.example", key: "kb", cursor: 200, syncDir: "/tmp/b" },
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-acct-"));
  path = join(dir, "config.json");
  for (const k of ENV) delete process.env[k];
  process.env.EMAIL_INBOX_CONFIG = path;
  selectAccount("");
});

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  selectAccount("");
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

// --- Reading the account in play. ---------------------------------------------

test("the current account is the one loaded", () => {
  write(TWO);
  expect(loadConfig("user")).toMatchObject({ email: "a@x.com", base: "https://a.example", key: "ka" });
});

test("an explicit selection wins over the file's current", () => {
  write(TWO);
  selectAccount("b@x.com");
  expect(loadConfig("user")).toMatchObject({ email: "b@x.com", key: "kb", cursor: 200 });
});

test("the environment picks the mailbox when nothing was passed", () => {
  write(TWO);
  process.env.EMAIL_INBOX_EMAIL = "b@x.com";
  expect(loadConfig("user").email).toBe("b@x.com");
});

test("a single configured mailbox is used even without a current marker", () => {
  write({ current: "", accounts: { "only@x.com": { base: "https://o", key: "k" } } });
  expect(loadConfig("user").email).toBe("only@x.com");
});

test("environment credentials override the stored ones for that run", () => {
  write(TWO);
  process.env.EMAIL_INBOX_KEY = "from-env";
  expect(loadConfig("user").key).toBe("from-env");
  // ...but must not be what a later save writes back.
  expect(readStoredConfig("user").key).toBe("ka");
});

// --- Isolation between mailboxes. ---------------------------------------------

test("each mailbox keeps its own cursor and archive settings", () => {
  write(TWO);
  expect(loadConfig("user").cursor).toBe(100);
  selectAccount("b@x.com");
  expect(loadConfig("user")).toMatchObject({ cursor: 200, syncDir: "/tmp/b" });
});

test("saving touches only the account in play", () => {
  write(TWO);
  selectAccount("b@x.com");
  saveConfig({ cursor: 999 }, "user");

  const file = read();
  expect(file.accounts["b@x.com"].cursor).toBe(999);
  expect(file.accounts["a@x.com"].cursor).toBe(100);   // untouched
  expect(file.accounts["b@x.com"].key).toBe("kb");     // other fields preserved
});

test("saving with an explicit email targets that account", () => {
  write(TWO);
  saveConfig({ email: "b@x.com", notifyKey: "whk_x" }, "user");
  expect(read().accounts["b@x.com"].notifyKey).toBe("whk_x");
  expect(read().accounts["a@x.com"].notifyKey).toBeUndefined();
});

// --- Switching and removing. ---------------------------------------------------

test("use switches which mailbox is current", () => {
  write(TWO);
  setCurrentAccount("b@x.com", "user");
  expect(read().current).toBe("b@x.com");
  expect(loadConfig("user").email).toBe("b@x.com");
});

test("switching to an unknown mailbox lists the ones that exist", () => {
  write(TWO);
  const msg = expectFail(() => setCurrentAccount("nope@x.com", "user"));
  expect(msg).toMatch(/no mailbox configured for nope@x.com/);
  expect(msg).toMatch(/a@x\.com/);
});

test("forgetting a mailbox drops it and moves current elsewhere", () => {
  write(TWO);
  const next = removeAccount("a@x.com", "user");

  expect(read().accounts["a@x.com"]).toBeUndefined();
  expect(read().accounts["b@x.com"]).toBeDefined();
  expect(next).toBe("b@x.com");
  expect(read().current).toBe("b@x.com");
});

test("forgetting the last mailbox leaves no current", () => {
  write({ current: "a@x.com", accounts: { "a@x.com": { base: "https://a", key: "k" } } });
  expect(removeAccount("a@x.com", "user")).toBe("");
  expect(read().current).toBe("");
});

// --- Migration from the single-mailbox format. ---------------------------------

test("a config written before multi-account support is read as one mailbox", () => {
  // Nothing may be lost here: this is what every existing install looks like.
  write({ base: "https://old", email: "old@x.com", key: "k", cursor: 42, syncDir: "/archive" });

  expect(loadConfig("user")).toMatchObject({
    email: "old@x.com", base: "https://old", key: "k", cursor: 42, syncDir: "/archive",
  });
  expect(listAccounts("user")).toMatchObject({ current: "old@x.com", names: ["old@x.com"] });
});

test("the first write converts the old shape without losing anything", () => {
  write({ base: "https://old", email: "old@x.com", key: "k", cursor: 42, syncDir: "/archive" });
  saveConfig({ cursor: 43 }, "user");

  const file = read();
  expect(file.current).toBe("old@x.com");
  expect(file.accounts["old@x.com"]).toEqual({
    base: "https://old", key: "k", cursor: 43, syncDir: "/archive",
  });
  expect(file.base).toBeUndefined();   // the flat fields are gone
});

// --- Telling the user what to do. ----------------------------------------------

test("with several mailboxes and none selected, the error names them", () => {
  write({ current: "", accounts: TWO.accounts });
  const msg = expectFail(() => requireConfig("user"));

  expect(msg).toMatch(/no mailbox selected/);
  expect(msg).toMatch(/a@x\.com/);
  expect(msg).toMatch(/b@x\.com/);
  expect(msg).toMatch(/cfmail use/);
});

test("with nothing configured at all, the error points at setup", () => {
  expect(expectFail(() => requireConfig("user"))).toMatch(/cfmail setup/);
});

test("listAccounts reports every mailbox and which is current", () => {
  write(TWO);
  const { current, names } = listAccounts("user");
  expect(current).toBe("a@x.com");
  expect(names).toEqual(["a@x.com", "b@x.com"]);
});

// --- The admin scope is separate and stays single. -----------------------------

test("the admin config is untouched by account selection", () => {
  const adminPath = join(dir, "admin.json");
  process.env.EMAIL_ADMIN_CONFIG = adminPath;
  writeFileSync(adminPath, JSON.stringify({ base: "https://svc", key: "MCP" }));
  write(TWO);
  selectAccount("b@x.com");

  expect(loadConfig("admin")).toEqual({ base: "https://svc", key: "MCP" });
  delete process.env.EMAIL_ADMIN_CONFIG;
});

// --- A hand-edited or half-written config file. --------------------------------

test("a malformed accounts field is reported, not treated as empty", () => {
  // Silently behaving as though nothing were configured would send someone
  // hunting for a lost mailbox.
  write({ accounts: "not an object" });
  const msg = expectFail(() => listAccounts("user"));
  expect(msg).toMatch(/config file is malformed/);
  expect(msg).toMatch(/accounts/);
});

test("an accounts list is rejected the same way", () => {
  write({ accounts: [] });
  expect(expectFail(() => listAccounts("user"))).toMatch(/config file is malformed/);
});

test("converting an old file drops keys that belong to the file, not the mailbox", () => {
  write({ accounts: null, base: "https://x", key: "k", cursor: 3 });
  saveConfig({ cursor: 4 }, "user");

  expect(read().accounts["(default)"]).toEqual({ base: "https://x", key: "k", cursor: 4 });
});

test("an old file with no address at all still converts", () => {
  write({ base: "https://x", key: "k" });
  expect(listAccounts("user").names).toEqual(["(default)"]);
});

test("a null account entry reads as empty rather than throwing", () => {
  write({ current: "a@x.com", accounts: { "a@x.com": null } });
  expect(listAccounts("user").names).toEqual(["a@x.com"]);
  expect(loadConfig("user")).toMatchObject({ email: "a@x.com", base: "", key: "" });
});

test("a non-string current is ignored rather than used as a name", () => {
  write({ current: 42, accounts: { "a@x.com": { base: "https://a", key: "k" } } });
  expect(loadConfig("user").email).toBe("a@x.com");
});
