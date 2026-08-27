// Config lives in the same files the older skill scripts used, so installing the
// CLI does not orphan an existing setup. User and admin credentials stay in
// separate files: the admin key must never sit next to a key handed to a user.
//
// One config file holds exactly one mailbox. Anything that would let a command
// act on a *different* mailbox than the last one has to be state shared between
// processes, and shared state is what makes two programs step on each other.
// Running a second mailbox means pointing EMAIL_INBOX_CONFIG at a second file —
// separate key, separate unread cursor, separate archive, nothing in common.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fail, warn } from "./output.mjs";

const SCOPES = {
  user: { dir: "email-inbox", envPrefix: "EMAIL_INBOX" },
  admin: { dir: "email-admin", envPrefix: "EMAIL_ADMIN" },
};

export function configPath(scope = "user") {
  const { dir, envPrefix } = SCOPES[scope];
  const override = process.env[`${envPrefix}_CONFIG`];
  if (override) return override;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, dir, "config.json");
}

function readFile(scope) {
  const path = configPath(scope);
  if (!existsSync(path)) return {};
  warnIfOthersCanRead(path, scope);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`config file is not valid JSON: ${path} (${e.message})`);
  }
}

// The credential sits in this file in plain text. writeFile creates it 0600, but
// a file written before that rule existed — or copied in by hand — can be
// readable by every account on the machine, and nothing would ever say so. Only
// a warning: silently changing permissions on a read is not this command's job.
const warnedPaths = new Set();

function warnIfOthersCanRead(path, scope) {
  // Windows does not carry these bits meaningfully; node reports 0666 there, so
  // checking them would warn on every run and teach people to ignore it.
  if (process.platform === "win32" || warnedPaths.has(path)) return;
  warnedPaths.add(path);

  let mode;
  try {
    mode = statSync(path).mode;
  } catch {
    return;   // gone between the check and here — the read will report it
  }
  if (!(mode & 0o077)) return;

  const what = scope === "admin" ? "管理员令牌，全服务最高权限" : "这个邮箱的 API Key";
  warn(
    `${path} 同机器上的其他用户可读，里面是${what}。\n` +
    `  收紧: chmod 600 ${path}`
  );
}

// Write through a temporary file and rename into place. Two programs can be
// running this CLI against the same config at once; a plain write leaves the
// file truncated for an instant, and another process reading right then sees
// invalid JSON and exits. rename() is atomic, so a reader sees either the old
// file or the new one and never a half-written state.
function writeFile(data, scope) {
  const path = configPath(scope);
  mkdirSync(dirname(path), { recursive: true });

  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
  // `mode` only applies when a file is created, so a config written by an older
  // version keeps its permissions unless we tighten them here.
  chmodSync(path, 0o600);
  return path;
}

// A file written by the version that kept several mailboxes in one file is read
// as its selected mailbox, so an existing setup keeps working; the next write
// stores the flat shape. A file holding more than one has to be split by hand —
// guessing which mailbox was meant would be worse than saying so.
function normalize(raw, path) {
  if (!raw || typeof raw !== "object") return {};
  if (!raw.accounts || typeof raw.accounts !== "object" || Array.isArray(raw.accounts)) {
    const { accounts, current, ...flat } = raw;
    return flat;
  }

  const names = Object.keys(raw.accounts);
  // An empty accounts map carries no mailbox, so anything at the top level is
  // the real setting rather than a leftover.
  if (!names.length) {
    const { accounts, current, ...flat } = raw;
    return flat;
  }

  const name = names.includes(raw.current) ? raw.current : (names.length === 1 ? names[0] : "");
  if (!name) {
    fail(
      `this config holds ${names.length} mailboxes, and cfmail now uses one file per mailbox.\n` +
      `  ${path}\n` +
      `configured: ${names.join(", ")}\n` +
      `Give each one its own file and point EMAIL_INBOX_CONFIG at it, for example:\n` +
      `  EMAIL_INBOX_CONFIG=~/.config/email-inbox/${names[0]}.json cfmail setup --base <url> --email ${names[0]} --key <key>`
    );
  }
  const stored = raw.accounts[name];
  return { ...(stored && typeof stored === "object" ? stored : {}), email: name };
}

export function loadConfig(scope = "user") {
  const { envPrefix } = SCOPES[scope];
  const stored = scope === "admin" ? readFile("admin") : readStoredConfig("user");

  // Environment wins over the file, so a script can borrow another mailbox's
  // credentials for one run without touching what is on disk.
  return {
    ...stored,
    base: (process.env[`${envPrefix}_BASE`] || stored.base || "").replace(/\/+$/, ""),
    key: process.env[`${envPrefix}_KEY`] || stored.key || "",
  };
}

// What is on disk, with no environment merged in. Writing back a value that only
// came from the environment would silently persist credentials meant for one
// command.
export function readStoredConfig(scope = "user") {
  if (scope === "admin") return readFile("admin");
  return normalize(readFile("user"), configPath("user"));
}

// An update is read-modify-write, and two programs may be doing it at once —
// both reading the same file and writing back in turn loses whichever change
// landed first. The lock makes each update see the previous one.
//
// Held for a single file rewrite (well under a millisecond), so waiting is
// cheap; a hard timeout means a crashed process cannot wedge every later run.
function withConfigLock(scope, mutate) {
  const path = configPath(scope);
  mkdirSync(dirname(path), { recursive: true });

  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5000;
  let held = false;

  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      held = true;
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      // A lock older than the longest plausible write is a crash leftover.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
      } catch { /* someone else cleared it first */ }
      sleepBriefly();
    }
  }

  try {
    // Proceeding without the lock beats refusing to work: the write is still
    // atomic, so the worst case is a lost update rather than a broken file.
    return mutate();
  } finally {
    if (held) {
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}

// A few milliseconds without pulling in a timer: this runs inside a synchronous
// read-modify-write and must not yield to other work.
function sleepBriefly() {
  const until = Date.now() + 3;
  while (Date.now() < until) { /* spin */ }
}

// Fields not given are left as they are, so a command updating a cursor cannot
// wipe the mailbox's other settings.
export function saveConfig(cfg, scope = "user") {
  return withConfigLock(scope, () => writeFile({ ...readStoredConfig(scope), ...cfg }, scope));
}

// Every command that talks to the service goes through this, so the "you have
// not set this up yet" message is written once.
export function requireConfig(scope = "user") {
  const cfg = loadConfig(scope);
  const setup = scope === "admin" ? "cfmail admin setup" : "cfmail setup";

  if (!cfg.base) fail(`no service URL configured. Run: ${setup} --base <url> ...`);
  if (!cfg.key) fail(`no API key configured. Run: ${setup} ... --key <key>`);
  return cfg;
}
