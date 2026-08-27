import { Mcp } from "../mcp.mjs";
import { readStoredConfig, saveConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--base": "string", "--email": "string", "--key": "string" };

export const help = `Usage: cfmail setup --base <service-url> --email <your-address> --key <api-key>

Configure a mailbox, verifying against the service right away — only written
to disk once the check passes.

Options:
  --base <service-url>    Service root, e.g. https://mail.example.com — no /mcp
  --email <your-address>  The address this key is bound to
  --key <api-key>         32-char hex string, issued by an admin with create-key

Changing one setting only needs that flag, everything else stays as it is:
  cfmail setup --key <new-key>      swap just the key

One config file = one mailbox. Adding another mailbox means opening another
config file, fully independent of this one:

  export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
  cfmail setup --base <service-url> --email work@example.com --key <key>

Examples:
  cfmail setup --base https://mail.example.com --email me@example.com --key 3f2a…
  cfmail config                     see what this config currently points at

Config file: ${configPath("user")} (mode 600, the key never leaves this machine)
Environment overrides: EMAIL_INBOX_CONFIG switches config file, EMAIL_INBOX_BASE / EMAIL_INBOX_KEY override credentials`;

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
