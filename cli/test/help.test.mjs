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
  for (const cmd of [...Object.keys(COMMANDS), "stats", "config", "admin"]) {
    const first = help(cmd).split("\n")[0];
    expect(first, `${cmd} has no usage line`).toMatch(/^Usage: cfmail /);
    expect(first, `${cmd}'s usage line names another command`).toContain(cmd);
  }
});

test("admin's subcommands each answer --help with their own usage line", () => {
  for (const sub of ["setup", "create-key", "list-keys", "delete-key", "webhook"]) {
    const first = execFileSync("node", [BIN, "admin", sub, "--help"], { encoding: "utf8" })
      .split("\n")[0];
    // Must be the subcommand's own line, not the admin overview it falls back to.
    expect(first, `admin ${sub}`).toMatch(new RegExp(`^Usage: cfmail admin ${sub}(\\s|$)`));
  }
});

test("no help text leaks an unresolved template placeholder", () => {
  for (const cmd of [...Object.keys(COMMANDS), "stats", "config", "admin"]) {
    expect(help(cmd), cmd).not.toMatch(/\$\{/);
  }
});

test("help is plain text, not markdown — the terminal shows the markup verbatim", () => {
  const all = [...Object.keys(COMMANDS), "stats", "config", "admin"].map((c) => help(c)).join("\n") +
    execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(all).not.toMatch(/\*\*/);
});

test("every command the router accepts is listed in the overview", () => {
  // Read the router's own table: a command added without a line in the help is
  // a command nobody finds.
  const src = readFileSync(BIN, "utf8");
  const table = src.match(/const COMMANDS = \{[\s\S]*?\n\};/)[0];
  const names = [...table.matchAll(/^\s{2}([a-z]+)[,:]/gm)].map((m) => m[1])
    .concat(table.match(/^\s{2}([a-z, ]+),$/m)?.[1].split(",").map((x) => x.trim()) || []);
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });

  expect(names.length).toBeGreaterThan(5);
  for (const n of new Set(names.filter(Boolean))) {
    expect(text, `overview never mentions "cfmail ${n}"`).toMatch(new RegExp(`cfmail ${n}\\b`));
  }
});

test("the overview points at per-command help", () => {
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(text).toContain("cfmail send --help");
});

test("a mistyped admin subcommand fails loudly even with --help", () => {
  // Printing the overview and exiting 0 would hide the typo in a script.
  let code = 0;
  try {
    execFileSync("node", [BIN, "admin", "bogus", "--help"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    code = e.status;
    expect(e.stderr).toMatch(/unknown admin command: bogus/);
  }
  expect(code).toBe(1);
});

// --- The overview has to answer the questions people actually arrive with. ----

test("the overview documents the global options", () => {
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  for (const flag of ["--json", "--version", "--help"]) {
    expect(text, `overview omits ${flag}`).toContain(flag);
  }
});

test("the overview explains how several programs share one machine", () => {
  // A reader has to be able to learn from the help alone how to run a second
  // mailbox without the two runs colliding.
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });

  expect(text).toMatch(/EMAIL_INBOX_CONFIG/);
  expect(text).toMatch(/One config = one mailbox/);
});

test("the overview no longer advertises the shared-state commands", () => {
  // They are gone; a help that still names them sends people to a typo.
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  expect(text).not.toMatch(/cfmail use\b/);
  expect(text).not.toMatch(/cfmail accounts\b/);
});

test("a leftover --email says what replaced it instead of just rejecting it", () => {
  // Scripts and skills written against the old CLI still pass it; "unknown
  // option" would leave them with no idea what to do.
  let code = 0, stderr = "";
  try {
    execFileSync("node", [BIN, "unread", "--email", "x@y.com"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    code = e.status;
    stderr = e.stderr;
  }
  expect(code).toBe(1);
  expect(stderr).toMatch(/EMAIL_INBOX_CONFIG/);
});

test("setup still takes --email: there it names the mailbox, not a selection", () => {
  expect(help("setup")).toContain("--email");
});

test("no command's help still talks about a \"current mailbox\"", () => {
  // The concept is gone: one config file is one mailbox. Help that still names
  // it sends the reader looking for a setting that no longer exists.
  for (const cmd of [...Object.keys(COMMANDS), "stats", "config", "admin"]) {
    expect(help(cmd), cmd).not.toMatch(/current mailbox/i);
  }
});

test("the overview mentions it only to say there isn't one", () => {
  // The overview is the one place worth naming it, because a reader arriving
  // from the old CLI is looking for it.
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  for (const line of text.split("\n").filter((l) => /current mailbox/i.test(l))) {
    expect(line, line.trim()).toMatch(/no .*"current mailbox"/i);
  }
});

test("the overview says where a new mailbox's key comes from", () => {
  // "How do I add a mailbox" is answered by two commands owned by two roles;
  // an overview listing only `setup` leaves the reader without a key.
  const text = execFileSync("node", [BIN, "--help"], { encoding: "utf8" });
  const config = text.slice(text.indexOf("\nConfiguration\n"), text.indexOf("\nAdmin ("));

  expect(config).toContain("admin create-key");
  expect(config).toContain("cfmail setup");
});
