import { test, expect, vi } from "vitest";
import {
  listEmails,
  searchEmails,
  stats,
  getEmail,
  getAttachment,
  createApiKey,
  deleteApiKey,
  sha256Hex,
} from "../src/store";

// --- SQL shape guards: the isolation filter must use exact-token instr() matching
// (NOT substring LIKE), and must bind the lowercased address. -------------------

test("listEmails filters by exact recipient and lowercases the bound address", async () => {
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  const env = { DB: { prepare } } as any;

  await listEmails(env, {}, "User@Example.com");

  expect(prepare).toHaveBeenCalledWith(
    expect.stringContaining("instr(', ' || lower(to_addr) || ', ', ', ' || lower(?) || ', ')")
  );
  // No '%' wildcards, address lowercased.
  expect(bind).toHaveBeenCalledWith("user@example.com", "user@example.com", 20, 0);
});

test("searchEmails (short query) filters by exact recipient", async () => {
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  const env = { DB: { prepare } } as any;

  await searchEmails(env, "ab", 20, "user@example.com");

  expect(prepare).toHaveBeenCalledWith(
    expect.stringContaining("instr(', ' || lower(to_addr) || ', ', ', ' || lower(?) || ', ')")
  );
  expect(bind).toHaveBeenCalledWith("%ab%", "%ab%", "user@example.com", "user@example.com", 20);
});

test("searchEmails (long query) filters by exact recipient on the joined table", async () => {
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn().mockReturnValue({ all });
  const prepare = vi.fn().mockReturnValue({ bind });
  const env = { DB: { prepare } } as any;

  await searchEmails(env, "invoice", 20, "user@example.com");

  expect(prepare).toHaveBeenCalledWith(
    expect.stringContaining("emails_fts MATCH ? AND (instr(', ' || lower(e.to_addr)")
  );
  expect(bind).toHaveBeenCalledWith("invoice", "user@example.com", "user@example.com", 20);
});

test("stats filters by exact recipient and lowercases the bound address", async () => {
  const first = vi.fn().mockResolvedValue({ total: 0 });
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind });
  const env = { DB: { prepare } } as any;

  await stats(env, "User@Example.com");

  expect(prepare).toHaveBeenCalledWith(
    expect.stringContaining("instr(', ' || lower(to_addr) || ', ', ', ' || lower(?) || ', ')")
  );
  expect(bind).toHaveBeenCalledWith("user@example.com", "user@example.com");
});

// --- Behavioral isolation guards: getEmail / getAttachment must enforce exact
// recipient membership in memory, with NO substring leakage. --------------------

function dbWith(rowsBySqlFragment: { match: string; row: any }[]) {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => rowsBySqlFragment.find((h) => sql.includes(h.match))?.row ?? null,
        all: async () => ({ results: [] }),
      }),
    }),
  };
}

test("getEmail allows the exact To recipient (one of several)", async () => {
  const env = {
    DB: dbWith([
      { match: "FROM emails WHERE id", row: { id: "e1", to_addr: "usera@example.com, other@example.com", cc_addr: null } },
    ]),
    BUCKET: { get: async () => null },
  } as any;
  const r = await getEmail(env, "e1", false, "usera@example.com");
  expect(r).not.toBeNull();
  expect(r!.id).toBe("e1");
});

test("getEmail allows a CC recipient and is case-insensitive", async () => {
  const env = {
    DB: dbWith([
      { match: "FROM emails WHERE id", row: { id: "e3", to_addr: "other@example.com", cc_addr: "UserA@Example.com" } },
    ]),
    BUCKET: { get: async () => null },
  } as any;
  const r = await getEmail(env, "e3", false, "usera@example.com");
  expect(r).not.toBeNull();
});

test("getEmail denies a non-recipient and does NOT leak via substring (xusera vs usera)", async () => {
  const env = {
    DB: dbWith([
      { match: "FROM emails WHERE id", row: { id: "e4", to_addr: "xusera@example.com", cc_addr: null } },
    ]),
    BUCKET: { get: async () => null },
  } as any;
  const r = await getEmail(env, "e4", false, "usera@example.com");
  expect(r).toBeNull();
});

test("getAttachment denies access when the user is not a recipient of the parent email", async () => {
  const env = {
    DB: dbWith([
      { match: "FROM attachments WHERE id", row: { id: "a1", email_id: "e2", r2_key: "k", filename: "f", content_type: "t", size: 1 } },
      { match: "FROM emails WHERE id", row: { to_addr: "userb@example.com", cc_addr: null } },
    ]),
    BUCKET: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) },
  } as any;
  const r = await getAttachment(env, "a1", "usera@example.com");
  expect(r).toBeNull();
});

// --- API key storage guards: only the hash is persisted; delete binds the email. -

test("createApiKey returns plaintext but persists only its SHA-256 hash", async () => {
  let bound: any[] = [];
  const env = {
    DB: { prepare: () => ({ bind: (...a: any[]) => ((bound = a), { run: async () => ({ success: true }) }) }) },
  } as any;

  const key = await createApiKey(env, "u@e.com");
  expect(key).toMatch(/^[0-9a-f]{32}$/);
  expect(bound[0]).not.toBe(key); // not stored in plaintext
  expect(bound[0]).toBe(await sha256Hex(key)); // stored as hash
  expect(bound[1]).toBe("u@e.com");
});

test("deleteApiKey binds the email and reports whether a row was removed", async () => {
  let bound: any;
  const env = {
    DB: { prepare: () => ({ bind: (e: string) => ((bound = e), { run: async () => ({ meta: { changes: 1 } }) }) }) },
  } as any;

  const ok = await deleteApiKey(env, "u@e.com");
  expect(bound).toBe("u@e.com");
  expect(ok).toBe(true);
});

test("deleteApiKey reports false when nothing matched", async () => {
  const env = {
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }) },
  } as any;
  expect(await deleteApiKey(env, "missing@e.com")).toBe(false);
});
