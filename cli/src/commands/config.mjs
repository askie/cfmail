import { readStoredConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate } from "../output.mjs";

export const help = `Usage: cfmail config

See which mailbox this config currently points at, which service it connects
to, where it archives to, and whether push is on. Never prints the API key.

One config file = one mailbox. To receive a second mailbox on the same
machine, give it its own config file:

  export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
  cfmail setup --base <service-url> --email work@example.com --key <key>

The two configs' keys, unread cursors, archive directories, and push settings
are completely separate and invisible to each other, so two programs each
pointing at their own EMAIL_INBOX_CONFIG never collide.

Don't want a mailbox anymore? Just delete its config file (the server side
and the key are untouched).

Config file: ${configPath("user")}`;

export async function run(argv) {
  parseArgs(argv, {});
  const cfg = readStoredConfig("user");
  const path = configPath("user");

  if (isJson()) {
    return json({
      ok: true,
      config: path,
      email: cfg.email || null,
      base: cfg.base || null,
      configured: !!(cfg.base && cfg.key),
      sync_dir: cfg.syncDir || null,
      notify: !!cfg.notifyKey,
      cursor: cfg.cursor || null,
    });
  }

  if (!cfg.base || !cfg.key) {
    return out(
      `这份配置还没配好: ${path}\n\n` +
      `  cfmail setup --base <服务地址> --email <你的邮箱> --key <你的Key>`
    );
  }

  out(`邮箱: ${cfg.email || "(未记录)"}`);
  out(`服务: ${cfg.base}`);
  out(`归档: ${cfg.syncDir || "(未设置，cfmail sync --dir <目录> 开启)"}`);
  out(`推送: ${cfg.notifyKey ? "已开启（新邮件推送到 Grix）" : "未开启"}`);
  if (cfg.cursor) out(`未读游标: ${formatDate(cfg.cursor)} 之前的都算已读`);
  out(`配置文件: ${path}`);
}
