import { Mcp } from "../mcp.mjs";
import { loadConfig, readStoredConfig, saveConfig, configPath, setCurrentAccount, listAccounts } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--base": "string", "--email": "string", "--key": "string" };

export const help = `用法: cfmail setup --base <服务地址> --email <你的邮箱> --key <API Key>

配置一个邮箱，并当场连服务验证，验证通过才写入本机。配好之后它成为当前邮箱。

参数:
  --base <服务地址>   服务根地址，例如 https://mail.example.com，不要带 /mcp
  --email <你的邮箱>  这把 Key 绑定的收件地址。同时是这个邮箱在本机的名字
  --key <API Key>     32 位十六进制字符串，由服务管理员用 create-key 发放

一台机器可以配多个邮箱：对每个邮箱各跑一次 setup 即可。它们各有自己的密钥、
未读游标、归档目录和通知设置，互不干扰。

  cfmail accounts          看本机配了哪些
  cfmail use <邮箱>         切换当前邮箱
  任何命令加 --email <地址>  本次用这个邮箱，不改当前设置

更新已有邮箱的某一项时，只给要改的那项加上 --email 指明是哪个即可。

示例:
  cfmail setup --base https://mail.example.com --email me@example.com --key 3f2a…
  cfmail setup --email me@example.com --key <新Key>        只换密钥

配置文件: ${configPath("user")}（权限 600，Key 只存在本机）
环境变量可临时覆盖: EMAIL_INBOX_EMAIL 选邮箱，EMAIL_INBOX_BASE / EMAIL_INBOX_KEY 覆盖凭据`;

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);

  // Updating an existing mailbox only needs the fields being changed, so start
  // from whatever is already stored for the address in play.
  const known = listAccounts("user");
  const email = (opts.email || known.current || "").trim();
  const stored = (email && known.accounts[email]) || {};
  const cfg = email ? stored : loadConfig("user");

  const base = (opts.base || cfg.base || "").replace(/\/+$/, "");
  const key = opts.key || cfg.key || "";
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

  const path = saveConfig({ ...stored, base, key, email }, "user");
  setCurrentAccount(email, "user");
  const total = listAccounts("user").names.length;

  if (isJson()) {
    return json({ ok: true, base, email, config: path, tools: names, visible: stats?.total ?? 0, accounts: total });
  }
  out(
    `✅ Connected\n` +
    `服务: ${base}\n` +
    `邮箱: ${email}\n` +
    `可见邮件: ${stats?.total ?? 0} 封\n` +
    `配置已保存: ${path}\n` +
    (names.includes("send_email") ? `发信: 可用\n` : `发信: 服务端未开放\n`) +
    (total > 1 ? `\n本机共 ${total} 个邮箱，当前是这个。切换用 cfmail use <邮箱>\n` : "")
  );
}
