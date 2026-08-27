import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Mcp } from "../mcp.mjs";
import { requireConfig, readStoredConfig, saveConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate } from "../output.mjs";

const SPEC = {
  "--dir": "string", "--limit": "number", "--all": "bool", "--html": "bool", "--dry-run": "bool",
};

export const help = `用法: cfmail sync [--dir <目录>] [选项]

把邮件（正文 + 附件）按天归档到本地目录。

存出来的样子:
  <目录>/2026-08-27/0930-发票-Q3-a1b2c3/
      meta.json          发件人、收件人、主题、时间、附件清单
      body.txt           纯文本正文
      body.html          仅 --html 时
      attachments/       附件，保留原始文件名

目录名带邮件 id 后缀，所以同一分钟的同主题邮件不会互相覆盖。已归档过的会跳过，
反复跑很便宜，适合放进定时任务。邮箱再大也会自动翻页取全。

参数:
  --dir <目录>   归档到哪。第一次给了之后会记住，以后直接 cfmail sync 即可
  --all         重新检查整个邮箱，而不只是上次同步之后的新邮件
  --limit N     每页取几封，1-100，默认 100。只影响翻页粒度，不影响取全
  --html        连 HTML 正文一起存
  --dry-run     只报告会存什么，不动磁盘

附件没取全的邮件不会被标记为已归档，下次跑会重新取。

示例:
  cfmail sync --dir ~/mail      第一次，指定目录
  cfmail sync                   之后只同步新邮件
  cfmail sync --all --html      全量重查，连 HTML 一起存

清理旧归档见 cfmail prune --help`;

// Marks a folder as one this tool owns. `prune` refuses to delete without it, so
// pointing --dir at an unrelated path cannot wipe someone's files.
export const MARKER = ".cfmail-archive";

const PAGE_MAX = 100;   // the service caps list_emails at 100 rows

// Directory names end up in shells, editors and backups, so keep them boring:
// no separators, no dot-segments, short enough to stay readable.
function slug(text, max = 40) {
  const s = (text || "")
    .replace(/[\s　]+/g, "-")
    .replace(/[/\\?%*:|"<>.\x00-\x1f]/g, "")
    .replace(/^-+|-+$/g, "");
  return [...s].slice(0, max).join("") || "no-subject";
}

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

// Two emails can share a minute and a subject — mailing lists do it routinely.
// The id suffix keeps their folders distinct and makes the folder name the
// identity, so "already archived" is decided per email rather than per subject.
function folderFor(row) {
  const { day, time } = dayAndTime(row.date);
  return join(day, `${time}-${slug(row.subject)}-${String(row.id).slice(0, 6)}`);
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

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = requireConfig("user");
  const stored = readStoredConfig("user");

  const dir = opts.dir || stored.syncDir;
  if (!dir) fail("no archive folder. Run once with --dir <path>; it is remembered afterwards.");
  const pageSize = Math.min(Math.max(opts.limit ?? PAGE_MAX, 1), PAGE_MAX);

  // Written before any mail is fetched: an archive created by an older version,
  // or one that gets no new mail this run, still ends up marked — otherwise
  // `prune` would keep refusing to clean a folder that is genuinely ours.
  if (!opts.dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER), "cfmail archive\n");
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

    const mail = await mcp.call("get_email", { id: row.id, include_html: !!opts.html });
    if (!mail || mail.error) continue;

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "body.txt"), mail.text ?? "");
    if (opts.html && mail.html) writeFileSync(join(folder, "body.html"), mail.html);

    let n = 0;
    let missing = false;
    const seen = new Set();
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
      writeFileSync(join(attDir, name), Buffer.from(got.content_base64, "base64"));
      n++;
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
    written.push({ rel, attachments: n });
  }

  if (!opts.dryRun) {
    // An email whose attachments failed must not be sealed off by the cursor.
    const cursor = incomplete ? (stored.syncCursor ?? 0) : Math.max(newest, stored.syncCursor ?? 0);
    saveConfig({ ...readStoredConfig("user"), syncDir: dir, syncCursor: cursor }, "user");
  }

  if (isJson()) {
    return json({
      ok: true, dir, written: written.length, skipped, incomplete,
      dry_run: !!opts.dryRun, items: written,
    });
  }
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
  if (!opts.dryRun && written.length) out(`\n最新归档到: ${formatDate(newest)}`);
}
