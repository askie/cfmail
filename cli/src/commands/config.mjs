import { readStoredConfig, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, isJson, formatDate } from "../output.mjs";

export const help = `用法: cfmail config

看这份配置里当前是哪个邮箱、连的哪个服务、归档到哪、有没有开推送。
不会打印 API Key。

一份配置文件 = 一个邮箱。想在同一台机器上再收一个邮箱，给它另开一份配置：

  export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
  cfmail setup --base <服务地址> --email work@example.com --key <Key>

两份配置的密钥、未读游标、归档目录、推送设置完全分开，互相看不见，
所以两个程序各设各的 EMAIL_INBOX_CONFIG 就不会串。

不想要某个邮箱了，删掉它那份配置文件即可（不影响服务端，也不吊销 Key）。

配置文件: ${configPath("user")}`;

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
