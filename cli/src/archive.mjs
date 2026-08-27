// Where a mailbox's archive lives.
//
// Mail is filed under the address it arrived at, then by date:
//
//   <root>/me@example.com/2026-08-27/0930-subject-a1b2c3/
//
// Without the address level, two mailboxes pointed at the same root would
// interleave inside each day's folder with no way to tell them apart — and this
// tool is used one mailbox at a time, so that is the level that has to come
// first.

import { readdirSync, readFileSync, existsSync, statSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The root carries this; `prune` refuses to delete anywhere without it.
export const MARKER = ".cfmail-archive";

// One lock per mailbox rather than per root, so syncing two mailboxes at once
// is fine — they never write to the same folders.
import { LOCK } from "./lock.mjs";
export { LOCK };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// An address is already close to a safe folder name, but three things still
// have to be handled: Windows' reserved characters, case (macOS and Windows
// treat `A@x.com` and `a@x.com` as the same folder, so the name is lowercased
// to make that collapse deliberate and consistent everywhere), and length —
// a 300-character local part would fail with ENAMETOOLONG.
export function mailboxDir(root, email) {
  const raw = String(email || "").trim().toLowerCase() || "(default)";
  const safe = raw.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_");
  return join(root, truncateName(safe));
}

const MAX_NAME_BYTES = 180;

// Keep the tail — the domain is what distinguishes two long addresses — and
// mark the cut so the folder is not mistaken for a complete address.
function truncateName(name) {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= MAX_NAME_BYTES) return name;

  const at = name.lastIndexOf("@");
  const domain = at >= 0 ? name.slice(at) : "";
  const budget = MAX_NAME_BYTES - enc.encode(domain).length - 1;

  let head = "";
  for (const ch of at >= 0 ? name.slice(0, at) : name) {
    if (enc.encode(head + ch).length > budget) break;
    head += ch;
  }
  return `${head}~${domain}`;
}

export function isDayDir(name) {
  return DAY.test(name);
}

// Day folders sitting directly under the root are from before mail was filed by
// address. Moving them under the mailbox that is syncing keeps that history
// intact — a pre-multi-account archive can only have come from one mailbox.
export function migrateFlatArchive(root, email) {
  if (!existsSync(root)) return 0;

  const days = readdirSync(root).filter((n) => {
    if (!DAY.test(n)) return false;
    try {
      return statSync(join(root, n)).isDirectory();
    } catch {
      return false;
    }
  });
  if (!days.length) return 0;

  const target = mailboxDir(root, email);
  mkdirSync(target, { recursive: true });

  // The lock used to live at the root; nothing looks there any more, so a
  // leftover would sit forever.
  try {
    const old = join(root, LOCK);
    if (existsSync(old)) unlinkSync(old);
  } catch { /* not ours to insist on */ }
  for (const day of days) {
    const from = join(root, day);
    const to = join(target, day);
    // A day that exists on both sides means the move already happened for part
    // of the archive; merge rather than clobber.
    if (existsSync(to)) {
      for (const mail of readdirSync(from)) {
        const dest = join(to, mail);
        if (!existsSync(dest)) renameSync(join(from, mail), dest);
      }
    } else {
      renameSync(from, to);
    }
  }
  return days.length;
}

// The name a mail folder should have: the time it arrived plus a hash of the
// message's own identity. Kept here so sync and the rename pass below cannot
// drift apart.
export function mailFolderName(time, identity) {
  const hash = createHash("sha256").update(String(identity)).digest("hex").slice(0, 10);
  return `${time}-${hash}`;
}

// Earlier versions put the subject in the folder name. Renaming them keeps one
// archive from carrying two naming schemes — the mail itself is untouched, and
// meta.json has held the subject all along.
export function renameSubjectFolders(dir) {
  if (!existsSync(dir)) return 0;
  let renamed = 0;

  for (const day of readdirSync(dir)) {
    if (!DAY.test(day)) continue;
    const dayPath = join(dir, day);
    let entries;
    try {
      if (!statSync(dayPath).isDirectory()) continue;
      entries = readdirSync(dayPath);
    } catch {
      continue;
    }

    for (const name of entries) {
      const folder = join(dayPath, name);
      const meta = join(folder, "meta.json");
      if (!existsSync(meta)) continue;

      // `HHMM-<10 hex>` is already the current shape.
      if (/^\d{4}-[0-9a-f]{10}$/.test(name)) continue;

      let parsed;
      try {
        parsed = JSON.parse(readFileSync(meta, "utf8"));
      } catch {
        continue;
      }

      const time = name.slice(0, 4);
      if (!/^\d{4}$/.test(time)) continue;

      const target = join(dayPath, mailFolderName(time, parsed.msg_id || parsed.id || name));
      if (target === folder || existsSync(target)) continue;

      try {
        renameSync(folder, target);
        renamed++;
      } catch { /* leave it under the old name rather than fail the sync */ }
    }
  }
  return renamed;
}
