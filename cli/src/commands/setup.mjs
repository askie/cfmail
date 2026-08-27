import { Mcp } from "../mcp.mjs";
import { readStoredConfig, saveConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--base": "string", "--email": "string", "--key": "string" };

export const help = `用法: cfmail setup --base <服务地址> --email <你的邮箱> --key <API Key>

配置邮箱，并当场连服务验证，验证通过才写入本机。

参数:
  --base <服务地址>   服务根地址，例如 https://mail.example.com，不要带 /mcp
  --email <你的邮箱>  这把 Key 绑定的收件地址
  --key <API Key>     32 位十六进制字符串，由服务管理员用 create-key 发放

改其中一项时只给那一项，其余保持不变:
  cfmail setup --key <新Key>        只换密钥

一份配置文件 = 一个邮箱。再收一个邮箱就再开一份，两份完全独立:

  export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
  cfmail setup --base <服务地址> --email work@example.com --key <Key>

示例:
  cfmail setup --base https://mail.example.com --email me@example.com --key 3f2a…
  cfmail config                     看这份配置现在是什么

配置文件: ${configPath("user")}（权限 600，Key 只存在本机）
环境变量可临时覆盖: EMAIL_INBOX_CONFIG 换配置文件，EMAIL_INBOX_BASE / EMAIL_INBOX_KEY 覆盖凭据`;

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);

  // Changing one setting only needs that flag, so start from what is stored and
  // let the given flags win.
  const stored = readStoredConfig("user");
  const email = (opts.email || stored.email || "").trim();
  const base = (opts.base || stored.base || "").replace(/\/+$/, "");
  const key = opts.key || stored.key || "";
  if (!email) fail("missing --email <address>: it names the mailbox this key belongs to");
  if (!base) fail("missing --base <url>");
  if (!key) fail("missing --key <api-key>");

  // Verify before saving, so a typo never gets persisted as a working setup.
  const mcp = await new Mcp(base, key).connect();
  const names = await mcp.toolNames();
  if (!names.includes("list_emails")) {
    fail("connected, but this key cannot read mail — is it the right key for this service?");
  }
  const stats = await mcp.call("stats");

  const path = saveConfig({ base, key, email }, "user");

  if (isJson()) {
    return json({ ok: true, base, email, config: path, tools: names, visible: stats?.total ?? 0 });
  }
  out(
    `✅ Connected\n` +
    `服务: ${base}\n` +
    `邮箱: ${email}\n` +
    `可见邮件: ${stats?.total ?? 0} 封\n` +
    `配置已保存: ${path}\n` +
    (names.includes("send_email") ? `发信: 可用\n` : `发信: 服务端未开放\n`)
  );
}
