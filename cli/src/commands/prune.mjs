import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readStoredConfig } from "../config.mjs";
import { MARKER } from "./sync.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

const SPEC = { "--dir": "string", "--older-than": "string", "--yes": "bool", "--dry-run": "bool" };

export const help = `cfmail prune --older-than <age> [--dir <path>] [--yes]

Delete archived mail older than the given age from the local folder. This only
touches what \`cfmail sync\` wrote; mail on the server is not affected.

  --older-than 30d   age threshold: d=day, w=7d, m=30d, y=365d (approximate)
  --dir <path>       folder to clean (defaults to the one sync remembered)
  --yes              actually delete; without it this is a dry run
  --dry-run          explicit dry run (the default anyway)

Deleting is irreversible, so a plain run only reports what would go. Add --yes
once the list looks right.

To keep the archive trimmed automatically, run it from cron:

  0 4 * * *  cfmail sync && cfmail prune --older-than 90d --yes`;

const UNITS = { d: 1, w: 7, m: 30, y: 365 };

function parseAge(text) {
  const m = /^(\d+)\s*([dwmy])$/i.exec((text || "").trim());
  if (!m) fail(`--older-than expects a number plus d/w/m/y, for example 30d or 6m (got: ${text})`);
  return Number(m[1]) * UNITS[m[2].toLowerCase()] * 86400_000;
}

// Only day folders written by sync are considered, so pointing --dir at the
// wrong place cannot wipe unrelated files.
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;

export async function run(argv) {
  const { opts } = parseArgs(argv, SPEC);
  const stored = readStoredConfig("user");
  const dir = opts.dir || stored.syncDir;

  if (!dir) fail("no archive folder. Pass --dir <path>, or run `cfmail sync --dir <path>` first.");
  if (!opts.olderThan) fail("missing --older-than <age>, for example --older-than 90d");
  if (!existsSync(dir)) fail(`archive folder does not exist: ${dir}`);
  // Refuse to delete anywhere `cfmail sync` has not written. Without this, a
  // --dir typo pointing at a folder that happens to hold date-named directories
  // would wipe them.
  if (!existsSync(join(dir, MARKER))) {
    fail(
      `${dir} is not a cfmail archive (no ${MARKER}).\n` +
      `Run \`cfmail sync --dir ${dir}\` first, or point --dir at the right folder.`
    );
  }

  const cutoff = Date.now() - parseAge(opts.olderThan);
  const doomed = [];

  for (const name of readdirSync(dir)) {
    if (!DAY_DIR.test(name)) continue;
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
      ok: true, dir, older_than: opts.olderThan, applied: apply,
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
