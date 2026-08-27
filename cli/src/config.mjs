// Config lives in the same files the older skill scripts used, so installing the
// CLI does not orphan an existing setup. User and admin credentials stay in
// separate files: the admin key must never sit next to a key handed to a user.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fail } from "./output.mjs";

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

export function loadConfig(scope = "user") {
  const path = configPath(scope);
  const { envPrefix } = SCOPES[scope];
  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      fail(`config file is not valid JSON: ${path} (${e.message})`);
    }
  }
  // Environment wins, so a script can point at another mailbox without touching
  // the file.
  cfg.base = (process.env[`${envPrefix}_BASE`] || cfg.base || "").replace(/\/+$/, "");
  cfg.key = process.env[`${envPrefix}_KEY`] || cfg.key || "";
  if (scope === "user") cfg.email = process.env.EMAIL_INBOX_EMAIL || cfg.email || "";
  return cfg;
}

export function saveConfig(cfg, scope = "user") {
  const path = configPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return path;
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
