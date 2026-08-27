// A cross-platform lock around the archive directory.
//
// Two syncs running at once would each write mail the other cannot see, and
// could announce the same email twice — they do not share the `.notified`
// markers until both have finished. `flock` would solve it on Unix and not
// exist on Windows, so the lock lives here instead: `wx` fails when the file
// already exists, and that check-and-create is atomic on every platform Node
// runs on.

import { writeFileSync, readFileSync, unlinkSync, existsSync, statSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const LOCK = ".cfmail-lock";

// A crashed run leaves its lock behind. The holder refreshes the file as it
// works, so a lock that has not been touched for this long belongs to a process
// that is gone.
const STALE_MS = 5 * 60_000;

function describe(path) {
  try {
    const { pid, at, token } = JSON.parse(readFileSync(path, "utf8"));
    return { pid, at, token };
  } catch {
    return {};
  }
}

function isStale(path) {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    // Gone between the failed create and this check: no longer held.
    return true;
  }
}

// Returns a handle when the lock was taken, or null when another run holds it.
export function acquireLock(dir) {
  const path = join(dir, LOCK);
  mkdirSync(dir, { recursive: true });

  // Identifies this handle, not this process: the same process can lose a lock
  // to a stale takeover and retake it, and pid would not tell the two apart.
  const token = randomUUID();
  const stamp = (flag) =>
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now(), token }), flag ? { flag } : undefined);
  const write = () => stamp("wx");

  try {
    write();
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;

    if (!isStale(path)) return null;
    // Take over the abandoned lock. A racing process may do the same; the `wx`
    // retry below decides between them.
    try {
      unlinkSync(path);
      write();
    } catch {
      return null;
    }
  }

  let released = false;
  return {
    path,
    holder: describe(path),
    // Called as work progresses so a long run is never mistaken for a dead one.
    touch() {
      if (released) return;
      try {
        stamp();
      } catch { /* the release path will report anything that matters */ }
    },
    release() {
      if (released) return;
      released = true;
      try {
        // Only remove our own lock: once another run has taken over a stale one,
        // this handle must not delete it from under them.
        if (describe(path).token === token) unlinkSync(path);
      } catch { /* already gone */ }
    },
  };
}

// Who holds the lock, for a message the user can act on.
export function lockHolder(dir) {
  const path = join(dir, LOCK);
  if (!existsSync(path)) return null;
  const { pid, at } = describe(path);
  return { pid, at, age: at ? Date.now() - at : null };
}
