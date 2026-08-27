import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "cfmail.mjs");

function help(...args) {
  return execFileSync("node", [BIN, ...args, "--help"], { encoding: "utf8" });
}

// Read the flags straight out of each command's SPEC literal. A hand-kept list
// would drift the first time someone adds a flag — which is exactly the failure
// this suite is supposed to catch.
function specFlags(file) {
  const src = readFileSync(join(ROOT, "src", "commands", file), "utf8");
  const spec = src.match(/const SPEC = \{[\s\S]*?\};/);
  if (!spec) throw new Error(`no SPEC literal in ${file}`);
  return [...spec[0].matchAll(/"(--[\w-]+)":/g)].map((m) => m[1]);
}

const COMMANDS = {
  setup: "setup.mjs",
  unread: "unread.mjs",
  list: "list.mjs",
  read: "read.mjs",
  search: "search.mjs",
  attachment: "attachment.mjs",
  send: "send.mjs",
  reply: "send.mjs",     // reply shares send's parser, so it shares its flags
  sync: "sync.mjs",
  prune: "prune.mjs",
};

for (const [cmd, file] of Object.entries(COMMANDS)) {
  test(`${cmd} --help documents every flag its parser accepts`, () => {
    const text = help(cmd);
    const flags = specFlags(file);
    expect(flags.length).toBeGreaterThan(0);

    for (const flag of flags) {
      // `cfmail reply <id>` takes the id positionally; --reply is rejected there.
      if (cmd === "reply" && flag === "--reply") continue;
      expect(text, `${cmd} --help does not mention ${flag}`).toContain(flag);
    }
  });
}

test("the flags read out of a SPEC are the real ones", () => {
  // Guards the extraction itself: if the regex silently stopped matching, every
  // test above would pass vacuously.
  expect(specFlags("prune.mjs").sort()).toEqual(["--dir", "--dry-run", "--older-than", "--yes"]);
});

test("every command's help opens with a usage line naming that command", () => {
  for (const cmd of [...Object.keys(COMMANDS), "stats", "admin"]) {
    const first = help(cmd).split("\n")[0];
    expect(first, `${cmd} has no usage line`).toMatch(/^用法: cfmail /);
    expect(first, `${cmd}'s usage line names another command`).toContain(cmd);
  }
});

test("admin's subcommands each answer --help with their own usage line", () => {
  for (const sub of ["setup", "create-key", "list-keys", "delete-key", "webhook"]) {
    const first = execFileSync("node", [BIN, "admin", sub, "--help"], { encoding: "utf8" })
      .split("\n")[0];
    // Must be the subcommand's own line, not the admin overview it falls back to.
    expect(first, `admin ${sub}`).toMatch(new RegExp(`^用法: cfmail admin ${sub}(\\s|$)`));
  }
});

test("no help text leaks an unresolved template placeholder", () => {
  for (const cmd of [...Object.keys(COMMANDS), "stats", "admin"]) {
    expect(help(cmd), cmd).not.toMatch(/\$\{/);
  }
});

test("help is plain text, not markdown — the terminal shows the markup verbatim", () => {
  const all = [...Object.keys(COMMANDS), "stats", "admin"].map((c) => help(c)).join("\n") +
    execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(all).not.toMatch(/\*\*/);
});

test("the overview points at per-command help", () => {
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(text).toContain("cfmail send --help");
});
