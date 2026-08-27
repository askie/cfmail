import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStoredConfig, loadConfig } from "../config.mjs";
import { MARKER, mailboxDir, isDayDir } from "../archive.mjs";
import { acquireLock, lockHolder } from "../lock.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--dir": "string", "--older-than": "string", "--yes": "bool", "--dry-run": "bool" };

export const help = `用法: cfmail prune --older-than <期限> [--dir <目录>] [--yes]

删除本地归档里超过指定时长的邮件。只删本地，服务器上的邮件一封都不动。

只清理当前邮箱的归档（<目录>/<邮箱>/ 下面），同一个目录下别的邮箱不受影响。

参数:
  --older-than <期限>  必需。数字加单位: d=天 w=周(7天) m=月(30天) y=年(365天)
  --dir <目录>         要清理的目录。默认用 sync 记住的那个
  --yes                真正删除。不给就只是预演
  --dry-run            显式预演（本来就是默认行为）

删除不可逆，所以默认只报告会删什么。看清单没问题了再加 --yes。

两道防误删:
  · 只在 sync 标记过的归档目录里动手（根目录有 .cfmail-archive 文件），
    --dir 指错地方会直接拒绝
  · 只删日期目录（YYYY-MM-DD），你放在同一目录下的其它文件不会被碰

按邮件自身日期判断，不看文件修改时间，所以拷贝或恢复备份不会让归档「重新变新」。
整天都过期才删，所以 --older-than 30d 不会删掉第 30 天那天的邮件。

示例:
  cfmail prune --older-than 90d           预演，看看会删什么
  cfmail prune --older-than 90d --yes     确认后真删
  cfmail prune --older-than 6m --dir ~/cfmail --yes

真正删除时会和 sync 互斥：sync 正在写这个目录就跳过这次，不会删到一半的邮件。

放进 cron 自动跑:
  0 4 * * *  cfmail sync && cfmail prune --older-than 90d --yes`;

const UNITS = { d: 1, w: 7, m: 30, y: 365 };

function parseAge(text) {
  const m = /^(\d+)\s*([dwmy])$/i.exec((text || "").trim());
  if (!m) fail(`--older-than expects a number plus d/w/m/y, for example 30d or 6m (got: ${text})`);
  return Number(m[1]) * UNITS[m[2].toLowerCase()] * 86400_000;
}

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const stored = readStoredConfig("user");
  const root = opts.dir || stored.syncDir;

  if (!root) fail("no archive folder. Pass --dir <path>, or run `cfmail sync --dir <path>` first.");
  if (!opts.olderThan) fail("missing --older-than <age>, for example --older-than 90d");
  if (!existsSync(root)) fail(`archive folder does not exist: ${root}`);
  // Refuse to delete anywhere `cfmail sync` has not written. Without this, a
  // --dir typo pointing at a folder that happens to hold date-named directories
  // would wipe them.
  if (!existsSync(join(root, MARKER))) {
    fail(
      `${root} is not a cfmail archive (no ${MARKER}).\n` +
      `Run \`cfmail sync --dir ${root}\` first, or point --dir at the right folder.`
    );
  }

  // Clean only the mailbox in play, mirroring how sync files mail. Another
  // mailbox's archive under the same root is none of this run's business.
  const cfg = loadConfig("user");
  const dir = mailboxDir(root, cfg.email);
  if (!existsSync(dir)) {
    if (isJson()) return json({ ok: true, root, mailbox: cfg.email, days: 0, emails: 0, removed: [] });
    return out(`${cfg.email} 在 ${root} 下还没有归档，无需清理。`);
  }

  // Deleting while a sync is writing could take a folder out from under it.
  // A dry run only reads, so it never waits.
  const apply0 = opts.yes && !opts.dryRun;
  let lock = null;
  if (apply0) {
    lock = acquireLock(dir);
    if (!lock) {
      const other = lockHolder(dir);
      const age = other?.age != null ? `${Math.round(other.age / 1000)} 秒前开始` : "正在运行";
      if (isJson()) return json({ ok: true, skipped: "locked", dir, holder: other?.pid ?? null });
      return out(`另一个 cfmail 正在用这个目录（${age}），这次跳过。\n目录: ${dir}`);
    }
  }

  try {
    return pruneWithLock(opts, root, dir, cfg.email);
  } finally {
    lock?.release();
  }
}

function pruneWithLock(opts, root, dir, mailbox) {
  const cutoff = Date.now() - parseAge(opts.olderThan);
  const doomed = [];

  for (const name of readdirSync(dir)) {
    if (!isDayDir(name)) continue;
    const dayPath = join(dir, name);
    if (!statSync(dayPath).isDirectory()) continue;
    // The folder name is the mail's own date, which is what should age out —
    // not the file mtime, which a copy or restore would reset.
    if (Date.parse(`${name}T23:59:59`) >= cutoff) continue;

    const mails = readdirSync(dayPath).filter((f) => statSync(join(dayPath, f)).isDirectory());
    doomed.push({ day: name, path: dayPath, count: mails.length });
  }

  const total = doomed.reduce((n, d) => n + d.count, 0);
  const apply = opts.yes && !opts.dryRun;

  if (apply) for (const d of doomed) rmSync(d.path, { recursive: true, force: true });

  if (isJson()) {
    return json({
      ok: true, root, dir, mailbox, older_than: opts.olderThan, applied: apply,
      days: doomed.length, emails: total, removed: doomed.map((d) => d.day),
    });
  }

  if (!doomed.length) return out(`没有早于 ${opts.olderThan} 的归档，${dir} 无需清理。`);
  out(
    `${apply ? "已删除" : "将删除"} ${doomed.length} 天共 ${total} 封归档邮件\n` +
    `目录: ${dir}`
  );
  for (const d of doomed.slice(0, 10)) out(`  ${d.day}  (${d.count} 封)`);
  if (doomed.length > 10) out(`  …还有 ${doomed.length - 10} 天`);
  if (!apply) out(`\n这是预演，没有动任何文件。确认无误后加 --yes 真正删除。`);
}
