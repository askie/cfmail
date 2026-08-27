import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStoredConfig, loadConfig } from "../config.mjs";
import { MARKER, mailboxDir, isDayDir } from "../archive.mjs";
import { acquireLock, lockHolder } from "../lock.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--dir": "string", "--older-than": "string", "--yes": "bool", "--dry-run": "bool" };

export const help = `Usage: cfmail prune --older-than <age> [--dir <path>] [--yes]

Delete local archive entries older than the given age. Local only — nothing
on the server is ever touched.

Only cleans up this config's mailbox's archive (under <dir>/<mailbox>/) —
other mailboxes sharing the same directory are untouched.

Options:
  --older-than <age>  Required. A number plus a unit: d=days w=weeks(7d)
                      m=months(30d) y=years(365d)
  --dir <path>        Which directory to clean. Defaults to the one sync remembered
  --yes               Actually delete. Without it, this is a dry run
  --dry-run           Explicit dry run (already the default behavior)

Deletion is irreversible, so the default is to only report what would be
deleted. Add --yes once the list looks right.

Two safeguards against deleting the wrong thing:
  · Only acts inside a directory sync has marked as an archive (it has a
    .cfmail-archive file at its root) — pointing --dir somewhere else is
    flatly refused
  · Only deletes date folders (YYYY-MM-DD) — any other file you keep in the
    same directory is left alone

Judged by the email's own date, not the file's modification time, so copying
or restoring a backup can't make an archive "look new again". A day only
counts once it's fully elapsed, so --older-than 30d never deletes mail from
day 30 itself.

Examples:
  cfmail prune --older-than 90d           dry run, see what would be deleted
  cfmail prune --older-than 90d --yes     delete for real
  cfmail prune --older-than 6m --dir ~/cfmail --yes

An actual delete run is mutually exclusive with sync: if sync is writing to
this directory, this run is skipped rather than deleting mail mid-write.

Drop it into cron to run on its own:
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
