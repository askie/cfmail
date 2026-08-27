// The config files hold credentials in plain text. writeFile creates them 0600,
// but a file from an older version — or copied in by hand — can be readable by
// every account on the machine, and nothing used to say so.

import { test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "cfmail.mjs");
const CONFIG_MJS = join(HERE, "..", "src", "config.mjs");

let dir, cfg, admin;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfmail-perm-"));
  cfg = join(dir, "config.json");
  admin = join(dir, "admin.json");
  writeFileSync(cfg, JSON.stringify({ email: "me@x.com", base: "https://h", key: "k" }));
  writeFileSync(admin, JSON.stringify({ base: "https://h", key: "MCP" }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Load a config in a child process and hand back whatever it wrote to stderr.
// `loads` lets one run read the same file twice, which is how the once-per-path
// behaviour gets checked.
function warningsFrom(scope, loads = 1) {
  const script = `
    process.env.EMAIL_INBOX_CONFIG = ${JSON.stringify(cfg)};
    process.env.EMAIL_ADMIN_CONFIG = ${JSON.stringify(admin)};
    const written = [];
    process.stderr.write = (s) => { written.push(s); return true; };
    const { loadConfig } = await import(${JSON.stringify(CONFIG_MJS)});
    for (let i = 0; i < ${loads}; i++) loadConfig(${JSON.stringify(scope)});
    process.stdout.write(written.join(""));
  `;
  return execFileSync("node", ["-e", script, "--input-type=module"], { encoding: "utf8" });
}

function runCli(...args) {
  return execFileSync("node", [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, EMAIL_INBOX_CONFIG: cfg, EMAIL_ADMIN_CONFIG: admin },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("a world-readable config is called out, with the chmod that fixes it", () => {
  chmodSync(cfg, 0o644);
  const w = warningsFrom("user");

  expect(w).toMatch(/^warning: /);
  expect(w).toContain(cfg);
  expect(w).toContain(`chmod 600 ${cfg}`);
});

test("group-readable counts too — it is still someone else", () => {
  chmodSync(cfg, 0o640);
  expect(warningsFrom("user")).toMatch(/warning/);
});

test("an owner-only config says nothing", () => {
  chmodSync(cfg, 0o600);
  expect(warningsFrom("user")).toBe("");
});

test("the admin warning says what is at stake", () => {
  // Losing this one is losing every mailbox on the service.
  chmodSync(admin, 0o644);
  const w = warningsFrom("admin");

  expect(w).toContain(admin);
  expect(w).toMatch(/管理员令牌/);
});

test("it warns once per file, not once per read", () => {
  // requireConfig and readStoredConfig both read; three copies of the same
  // warning in one run is noise people learn to skip.
  chmodSync(cfg, 0o644);
  expect(warningsFrom("user", 3).match(/warning/g)).toHaveLength(1);
});

test("the warning never lands on stdout", () => {
  chmodSync(cfg, 0o644);
  expect(runCli("config")).not.toMatch(/warning/);
});

test("--json output stays parseable with the warning armed", () => {
  chmodSync(cfg, 0o644);
  const stdout = runCli("config", "--json");

  expect(() => JSON.parse(stdout)).not.toThrow();
  expect(JSON.parse(stdout).email).toBe("me@x.com");
});
