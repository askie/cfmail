// Admin commands use a separate config file and the service's admin token.
// Keeping them behind `cfmail admin ...` makes it obvious which key is in play.

import { Mcp } from "../mcp.mjs";
import { loadConfig, readStoredConfig, saveConfig, requireConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

export const help = `cfmail admin <command>

  setup --base <url> --key <admin-token>   store and verify the admin connection
  create-key <email>                       issue a mailbox key bound to that address
  list-keys                                list issued keys
  delete-key <email>                       revoke that address's key
  webhook                                  show where new-mail notifications go
  webhook --set whk_xxx                    send them to Grix as chat messages
  webhook --set https://...                POST the raw JSON event there instead
  webhook --clear                          turn notifications off

The admin token is stored separately from user keys, in
${configPath("admin")}. Never hand it to someone who should only read one mailbox.`;

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
  return res.kind === "grix"
    ? `新邮件会作为聊天消息推送到 Grix\nKey: ${res.webhook}`
    : `新邮件会 POST 到: ${res.webhook}`;
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

export async function run(argv) {
  const name = argv[0];
  if (!name || name === "--help" || name === "-h") return out(help);
  const fn = SUB[name];
  if (!fn) fail(`unknown admin command: ${name}\n\n${help}`);
  await fn(argv.slice(1));
}
