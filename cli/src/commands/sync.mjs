import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { isGrixKey, buildMessage, sendToGrix } from "../notify.mjs";
import { htmlToMarkdown } from "../html2md.mjs";
import { acquireLock, lockHolder } from "../lock.mjs";
import { MARKER, mailboxDir, migrateFlatArchive, isDayDir, mailFolderName, renameSubjectFolders } from "../archive.mjs";
import { Mcp } from "../mcp.mjs";
import { requireConfig, readStoredConfig, saveConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate } from "../output.mjs";

const SPEC = {
  "--dir": "string", "--limit": "number", "--all": "bool", "--html": "bool", "--dry-run": "bool",
  "--notify": "string", "--no-notify": "bool",
};

export const help = `Usage: cfmail sync [--dir <path>] [options]

Archive mail — body plus attachments — to a local directory, laid out by day.

What it looks like on disk:
  <dir>/me@example.com/2026-08-27/0930-3f8a2c1b04/
      meta.json          sender, recipients, subject, date, attachment list
      body.txt           plain-text body
      body.md            only when the email has no plain-text body: HTML converted to Markdown
      body.html          only with --html
      attachments/       attachments, original filenames kept

Filed by mailbox first, then by day. Several mailboxes can share one --dir —
each stays in its own place and nothing gets mixed up.

The folder name is "time + a hash of the email's identity", not the subject —
a subject is arbitrary text a sender wrote, and using it as a filename always
runs into edge cases; the full subject is in meta.json. The hash comes from
the email's own Message-ID, so the same email always lands in the same folder
no matter how many times it's redelivered.

Already-archived mail is skipped, so running this repeatedly is cheap — good
for a scheduled job. Paginates automatically no matter how large the mailbox is.

Older versions put day folders directly at the root (before filing by
mailbox existed). The first run of the new version moves them under the
mailbox automatically, with nothing lost.

Options:
  --dir <path>   Where to archive to. Remembered after the first time you give
                 it, so later runs are just cfmail sync
  --all          Re-check the whole mailbox instead of only what's new since
                 the last sync
  --limit N      How many per page, 1-100, default 100. Only affects paging
                 granularity, not completeness
  --html         Also store the HTML body
  --dry-run      Report what would be stored, without touching disk
  --notify <whk_key>
                 After archiving, push each new email to Grix with a clickable
                 local file:// link to its attachments. Remembered after the
                 first time you give it
  --no-notify    Skip pushing for this run

Combined with --dry-run, nothing is actually pushed and a given --notify key
isn't remembered either.

An email whose attachments couldn't be fully fetched isn't marked archived —
the next run retries it.

A pushed email's folder gets a .notified marker, so the same email is only
ever pushed once — running sync repeatedly won't spam you again.

Only one sync runs against a given archive directory at a time. A collision
is skipped, not treated as a failure, so a scheduled job with an interval
shorter than one run still behaves — no external locking tool (like flock)
needed.

Examples:
  cfmail sync --dir ~/cfmail    first run, pick a directory
  cfmail sync                   only new mail after that
  cfmail sync --all --html      full re-check, store HTML too

To clean up old archives, see cfmail prune --help`;

// Marks a folder as one this tool owns. `prune` refuses to delete without it, so
// pointing --dir at an unrelated path cannot wipe someone's files.
export { MARKER } from "../archive.mjs";

// Written into an email's folder once it has been announced. Using the folder
// itself as the record means the archive stays the single source of truth —
// no separate state file can drift out of step with what is on disk.
export const NOTIFIED = ".notified";

const PAGE_MAX = 100;   // the service caps list_emails at 100 rows

// The folder name is an identifier, not a label. Subjects are attacker-supplied
// free text — every character class, length and encoding a sender can think of —
// and no amount of sanitising makes that a good filename. The subject lives in
// meta.json, where it needs no escaping at all.

// Attachment names come from the sender and are not length-limited. Left alone,
// an overlong one throws ENAMETOOLONG mid-run and the same email blocks every
// later sync.
function safeName(name, fallback, maxBytes = 100) {
  let base = (name || "").replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_").replace(/^\.+/, "").trim();
  if (!base) return fallback;

  const enc = new TextEncoder();
  if (enc.encode(base).length <= maxBytes) return base;

  const ext = extname(base).slice(0, 16);
  const stem = base.slice(0, base.length - ext.length);
  let out = "";
  for (const ch of stem) {
    if (enc.encode(out + ch).length > maxBytes - enc.encode(ext).length) break;
    out += ch;
  }
  return (out || fallback) + ext;
}

function dayAndTime(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

// Named from the Message-ID rather than the storage id: the former is the
// email's own identity and survives a redelivery, while the latter is a fresh
// UUID on every ingest — so the same message keeps the same folder, and
// "already archived" holds even when the service hands it to us twice.
function folderFor(row) {
  const { day, time } = dayAndTime(row.date);
  return join(day, mailFolderName(time, row.msg_id || row.id || `${row.date}-${row.subject}`));
}

// The service returns newest-first, so a page whose oldest row is already known
// means everything past it is known too.
async function collect(mcp, since, pageSize) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await mcp.call("list_emails", { limit: pageSize, offset });
    const page = res?.emails || res?.results || [];
    if (!page.length) break;

    rows.push(...page.filter((e) => (e.date ?? 0) > since));
    const oldest = page.reduce((m, e) => Math.min(m, e.date ?? 0), Infinity);
    if (oldest <= since || page.length < pageSize) break;
  }
  return rows;
}

// One run should not flood a chat; the rest go out on the next sync.
const NOTIFY_PER_RUN = 20;

// A folder can disappear between readdir and stat (a concurrent prune, a manual
// delete); treat that as "not there" instead of failing the whole run.
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Every archived email that has not been announced yet, oldest first so a chat
// reads in the order mail arrived.
function pendingNotifications(dir) {
  const out = [];
  for (const day of readdirSync(dir)) {
    if (!isDayDir(day)) continue;
    const dayPath = join(dir, day);
    if (!isDir(dayPath)) continue;

    for (const name of readdirSync(dayPath)) {
      const folder = join(dayPath, name);
      if (!isDir(folder)) continue;
      // No meta.json means the archive is incomplete; wait until it is whole.
      if (!existsSync(join(folder, "meta.json"))) continue;
      if (existsSync(join(folder, NOTIFIED))) continue;

      let meta;
      try {
        meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
      } catch {
        continue;
      }
      const attDir = join(folder, "attachments");
      const files = existsSync(attDir)
        ? readdirSync(attDir).map((f) => ({
            name: f,
            path: join(attDir, f),
            size: statSync(join(attDir, f)).size,
          }))
        : [];

      // body.md exists only when the message had no usable plain-text part.
      const txt = existsSync(join(folder, "body.txt"))
        ? readFileSync(join(folder, "body.txt"), "utf8")
        : "";
      const text = txt.trim()
        ? txt
        : existsSync(join(folder, "body.md"))
          ? readFileSync(join(folder, "body.md"), "utf8")
          : "";
      out.push({ rel: join(day, name), folder, files, meta: { ...meta, text } });
    }
  }
  return out.sort((a, b) => (a.meta.date ?? 0) - (b.meta.date ?? 0));
}

// Records when the push succeeded — the email's own date is already in
// meta.json, and after a retry it would answer the wrong question.
function markNotified(item, at) {
  writeFileSync(join(item.folder, NOTIFIED), at + "\n");
}

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = requireConfig("user");
  const stored = readStoredConfig("user");

  // Absolute either way: a relative path stored by an older version would make
  // every file:// link in a notification point nowhere, and would be written
  // straight back on save, so it could never correct itself.
  const chosen = opts.dir || stored.syncDir;
  const root = chosen && resolve(chosen);
  if (!root) fail("no archive folder. Run once with --dir <path>; it is remembered afterwards.");

  if (opts.notify && !isGrixKey(opts.notify)) {
    fail("--notify expects a Grix key starting with whk_");
  }
  const notifyKey = opts.noNotify ? null : opts.notify || stored.notifyKey;
  const pageSize = Math.min(Math.max(opts.limit ?? PAGE_MAX, 1), PAGE_MAX);

  // One run at a time per archive. Two would each write mail the other cannot
  // see, and could announce the same email twice — the `.notified` markers are
  // not visible across them until both finish. A dry run reads nothing shared,
  // so it does not need the lock.
  // Mail is filed under the address it arrived at, so two mailboxes can share
  // one root without their days running together.
  const dir = mailboxDir(root, cfg.email);
  const moved = opts.dryRun ? 0 : migrateFlatArchive(root, cfg.email);
  const renamed = opts.dryRun ? 0 : renameSubjectFolders(mailboxDir(root, cfg.email));

  let lock = null;
  if (!opts.dryRun) {
    lock = acquireLock(dir);
    if (!lock) {
      const other = lockHolder(dir);
      const age = other?.age != null ? `${Math.round(other.age / 1000)} 秒前开始` : "正在运行";
      if (isJson()) return json({ ok: true, skipped: "locked", dir, holder: other?.pid ?? null });
      // Not an error: a scheduled run that finds the previous one still going
      // should step aside quietly rather than alarm whoever set up the schedule.
      return out(`另一个 sync 正在跑（${age}），这次跳过。\n目录: ${dir}`);
    }
  }

  try {
    return await syncWithLock(opts, cfg, stored, root, dir, moved, renamed, notifyKey, pageSize, lock);
  } finally {
    lock?.release();
  }
}

async function syncWithLock(opts, cfg, stored, root, dir, moved, renamed, notifyKey, pageSize, lock) {
  // Written before any mail is fetched: an archive created by an older version,
  // or one that gets no new mail this run, still ends up marked — otherwise
  // `prune` would keep refusing to clean a folder that is genuinely ours.
  if (!opts.dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, MARKER), "cfmail archive\n");
  }

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const since = opts.all ? 0 : stored.syncCursor ?? 0;
  const todo = await collect(mcp, since, pageSize);
  const newest = todo.reduce((m, e) => Math.max(m, e.date ?? 0), since);

  const written = [];
  let skipped = 0;
  let incomplete = 0;

  for (const row of todo) {
    const rel = folderFor(row);
    const folder = join(dir, rel);

    // meta.json is written last, so its presence means "fully archived".
    if (existsSync(join(folder, "meta.json"))) {
      skipped++;
      continue;
    }
    if (opts.dryRun) {
      written.push({ rel, attachments: row.has_attachments ? "?" : 0 });
      continue;
    }

    // Always fetch the HTML part, even without --html: for a message that has no
    // plain-text part it is the only content there is, and body.md is built from
    // it. Writing body.html to disk still requires --html.
    const mail = await mcp.call("get_email", { id: row.id, include_html: true });
    if (!mail || mail.error) continue;

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "body.txt"), mail.text ?? "");
    if (opts.html && mail.html) writeFileSync(join(folder, "body.html"), mail.html);

    // HTML-only mail (verification codes, notifications) has an empty text part;
    // without this the archive and the notification would both show nothing.
    if (!mail.text?.trim() && mail.html) {
      const md = htmlToMarkdown(mail.html);
      if (md) writeFileSync(join(folder, "body.md"), md + "\n");
    }

    let n = 0;
    let missing = false;
    const seen = new Set();
    const savedFiles = [];
    for (const a of mail.attachments ?? []) {
      const got = await mcp.call("get_attachment", { attachment_id: a.id });
      if (!got || got.content_base64 == null) { missing = true; continue; }

      // Two attachments may share a filename; keep both. The prefix can push
      // the name a few bytes past maxBytes, which is still far under any limit.
      let name = safeName(a.filename, a.id);
      if (seen.has(name)) name = `${String(a.id).slice(0, 6)}-${name}`;
      seen.add(name);

      const attDir = join(folder, "attachments");
      mkdirSync(attDir, { recursive: true });
      const filePath = join(attDir, name);
      writeFileSync(filePath, Buffer.from(got.content_base64, "base64"));
      savedFiles.push({ name, path: filePath, size: a.size ?? 0 });
      n++;
      // A single large attachment on a slow link can take minutes on its own;
      // without this the lock would go stale mid-download.
      lock?.touch();
    }

    // Without every attachment this is not a complete archive: leave meta.json
    // off so the next run fetches the email again instead of calling it done.
    if (missing) {
      incomplete++;
      continue;
    }
    writeFileSync(
      join(folder, "meta.json"),
      JSON.stringify({
        id: mail.id, msg_id: mail.msg_id, from: mail.from, from_name: mail.from_name,
        to: mail.to, cc: mail.cc, subject: mail.subject,
        date: mail.date, received_at: mail.received_at,
        attachments: mail.attachments ?? [],
      }, null, 2) + "\n"
    );
    written.push({ rel, folder, attachments: n, files: savedFiles, meta: mail });
    lock?.touch();
  }

  if (!opts.dryRun) {
    // An email whose attachments failed must not be sealed off by the cursor.
    const cursor = incomplete ? (stored.syncCursor ?? 0) : Math.max(newest, stored.syncCursor ?? 0);
    saveConfig({ ...readStoredConfig("user"), syncDir: root, syncCursor: cursor }, "user");
  }

  // Announce after everything is on disk, so every link in a message points at a
  // file that already exists. The candidates are every archived email still
  // lacking a marker — not just this run's — so a send that failed last time is
  // retried rather than lost.
  const notified = [];
  const notifyFailed = [];
  let backfilled = 0;

  if (notifyKey && !opts.dryRun) {
    const pending = pendingNotifications(dir);

    // Turning notifications on should not replay the whole mailbox into the
    // chat. Mark what is already archived as seen; announce only what arrives
    // from here on.
    if (!stored.notifyKey) {
      const at = new Date().toISOString();
      for (const item of pending) markNotified(item, at);
      backfilled = pending.length;
    } else {
      for (const item of pending.slice(0, NOTIFY_PER_RUN)) {
        try {
          await sendToGrix(notifyKey, buildMessage(item));
          // Marker written only after the POST succeeded.
          markNotified(item, new Date().toISOString());
          notified.push(item.rel);
          lock?.touch();
        } catch (e) {
          notifyFailed.push({ rel: item.rel, error: e?.message ?? String(e) });
        }
      }
    }
    // Merge onto what is on disk now: the cursor was already written above.
    saveConfig({ ...readStoredConfig("user"), notifyKey }, "user");
  }

  if (isJson()) {
    return json({
      ok: true, root, dir, mailbox: cfg.email, migrated: moved, renamed,
      written: written.length, skipped, incomplete,
      notified: notified.length, backfilled, notify_failed: notifyFailed,
      dry_run: !!opts.dryRun, items: written.map((w) => ({ rel: w.rel, attachments: w.attachments })),
    });
  }
  if (moved) out(`已把 ${moved} 天的旧归档移到 ${cfg.email} 名下\n`);
  if (renamed) out(`已把 ${renamed} 封邮件的目录名换成标识哈希（标题在 meta.json 里）\n`);
  out(
    `${opts.dryRun ? "将归档" : "已归档"} ${written.length} 封` +
    (skipped ? `，跳过 ${skipped} 封（已存在）` : "") +
    (incomplete ? `，${incomplete} 封附件没取全（下次重试）` : "") +
    `\n目录: ${dir}`
  );
  for (const w of written.slice(0, 10)) {
    out(`  ${w.rel}${w.attachments ? `  📎${w.attachments}` : ""}`);
  }
  if (written.length > 10) out(`  …还有 ${written.length - 10} 封`);
  if (backfilled) {
    out(`\n已把现有 ${backfilled} 封标记为「已通知」，不会补推历史邮件。\n之后 sync 到的新邮件会自动推送到 Grix。`);
  }
  if (notified.length) out(`\n已推送 ${notified.length} 封到 Grix`);
  for (const f of notifyFailed) out(`  推送失败: ${f.rel} — ${f.error}（下次 sync 会重试）`);
  if (!opts.dryRun && written.length) out(`\n最新归档到: ${formatDate(newest)}`);
}
