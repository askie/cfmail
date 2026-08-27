import { test, expect, vi } from "vitest";

// The agents SDK pulls in `cloudflare:*` modules that Node's loader cannot
// resolve. Only the base class matters here, so stub it out.
vi.mock("agents/mcp", () => ({ McpAgent: class {} }));

const { EmailMCP } = await import("../src/mcp");

// The cfmail CLI decides whether a token is an admin one by looking for
// `create_api_key` in tools/list. That makes tool *visibility* a contract, not
// just a convenience — if admin tools were ever registered for everyone and
// gated only inside the handler, the CLI would silently misjudge identity.

function collectTools(props: Record<string, unknown>) {
  const names: string[] = [];
  const mcp = Object.create(EmailMCP.prototype) as any;
  mcp.props = props;
  mcp.env = {};
  mcp.server = { tool: (name: string) => names.push(name) };
  return { mcp, names };
}

const ADMIN_ONLY = ["create_api_key", "list_api_keys", "delete_api_key", "get_webhook", "set_webhook"];

test("a mailbox key sees the read and send tools but no admin tool", async () => {
  const { mcp, names } = collectTools({ email: "user@example.com" });
  await mcp.init();

  expect(names).toContain("list_emails");
  expect(names).toContain("send_email");
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
