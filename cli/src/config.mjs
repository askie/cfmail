// Config lives in the same files the older skill scripts used, so installing the
// CLI does not orphan an existing setup. User and admin credentials stay in
// separate files: the admin key must never sit next to a key handed to a user.
//
// The user file holds several mailboxes, keyed by address, plus which one is
// current — the shape aws-cli and kubectl use, and for the same reason: most
// commands should not have to name an account, but any command must be able to.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fail } from "./output.mjs";

const SCOPES = {
  user: { dir: "email-inbox", envPrefix: "EMAIL_INBOX" },
  admin: { dir: "email-admin", envPrefix: "EMAIL_ADMIN" },
};

// Set by the entry point from a global --email, so no command has to thread it
// through. Empty means "whatever the file says is current".
let selected = "";

export function selectAccount(email) {
  selected = String(email || "").trim();
}

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
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`config file is not valid JSON: ${path} (${e.message})`);
  }
}

function writeFile(data, scope) {
  const path = configPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when the file is created, so a file written by an older
  // version keeps its permissions unless we tighten them here.
  chmodSync(path, 0o600);
  return path;
}

// A file written before multi-account support holds one mailbox at the top
// level. Reading it as one account keeps every existing setup working, and the
// next write persists the new shape.
function normalize(raw, path) {
  if (!raw || typeof raw !== "object") return { current: "", accounts: {} };

  if ("accounts" in raw && raw.accounts !== null) {
    // Present but not a map of mailboxes: report it rather than silently
    // behaving as though nothing were configured.
    if (typeof raw.accounts !== "object" || Array.isArray(raw.accounts)) {
      fail(`config file is malformed: "accounts" should be an object of mailboxes\n  ${path}`);
    }
    const accounts = {};
    for (const [name, value] of Object.entries(raw.accounts)) {
      accounts[name] = value && typeof value === "object" ? value : {};
    }
    return { current: typeof raw.current === "string" ? raw.current : "", accounts };
  }

  if (raw.base || raw.key) {
    // Drop the keys that belong to the file rather than to a mailbox, so the
    // converted account carries only its own settings.
    const { email = "", current, accounts, ...rest } = raw;
    const name = email || "(default)";
    return { current: name, accounts: { [name]: rest } };
  }

  return { current: "", accounts: {} };
}

export function accountsFile(scope = "user") {
  return normalize(readFile(scope), configPath(scope));
}

export function listAccounts(scope = "user") {
  const file = accountsFile(scope);
  return {
    current: currentName(file),
    names: Object.keys(file.accounts).sort(),
    accounts: file.accounts,
  };
}

// Which account a command should act on: an explicit --email, then the
// environment, then whatever the file marks current, then the only one there is.
function currentName(file) {
  const named = selected || process.env.EMAIL_INBOX_EMAIL || file.current || "";
  if (named) return named;
  const names = Object.keys(file.accounts);
  return names.length === 1 ? names[0] : "";
}

export function loadConfig(scope = "user") {
  const { envPrefix } = SCOPES[scope];

  if (scope === "admin") {
    const raw = readFile("admin");
    return {
      base: (process.env.EMAIL_ADMIN_BASE || raw.base || "").replace(/\/+$/, ""),
      key: process.env.EMAIL_ADMIN_KEY || raw.key || "",
    };
  }

  const file = accountsFile("user");
  const name = currentName(file);
  const stored = file.accounts[name] || {};

  // Environment wins over the file, so a script can borrow another mailbox's
  // credentials for one run without touching what is on disk.
  return {
    ...stored,
    email: name,
    base: (process.env[`${envPrefix}_BASE`] || stored.base || "").replace(/\/+$/, ""),
    key: process.env[`${envPrefix}_KEY`] || stored.key || "",
  };
}

// What is on disk for the account in play, with no environment merged in.
// Writing back a value that only came from the environment would silently
// persist credentials meant for one command.
export function readStoredConfig(scope = "user") {
  if (scope === "admin") return readFile("admin");
  const file = accountsFile("user");
  return { ...(file.accounts[currentName(file)] || {}) };
}

// Save the account in play. Fields not given are left as they are, so a command
// updating a cursor cannot wipe the mailbox's other settings.
export function saveConfig(cfg, scope = "user") {
  if (scope === "admin") return writeFile({ ...readFile("admin"), ...cfg }, "admin");

  const file = accountsFile("user");
  const { email, ...rest } = cfg;
  const name = email || currentName(file);
  if (!name) fail("no mailbox selected. Run `cfmail setup --email <address> ...` first.");

  file.accounts[name] = { ...(file.accounts[name] || {}), ...rest };
  if (!file.current) file.current = name;
  return writeFile(file, "user");
}

export function setCurrentAccount(email, scope = "user") {
  const file = accountsFile(scope);
  if (!file.accounts[email]) {
    const known = Object.keys(file.accounts);
    fail(
      `no mailbox configured for ${email}.` +
      (known.length ? `\nconfigured: ${known.join(", ")}` : "") +
      `\nAdd it with: cfmail setup --base <url> --email ${email} --key <key>`
    );
  }
  file.current = email;
  return writeFile(file, scope);
}

export function removeAccount(email, scope = "user") {
  const file = accountsFile(scope);
  if (!file.accounts[email]) fail(`no mailbox configured for ${email}`);
  delete file.accounts[email];
  if (file.current === email) file.current = Object.keys(file.accounts)[0] || "";
  writeFile(file, scope);
  return file.current;
}

// Every command that talks to the service goes through this, so the "you have
// not set this up yet" message is written once.
export function requireConfig(scope = "user") {
  const cfg = loadConfig(scope);
  const setup = scope === "admin" ? "cfmail admin setup" : "cfmail setup";

  if (scope === "user" && !cfg.base && !cfg.key) {
    const { names } = listAccounts("user");
    if (names.length > 1) {
      fail(
        `no mailbox selected, and this machine has several.\n` +
        `configured: ${names.join(", ")}\n` +
        `Pick one with: cfmail use <address>   (or add --email <address> to this command)`
      );
    }
  }
  if (!cfg.base) fail(`no service URL configured. Run: ${setup} --base <url> ...`);
  if (!cfg.key) fail(`no API key configured. Run: ${setup} ... --key <key>`);
  return cfg;
}
