import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, readStoredConfig, configPath } from "../src/config.mjs";

let dir;
const ENV_KEYS = [
  "EMAIL_INBOX_CONFIG", "EMAIL_INBOX_BASE", "EMAIL_INBOX_KEY", "EMAIL_INBOX_EMAIL",
  "EMAIL_ADMIN_CONFIG", "EMAIL_ADMIN_BASE", "EMAIL_ADMIN_KEY", "XDG_CONFIG_HOME",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMAIL_INBOX_CONFIG = join(dir, "user.json");
  process.env.EMAIL_ADMIN_CONFIG = join(dir, "admin.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

test("environment values win over the file", () => {
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, JSON.stringify({ base: "https://file", key: "fk" }));
  process.env.EMAIL_INBOX_KEY = "envkey";
  const cfg = loadConfig("user");

  expect(cfg.key).toBe("envkey");
  expect(cfg.base).toBe("https://file");
});

test("a trailing slash on the base URL is stripped", () => {
  process.env.EMAIL_INBOX_BASE = "https://h/";
  expect(loadConfig("user").base).toBe("https://h");
});

test("user and admin scopes read different files", () => {
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, JSON.stringify({ key: "user-key" }));
  writeFileSync(process.env.EMAIL_ADMIN_CONFIG, JSON.stringify({ key: "admin-token" }));

  expect(loadConfig("user").key).toBe("user-key");
  expect(loadConfig("admin").key).toBe("admin-token");
});

test("readStoredConfig ignores the environment", () => {
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, JSON.stringify({ base: "https://file", key: "fk" }));
  process.env.EMAIL_INBOX_KEY = "envkey";

  // This is what a cursor write merges onto: persisting the env key here would
  // leak a one-off credential into the default config.
  expect(readStoredConfig("user")).toEqual({ base: "https://file", key: "fk" });
});

test("readStoredConfig returns an empty object when there is no file", () => {
  expect(readStoredConfig("user")).toEqual({});
});

test("saving tightens permissions on an existing loose file", () => {
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, "{}", { mode: 0o644 });
  saveConfig({ base: "https://h", key: "k" }, "user");

  expect(statSync(process.env.EMAIL_INBOX_CONFIG).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(process.env.EMAIL_INBOX_CONFIG, "utf8")).key).toBe("k");
});

test("XDG_CONFIG_HOME decides the default path", () => {
  delete process.env.EMAIL_INBOX_CONFIG;
  delete process.env.EMAIL_ADMIN_CONFIG;
  process.env.XDG_CONFIG_HOME = dir;
  expect(configPath("user")).toBe(join(dir, "email-inbox", "config.json"));
  expect(configPath("admin")).toBe(join(dir, "email-admin", "config.json"));
});

test("a corrupt config file is reported rather than silently ignored", () => {
  writeFileSync(process.env.EMAIL_INBOX_CONFIG, "{ not json");
  expect(() => loadConfig("user")).toThrow();   // fail() exits; vitest surfaces it
});
