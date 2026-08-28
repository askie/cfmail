import { test, expect } from "vitest";

const { EmailMCP } = await import("../src/mcp");

// The cfmail CLI decides whether a token is an admin one by looking for
// `create_api_key` in tools/list. That makes tool *visibility* a contract, not
// just a convenience — if admin tools were ever registered for everyone and
// gated only inside the handler, the CLI would silently misjudge identity.

function collectTools(props: Record<string, unknown>, env: any = {}) {
  const names: string[] = [];
  const handlers: Record<string, Function> = {};
  const mcp = Object.create(EmailMCP.prototype) as any;
  mcp.props = props;
  mcp.env = env;
  mcp.server = {
    tool: (name: string, _desc: string, _schema: unknown, fn: Function) => {
      names.push(name);
      handlers[name] = fn;
    },
  };
  return { mcp, names, handlers };
}

// The tool answers with a JSON string in a text block.
const result = (r: any) => JSON.parse(r.content[0].text);

function dbStub() {
  const store: Record<string, string> = {};
  return {
    store,
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => (sql.includes("SELECT") ? (store[args[0]] ? { value: store[args[0]] } : null) : null),
        run: async () => {
          if (sql.includes("DELETE")) delete store[args[0]];
          else store[args[0]] = args[1];
          return {};
        },
      }),
    }),
  };
}

const ADMIN_ONLY = ["create_api_key", "list_api_keys", "delete_api_key", "get_webhook", "set_webhook"];

test("a mailbox key sees the read and send tools but no admin tool", async () => {
  const { mcp, names } = collectTools({ email: "user@example.com" });
  await mcp.init();

  expect(names).toContain("list_emails");
  expect(names).toContain("send_email");
  expect(names).toContain("list_sent");
  expect(names).toContain("sent_stats");
  for (const t of ADMIN_ONLY) expect(names).not.toContain(t);
});

test("the admin identity sees the admin tools", async () => {
  const { mcp, names } = collectTools({ isAdmin: true });
  await mcp.init();

  for (const t of ADMIN_ONLY) expect(names).toContain(t);
});

test("an empty email string is not treated as a bound mailbox", async () => {
  const { mcp } = collectTools({ email: "" });
  await mcp.init();
  expect(mcp.userEmail).toBeUndefined();
});

// --- set_webhook accepts exactly two shapes. ----------------------------------

test("a Grix key is accepted and reported with its expanded endpoint", async () => {
  const db = dbStub();
  const { mcp, handlers } = collectTools({ isAdmin: true }, { DB: db });
  await mcp.init();

  const r = result(await handlers.set_webhook({ url: "whk_abc123" }));
  expect(r).toMatchObject({
    ok: true, webhook: "whk_abc123", webhook_url: "whk_abc123", kind: "grix",
    target: "https://grix.dhf.pub/v1/webhook/incoming/whk_abc123",
  });

  expect(result(await handlers.get_webhook({}))).toMatchObject({ webhook: "whk_abc123", kind: "grix" });
});

test("a plain URL is still accepted and reported as such", async () => {
  const db = dbStub();
  const { mcp, handlers } = collectTools({ isAdmin: true }, { DB: db });
  await mcp.init();

  const r = result(await handlers.set_webhook({ url: "https://example.com/hook" }));
  expect(r).toMatchObject({ ok: true, kind: "url", target: "https://example.com/hook" });
});

test("anything that is neither a key nor a URL is rejected", async () => {
  const db = dbStub();
  const { mcp, handlers } = collectTools({ isAdmin: true }, { DB: db });
  await mcp.init();

  const r = result(await handlers.set_webhook({ url: "grix.dhf.pub/hook" }));
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/whk_|http/);
  expect(Object.keys(db.store)).toHaveLength(0);
});

test("clearing reports every field as null, so the shape never varies", async () => {
  const db = dbStub();
  const { mcp, handlers } = collectTools({ isAdmin: true }, { DB: db });
  await mcp.init();

  await handlers.set_webhook({ url: "whk_abc123" });
  const r = result(await handlers.set_webhook({ url: "" }));
  expect(r).toEqual({ ok: true, webhook: null, webhook_url: null, kind: null, target: null });
});
