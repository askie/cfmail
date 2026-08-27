import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cfmail.mjs");

function help(...args) {
  return execFileSync("node", [BIN, ...args, "--help"], { encoding: "utf8" });
}

// Every flag a command accepts must be documented: help that silently drifts
// from the parser is how a CLI becomes unusable.
const FLAGS = {
  setup: ["--base", "--email", "--key"],
  unread: ["--peek", "--all", "--limit", "--reset"],
  list: ["--from", "--to", "--subject", "--since", "--until", "--limit", "--offset"],
  read: ["--html"],
  search: ["--limit"],
  attachment: ["--out"],
  send: ["--to", "--cc", "--subject", "--text", "--text-file", "--reply", "--attach", "--forward-attachment"],
  reply: ["--text", "--text-file", "--cc", "--subject", "--attach", "--forward-attachment"],
  sync: ["--dir", "--limit", "--all", "--html", "--dry-run"],
  prune: ["--older-than", "--dir", "--yes", "--dry-run"],
};

for (const [cmd, flags] of Object.entries(FLAGS)) {
  test(`${cmd} --help documents every flag it accepts`, () => {
    const text = help(cmd);
    for (const flag of flags) expect(text, `${cmd} is missing ${flag}`).toContain(flag);
  });
}

test("every command's help opens with a usage line naming that command", () => {
  for (const cmd of [...Object.keys(FLAGS), "stats", "admin"]) {
    const first = help(cmd).split("\n")[0];
    expect(first, `${cmd} has no usage line`).toMatch(/^用法: cfmail /);
    expect(first, `${cmd}'s usage line names another command`).toContain(cmd.split(" ")[0]);
  }
});

test("admin's subcommands each answer --help on their own", () => {
  for (const sub of ["setup", "create-key", "list-keys", "delete-key", "webhook"]) {
    const text = execFileSync("node", [BIN, "admin", sub, "--help"], { encoding: "utf8" });
    expect(text.split("\n")[0], `admin ${sub}`).toBe(`用法: cfmail admin ${sub}` +
      (sub === "list-keys" ? "" : text.split("\n")[0].slice(`用法: cfmail admin ${sub}`.length)));
  }
});

test("no help text leaks an unresolved template placeholder", () => {
  for (const cmd of [...Object.keys(FLAGS), "stats", "admin"]) {
    expect(help(cmd), cmd).not.toMatch(/\$\{/);
  }
});

test("the overview points at per-command help", () => {
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(text).toMatch(/--help/);
  expect(text).toContain("cfmail send --help");
});

test("help is plain text, not markdown — the terminal shows the markup verbatim", () => {
  const all = [...Object.keys(FLAGS), "stats", "admin"].map((c) => help(c)).join("\n") +
    execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(all).not.toMatch(/\*\*/);
});
