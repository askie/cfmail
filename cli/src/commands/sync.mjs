import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Mcp } from "../mcp.mjs";
import { requireConfig, readStoredConfig, saveConfig } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson, formatDate } from "../output.mjs";

const SPEC = {
  "--dir": "string", "--limit": "number", "--all": "bool", "--html": "bool", "--dry-run": "bool",
};

export const help = `cfmail sync [--dir <path>] [--all] [--limit N] [--html] [--dry-run]

Archive mail to a local folder, one directory per email under a date folder:

  <dir>/2026-08-27/0930-invoice-from-acme/
      meta.json          headers, ids, attachment list
      body.txt           plain-text body
      body.html          only with --html
      attachments/…      the files, under their original names

Already-archived mail is skipped, so running this repeatedly is cheap and safe.
The folder is remembered after the first --dir, and \`cfmail prune\` cleans it up.

  --all       re-check everything, not just mail newer than the last sync
  --limit N   how many emails to look at in one run (default 200)
  --html      also write body.html
  --dry-run   report what would be written without touching the disk`;

// Directory names end up in shells, editors and backups, so keep them boring:
// ASCII-safe, no separators, short enough to stay readable.
function slug(text, max = 40) {
  const s = (text || "")
    .replace(/[\s　]+/g, "-")
    .replace(/[/\\?%*:|"<>.\x00-\x1f]/g, "")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max) || "no-subject";
}

function safeName(name, fallback) {
  const base = (name || "").replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_").replace(/^\.+/, "").trim();
  return base || fallback;
}

function dayAndTime(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}`,
  };
}

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const cfg = requireConfig("user");
  const stored = readStoredConfig("user");

  const dir = opts.dir || stored.syncDir;
  if (!dir) fail("no archive folder. Run once with --dir <path>; it is remembered afterwards.");

  const mcp = await new Mcp(cfg.base, cfg.key).connect();
  const res = await mcp.call("list_emails", { limit: Math.min(Math.max(opts.limit ?? 200, 1), 100) });
  const all = res?.emails || res?.results || [];

  const since = opts.all ? 0 : stored.syncCursor ?? 0;
  const todo = all.filter((e) => (e.date ?? 0) > since);
  const newest = all.reduce((m, e) => Math.max(m, e.date ?? 0), since);

  const written = [];
  const skipped = [];

  for (const row of todo) {
    const { day, time } = dayAndTime(row.date);
    const folder = join(dir, day, `${time}-${slug(row.subject)}`);

    // The id file is the marker: a folder that has it was fully written.
    if (existsSync(join(folder, "meta.json"))) {
      skipped.push(folder);
      continue;
    }
    if (opts.dryRun) {
      written.push({ folder, attachments: row.has_attachments ? "?" : 0 });
      continue;
    }

    const mail = await mcp.call("get_email", { id: row.id, include_html: !!opts.html });
    if (!mail || mail.error) continue;

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "body.txt"), mail.text ?? "");
    if (opts.html && mail.html) writeFileSync(join(folder, "body.html"), mail.html);

    let n = 0;
    for (const a of mail.attachments ?? []) {
      const got = await mcp.call("get_attachment", { attachment_id: a.id });
      if (!got || got.content_base64 == null) continue;
      const attDir = join(folder, "attachments");
      mkdirSync(attDir, { recursive: true });
      writeFileSync(join(attDir, safeName(a.filename, a.id)), Buffer.from(got.content_base64, "base64"));
      n++;
    }

    // Written last: its presence means this email is completely archived.
    writeFileSync(
      join(folder, "meta.json"),
      JSON.stringify({
        id: mail.id, msg_id: mail.msg_id, from: mail.from, from_name: mail.from_name,
        to: mail.to, cc: mail.cc, subject: mail.subject,
        date: mail.date, received_at: mail.received_at,
        attachments: mail.attachments ?? [],
      }, null, 2) + "\n"
    );
    written.push({ folder, attachments: n });
  }

  if (!opts.dryRun && newest > (stored.syncCursor ?? 0)) {
    saveConfig({ ...readStoredConfig("user"), syncDir: dir, syncCursor: newest }, "user");
  } else if (!opts.dryRun && opts.dir) {
    saveConfig({ ...readStoredConfig("user"), syncDir: dir }, "user");
  }

  if (isJson()) {
    return json({ ok: true, dir, written: written.length, skipped: skipped.length, dry_run: !!opts.dryRun, items: written });
  }
  out(
    `${opts.dryRun ? "将归档" : "已归档"} ${written.length} 封` +
    (skipped.length ? `，跳过 ${skipped.length} 封（已存在）` : "") +
    `\n目录: ${dir}`
  );
  for (const w of written.slice(0, 10)) {
    out(`  ${w.folder.replace(dir, "").replace(/^\//, "")}${w.attachments ? `  📎${w.attachments}` : ""}`);
  }
  if (written.length > 10) out(`  …还有 ${written.length - 10} 封`);
  if (!opts.dryRun && written.length) out(`\n最新归档到: ${formatDate(newest)}`);
}
