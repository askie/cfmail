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

import { readdirSync, existsSync, statSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// The root carries this; `prune` refuses to delete anywhere without it.
export const MARKER = ".cfmail-archive";

// One lock per mailbox rather than per root, so syncing two mailboxes at once
// is fine — they never write to the same folders.
export { LOCK } from "./lock.mjs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// An address is already close to a safe folder name; only Windows' reserved
// characters need replacing, and a real address contains none of them.
export function mailboxDir(root, email) {
  const name = String(email || "(default)").replace(/[/\\?%*:|"<>\x00-\x1f]/g, "_");
  return join(root, name);
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
