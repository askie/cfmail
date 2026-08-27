// Admin commands use a separate config file and the service's admin token.
// Keeping them behind `cfmail admin ...` makes it obvious which key is in play.

import { Mcp } from "../mcp.mjs";
import { loadConfig, readStoredConfig, saveConfig, requireConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const OVERVIEW = `Usage: cfmail admin <subcommand> [options]

Administer this service with the admin token: open mailboxes, issue/revoke
keys, configure new-mail notifications. The admin token is the MCP_TOKEN set
at deploy time, stored separately from ordinary user keys.

Subcommands:
  setup --base <url> --key <admin-token>
        Configure and verify admin identity. Connects to the service to
        confirm this token can actually see the admin tools

  create-key <email>
        Open a mailbox for an address, printing a plaintext key (shown once)

  list-keys
        List the addresses that have been issued a key (never echoes the key itself)

  delete-key <email>
        Revoke that address's key, effective immediately

  webhook [--set <value> | --clear]
        No options: show the current setting; --set whk_xxx pushes new mail as
        a Grix chat message; --set https://... POSTs raw JSON to your own
        program instead; --clear turns it off

Every subcommand supports --json; failures are JSON too, with a non-zero exit code.

Examples:
  cfmail admin setup --base https://mail.example.com --key <MCP_TOKEN>
  cfmail admin create-key alice@example.com
  cfmail admin webhook --set whk_71e14a27…
  cfmail admin delete-key alice@example.com

The admin token lives in ${configPath("admin")} —
it's the highest-privilege credential, never hand it to someone who should
only read one mailbox.`;

async function adminMcp() {
  const cfg = requireConfig("admin");
  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const names = await mcp.toolNames();
  // Non-admin identities never see these tools, so their absence means the
  // configured token is an ordinary mailbox key.
  if (!names.includes("create_api_key")) {
    fail("this key is not an admin token (admin tools are not available on it)");
  }
  return mcp;
}

async function setup(argv) {
  const { opts } = parseArgs(argv, { "--base": "string", "--key": "string" });
  const cfg = loadConfig("admin");
  const base = (opts.base || cfg.base || "").replace(/\/+$/, "");
  const key = opts.key || cfg.key || "";
  if (!base) fail("missing --base <url>");
  if (!key) fail("missing --key <admin-token>");

  const mcp = await new Mcp(base, key).connect();
  const names = await mcp.toolNames();
  if (!names.includes("create_api_key")) {
    fail("connected, but this is not an admin token — admin tools are not available on it");
  }

  const path = saveConfig({ ...readStoredConfig("admin"), base, key }, "admin");
  if (isJson()) return json({ ok: true, base, config: path, tools: names });
  out(`✅ 管理员身份已验证\n服务: ${base}\n配置已保存: ${path}`);
}

async function createKey(argv) {
  const { positional } = parseArgs(argv, {});
  const email = positional[0];
  if (!email) fail("missing email. Usage: cfmail admin create-key <email>");

  const res = await (await adminMcp()).call("create_api_key", { email });
  if (!res?.ok) fail(res?.error || `could not create a key for ${email}`);
  if (isJson()) return json(res);
  out(
    `已为 ${res.email} 开通邮箱\n` +
    `API Key: ${res.api_key}\n\n` +
    `这把 Key 只显示这一次，请立刻交给使用者。对方配置方式：\n` +
    `  cfmail setup --base ${loadConfig("admin").base} --email ${res.email} --key ${res.api_key}`
  );
}

async function listKeys() {
  const res = await (await adminMcp()).call("list_api_keys");
  const keys = res?.keys || [];
  if (isJson()) return json({ ok: true, count: keys.length, keys });
  if (!keys.length) return out("还没有发放任何 Key。");
  out(`已发放 ${keys.length} 把 Key：`);
  for (const k of keys) out(`  ${k.email || k}`);
}

async function deleteKey(argv) {
  const { positional } = parseArgs(argv, {});
  const email = positional[0];
  if (!email) fail("missing email. Usage: cfmail admin delete-key <email>");

  const res = await (await adminMcp()).call("delete_api_key", { email });
  // A typo in the address must not look like a successful revocation.
  if (!res?.ok) fail(`no key found for ${email} — nothing was revoked`);
  if (isJson()) return json(res);
  out(`已吊销 ${email} 的 Key，该 Key 立即失效。`);
}

function describeWebhook(res) {
  if (!res?.webhook) return "尚未配置新邮件通知。";
  if (res.kind !== "grix") return `新邮件会 POST 到: ${res.webhook}`;
  // The key is the entire credential — anyone holding it can post to that chat.
  // A short key would show in full (and repeat its tail) if sliced blindly.
  const masked = res.webhook.length > 16
    ? `${res.webhook.slice(0, 12)}…${res.webhook.slice(-4)}`
    : `${res.webhook.slice(0, 4)}…`;
  return `新邮件会作为聊天消息推送到 Grix\nKey: ${masked}`;
}

async function webhook(argv) {
  const { opts } = parseArgs(argv, { "--set": "string", "--clear": "bool" });
  const mcp = await adminMcp();

  if (opts.clear || opts.set !== undefined) {
    const url = opts.clear ? "" : opts.set;
    const res = await mcp.call("set_webhook", { url });
    if (!res?.ok) fail(res?.error || "could not update the webhook");
    if (isJson()) return json(res);
    return out(res.webhook ? describeWebhook(res) : "新邮件通知已关闭。");
  }

  const res = await mcp.call("get_webhook");
  if (isJson()) return json({ ok: true, ...res });
  out(describeWebhook(res));
}

const SUB = {
  setup, "create-key": createKey, "list-keys": listKeys,
  "delete-key": deleteKey, webhook,
};

// Per-subcommand help, so `cfmail admin create-key --help` answers usefully
// instead of dumping the whole admin overview.
const SUB_HELP = {
  setup: `Usage: cfmail admin setup --base <service-url> --key <admin-token>

Configure the admin connection and verify it right away: connects to the
service and confirms this token can see the admin tools, giving a clear error
instead if it's an ordinary mailbox key so it never gets saved as admin config.

Options:
  --base <service-url>  Service root, no /mcp
  --key <admin-token>   The value set at deploy time with wrangler secret put MCP_TOKEN`,

  "create-key": `Usage: cfmail admin create-key <email-address>

Open a mailbox for an address, issuing an API key bound to it.

The address doesn't need to exist beforehand — the service catches mail for
the whole domain, and issuing a key just binds an address's receiving rights
to that key.

The printed key is shown only this once — hand it to the user right away.
The command also prints the config command they should run, ready to forward.

Example:
  cfmail admin create-key alice@example.com`,

  "list-keys": `Usage: cfmail admin list-keys

List the addresses that have been issued a key. Addresses only — never the
key itself; a key is shown once at issue time and the server only stores a
hash of it, which can't be turned back into the key.`,

  "delete-key": `Usage: cfmail admin delete-key <email-address>

Revoke that address's key, effective immediately — the next use gets a 401.

Errors and exits non-zero if the address doesn't exist, so a typo in a script
won't be mistaken for success.

Example:
  cfmail admin delete-key alice@example.com`,

  webhook: `Usage: cfmail admin webhook [--set <value> | --clear]

Configure where new-mail notifications go. No options: show the current setting.

Options:
  --set whk_xxx        A Grix key. New mail is pushed as a chat message to that session
  --set https://...    A plain webhook. New mail is POSTed as a raw JSON event
  --clear              Turn notifications off

The service infers which kind from the shape of the value; anything else is rejected.

Delivery is best-effort: a failure is only logged and never affects receiving
or archiving the mail itself. A redelivered copy of the same email is
deduplicated by Message-ID, so it's never pushed twice.

Examples:
  cfmail admin webhook
  cfmail admin webhook --set whk_71e14a27…
  cfmail admin webhook --set https://example.com/hook
  cfmail admin webhook --clear`,
};

// Called by the entry point with the raw args, so `cfmail admin webhook --help`
// gets the webhook help rather than this overview. Returns undefined for a
// subcommand that does not exist, letting the entry point fall through to run()
// so a typo still fails loudly instead of printing help and exiting 0.
export function help(argv = []) {
  const sub = argv.find((a) => !a.startsWith("-"));
  if (!sub) return OVERVIEW;
  return SUB_HELP[sub];
}

export async function run(argv) {
  const name = argv[0];
  if (!name || name === "--help" || name === "-h") return out(help(argv));

  const fn = SUB[name];
  if (!fn) fail(`unknown admin command: ${name}\n\n${OVERVIEW}`);

  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) return out(help(argv));
  await fn(rest);
}
