// Admin commands use a separate config file and the service's admin token.
// Keeping them behind `cfmail admin ...` makes it obvious which key is in play.

import { Mcp } from "../mcp.mjs";
import { loadConfig, readStoredConfig, saveConfig, requireConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const OVERVIEW = `用法: cfmail admin <子命令> [参数]

用管理员令牌管理这台服务：开通邮箱、签发/吊销密钥、配置新邮件通知。
管理员令牌就是部署时设置的 MCP_TOKEN，与普通用户的 Key 分开存放。

子命令:
  setup --base <地址> --key <管理员令牌>
        配置并验证管理员身份。会连服务确认这把钥匙确实能看到管理工具

  create-key <邮箱>
        给某个地址开通邮箱，打印一把明文 Key（只显示这一次）

  list-keys
        列出已发放 Key 的邮箱地址（不回显密钥本身）

  delete-key <邮箱>
        吊销该地址的 Key，立即失效

  webhook [--set <值> | --clear]
        不带参数看当前设置；--set whk_xxx 把新邮件推成 Grix 聊天消息；
        --set https://... 改为 POST 原始 JSON 给你自己的程序；--clear 关闭

任何子命令都支持 --json，失败时也是 JSON 且退出码非 0。

示例:
  cfmail admin setup --base https://mail.example.com --key <MCP_TOKEN>
  cfmail admin create-key alice@example.com
  cfmail admin webhook --set whk_71e14a27…
  cfmail admin delete-key alice@example.com

管理员令牌存在 ${configPath("admin")}，
它是最高权限凭证，绝不能交给只该读一个邮箱的人。`;

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
  setup: `用法: cfmail admin setup --base <服务地址> --key <管理员令牌>

配置管理员连接并当场验证：连上服务后确认这把钥匙确实能看到管理工具，
是普通邮箱 Key 的话会明确报错，不会被误存成管理员配置。

参数:
  --base <服务地址>    服务根地址，不带 /mcp
  --key <管理员令牌>   部署时 wrangler secret put MCP_TOKEN 设的那个值`,

  "create-key": `用法: cfmail admin create-key <邮箱地址>

给一个地址开通邮箱，签发绑定到它的 API Key。

地址不需要预先创建：服务对整个域名 catch-all 收信，签发 Key 就是把某个地址的
收件权限绑给这把 Key。

打印出来的 Key 只显示这一次，请立刻交给使用者。命令会顺带打印对方该跑的
配置命令，直接转给他即可。

示例:
  cfmail admin create-key alice@example.com`,

  "list-keys": `用法: cfmail admin list-keys

列出已经发放过 Key 的邮箱地址。只列地址，不回显密钥本身——密钥在签发时
只显示那一次，服务端存的是哈希，取不回来。`,

  "delete-key": `用法: cfmail admin delete-key <邮箱地址>

吊销某个地址的 Key，立即失效，对方再用会收到 401。

地址不存在时会报错并以非 0 退出，所以放进脚本时打错地址不会被当成成功。

示例:
  cfmail admin delete-key alice@example.com`,

  webhook: `用法: cfmail admin webhook [--set <值> | --clear]

配置新邮件到达时通知到哪。不带参数就是查看当前设置。

参数:
  --set whk_xxx        Grix key。新邮件会作为一条聊天消息推送到对应会话
  --set https://...    普通 webhook。新邮件会以原始 JSON 事件 POST 过去
  --clear              关闭通知

服务按值的形态自动判断类型，其它形态一律拒绝。

推送是尽力而为的：失败只记日志，绝不会影响邮件本身的接收和存档。同一封邮件被
重复投递时用 Message-ID 去重，不会推成两条。

示例:
  cfmail admin webhook
  cfmail admin webhook --set whk_71e14a27…
  cfmail admin webhook --set https://example.com/hook
  cfmail admin webhook --clear`,
};

// Called by the entry point with the raw args, so `cfmail admin webhook --help`
// gets the webhook help rather than this overview.
export function help(argv = []) {
  const sub = argv.find((a) => !a.startsWith("-"));
  return (sub && SUB_HELP[sub]) || OVERVIEW;
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
