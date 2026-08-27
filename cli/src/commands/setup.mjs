import { Mcp } from "../mcp.mjs";
import { loadConfig, readStoredConfig, saveConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--base": "string", "--email": "string", "--key": "string" };

export const help = `用法: cfmail setup --base <服务地址> --email <你的邮箱> --key <API Key>

配置连接信息，并当场连服务验证，验证通过才写入本机。

参数:
  --base <服务地址>   服务根地址，例如 https://mail.example.com，不要带 /mcp
  --email <你的邮箱>  这把 Key 绑定的收件地址。仅用于显示，权限由 Key 决定
  --key <API Key>     32 位十六进制字符串，由服务管理员用 create-key 发放

三个参数在首次配置时都要给；之后只想改其中一项，单独给那一项即可。

示例:
  cfmail setup --base https://mail.example.com --email me@example.com --key 3f2a…

配置文件: ${configPath("user")}（权限 600，Key 只存在本机）
环境变量可临时覆盖: EMAIL_INBOX_BASE / EMAIL_INBOX_EMAIL / EMAIL_INBOX_KEY`;

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = loadConfig("user");

  const base = (opts.base || cfg.base || "").replace(/\/+$/, "");
  const key = opts.key || cfg.key || "";
  const email = opts.email || cfg.email || "";
  if (!base) fail("missing --base <url>");
  if (!key) fail("missing --key <api-key>");

  // Verify before saving, so a typo never gets persisted as a working setup.
  const mcp = await new Mcp(base, key).connect();
  const names = await mcp.toolNames();
  if (!names.includes("list_emails")) {
    fail("connected, but this key cannot read mail — is it the right key for this service?");
  }
  const stats = await mcp.call("stats");

  const path = saveConfig({ ...readStoredConfig("user"), base, email, key }, "user");

  if (isJson()) return json({ ok: true, base, email, config: path, tools: names, visible: stats?.total ?? 0 });
  out(
    `✅ Connected\n` +
    `服务: ${base}\n` +
    `邮箱: ${email || "(未填，仅用于显示)"}\n` +
    `可见邮件: ${stats?.total ?? 0} 封\n` +
    `配置已保存: ${path}\n` +
    (names.includes("send_email") ? `发信: 可用\n` : `发信: 服务端未开放\n`)
  );
}
