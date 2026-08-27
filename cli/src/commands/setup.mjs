import { Mcp } from "../mcp.mjs";
import { loadConfig, saveConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--base": "string", "--email": "string", "--key": "string" };

export const help = `cfmail setup --base <url> --email <address> --key <api-key>

Store the connection and verify it against the service. The key is written to
${configPath("user")} with owner-only permissions.`;

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

  const path = saveConfig({ ...cfg, base, email, key }, "user");

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
