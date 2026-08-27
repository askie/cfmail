#!/usr/bin/env node
// cfmail — command-line client for a cloudflare-email mailbox.
//
// Every command accepts --json for machine-readable output; failures then print
// a JSON object too, and always exit non-zero.

import pkg from "../package.json" with { type: "json" };
import { setJsonMode, out, fail } from "../src/output.mjs";

import * as setup from "../src/commands/setup.mjs";
import * as unread from "../src/commands/unread.mjs";
import * as list from "../src/commands/list.mjs";
import * as read from "../src/commands/read.mjs";
import * as search from "../src/commands/search.mjs";
import * as attachment from "../src/commands/attachment.mjs";
import * as stats from "../src/commands/stats.mjs";
import * as send from "../src/commands/send.mjs";
import * as sync from "../src/commands/sync.mjs";
import * as prune from "../src/commands/prune.mjs";
import * as config from "../src/commands/config.mjs";
import * as admin from "../src/commands/admin.mjs";

const COMMANDS = {
  setup, unread, list, read, search, attachment, stats, send, sync, prune, admin,
  config,
  // Replying is sending with the id given positionally; one implementation.
  reply: { help: send.replyHelp, run: (argv) => send.run(argv, { replyPositional: true }) },
};

const USAGE = `cfmail — command-line client for a cloudflare-email mailbox

Receiving
  cfmail unread [--peek] [--all] [--limit N] [--reset]   fetch the latest unread mail
  cfmail list [--from X] [--subject X] [--limit N]       list mail matching filters
  cfmail read <email-id> [--html]                        read one email's full text and attachment list
  cfmail search "keyword" [--limit N]                    full-text search (Chinese included)
  cfmail attachment <attachment-id> --out <path>         download an attachment
  cfmail stats                                           mailbox summary

Local archive
  cfmail sync --dir ~/mail                               archive mail by day to local disk (body + attachments)
  cfmail sync                                            only sync new mail after that
  cfmail prune --older-than 90d                          dry run: preview cleaning up old archives
  cfmail prune --older-than 90d --yes                    actually delete (local only, server untouched)

Sending
  cfmail send --to a@x.com --subject "subject" --text "body"  send one
  cfmail reply <email-id> --text "reply text"                 reply within the original thread
    --attach <path>               attach a local file
    --forward-attachment <id>     forward a received attachment (no download needed)
    --text-file <path>            read the body from a file (easier for long or Chinese text)

Configuration
  cfmail setup --base <url> --email <address> --key <key>  configure a mailbox and verify it right away
  cfmail config                                            see which mailbox this config points at

  Opening a new mailbox address is two steps, owned by two roles:
    1. Admin  cfmail admin create-key <address>    issue a key (shown once)
    2. User   cfmail setup --base ... --key ...    configure that key on your machine
  If you're doing both yourself, just run them in order.

Admin (needs the admin token)
  cfmail admin setup --base <url> --key <admin-token>
  cfmail admin create-key <email>          open a mailbox for an address
  cfmail admin list-keys                   list issued keys
  cfmail admin delete-key <email>          revoke an address's key
  cfmail admin webhook [--set <url>|--clear]

General
  --json          machine-readable output (failures are JSON too, with a non-zero exit code)
  --version       show the version

Every command answers --help with the full option reference and examples:
  cfmail send --help
  cfmail prune --help
  cfmail admin webhook --help

One config = one mailbox
  There's no "current mailbox" shared setting, so there's nothing for another
  program to change out from under you. To receive a second mailbox, open a
  second config file:

    export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
    cfmail setup --base <service-url> --email work@example.com --key <key>
    cfmail unread                               this process uses that one from now on

  The key, unread cursor, archive directory, and push settings each live in
  their own file, invisible to each other. Several Agents running at once
  just need their own EMAIL_INBOX_CONFIG.
  A config file being read and written concurrently is safe too: no update is
  lost, and no one ever reads a half-written file.

Environment variables (take priority over the config file)
  EMAIL_INBOX_CONFIG  Config file path — switch it and you get a fully separate setup
  EMAIL_INBOX_BASE    Service URL
  EMAIL_INBOX_KEY     API key
  Same pattern for admin with EMAIL_ADMIN_* (BASE / KEY / CONFIG).`;

// `cfmail list | head -3` closes the pipe while we are still writing, and node
// turns that into an unhandled 'error' event: a stack trace where the user
// expected three lines. Downstream leaving early is normal, not a failure.
process.stdout.on("error", (e) => {
  if (e?.code === "EPIPE") process.exit(0);
  throw e;
});

async function main() {
  const argv = process.argv.slice(2);
  const name = argv[0];

  if (!name || name === "--help" || name === "-h" || name === "help") return out(USAGE);
  if (name === "--version" || name === "-v") return out(`cfmail ${pkg.version}`);

  const cmd = COMMANDS[name];
  if (!cmd) fail(`unknown command: ${name}\n\nRun \`cfmail --help\` to see what is available.`);

  let rest = argv.slice(1);
  // --json is global, so strip it before the command parses its own flags.
  if (rest.includes("--json")) {
    setJsonMode(true);
    rest = rest.filter((a) => a !== "--json");
  }

  // --email used to be a global that picked a mailbox. A config file is now one
  // mailbox, so the flag is gone — but scripts and skills written against the
  // old CLI still pass it, and "unknown option" would not tell them what to do.
  if (rest.includes("--email") && name !== "setup") {
    fail(
      "--email is no longer a global option: one config file is one mailbox.\n" +
      "Point EMAIL_INBOX_CONFIG at that mailbox's config instead:\n" +
      "  EMAIL_INBOX_CONFIG=~/.config/email-inbox/<name>.json cfmail " + name
    );
  }

  // A command that dispatches further exports `help` as a function, so it can
  // answer for whichever subcommand was asked about. Returning nothing means it
  // did not recognise the subcommand — fall through to run(), which reports the
  // typo rather than printing help and exiting 0.
  if (rest.includes("--help") || rest.includes("-h")) {
    const text = typeof cmd.help === "function" ? cmd.help(rest) : cmd.help;
    if (text) return out(text);
  }

  await cmd.run(rest);
}

main().catch((e) => fail(e?.message || String(e)));
