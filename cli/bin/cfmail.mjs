#!/usr/bin/env node
// cfmail — command-line client for a cloudflare-email mailbox.
//
// Every command accepts --json for machine-readable output; failures then print
// a JSON object too, and always exit non-zero.

import pkg from "../package.json" with { type: "json" };
import { setJsonMode, out, fail } from "../src/output.mjs";
import { selectAccount } from "../src/config.mjs";

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
import * as accounts from "../src/commands/accounts.mjs";
import * as admin from "../src/commands/admin.mjs";

const COMMANDS = {
  setup, unread, list, read, search, attachment, stats, send, sync, prune, admin,
  accounts,
  use: { help: accounts.useHelp, run: accounts.runUse },
  forget: { help: accounts.forgetHelp, run: accounts.runForget },
  // Replying is sending with the id given positionally; one implementation.
  reply: { help: send.replyHelp, run: (argv) => send.run(argv, { replyPositional: true }) },
};

const USAGE = `cfmail — 收发 cloudflare-email 邮箱的命令行工具

收信
  cfmail unread [--peek] [--all] [--limit N] [--reset]   收最新未读邮件
  cfmail list [--from X] [--subject X] [--limit N]       按条件列邮件
  cfmail read <email-id> [--html]                        读某封的全文和附件清单
  cfmail search "关键字" [--limit N]                      全文搜索（支持中文）
  cfmail attachment <attachment-id> --out <path>         下载附件
  cfmail stats                                           邮箱统计

归档到本地
  cfmail sync --dir ~/mail                               把邮件按天存到本地（正文+附件）
  cfmail sync                                            之后只同步新邮件
  cfmail prune --older-than 90d                          预演清理旧归档
  cfmail prune --older-than 90d --yes                    真正删除（只删本地，不动服务器）

发信
  cfmail send --to a@x.com --subject "标题" --text "正文"  发一封
  cfmail reply <email-id> --text "回复内容"                在原会话里回信
    --attach <path>               带上本地文件
    --forward-attachment <id>     转发收到的附件（不用先下载）
    --text-file <path>            正文从文件读（长正文、中文更省事）

配置与多邮箱
  cfmail setup --base <url> --email <地址> --key <key>    配置一个邮箱并当场验证
  cfmail accounts                                        看本机配了哪些邮箱
  cfmail use <邮箱>                                       切换当前邮箱
  cfmail forget <邮箱>                                    删掉本机上这个邮箱的配置
  任何命令加 --email <地址>                                本次用这个邮箱

管理（需要管理员令牌）
  cfmail admin setup --base <url> --key <admin-token>
  cfmail admin create-key <email>          给某个地址开通邮箱
  cfmail admin list-keys                   看已发放的 Key
  cfmail admin delete-key <email>          吊销某个地址的 Key
  cfmail admin webhook [--set <url>|--clear]

通用
  --json          机器可读输出（失败也是 JSON，且退出码非 0）
  --version       看版本

每个命令后面加 --help，都有完整的参数说明和示例：
  cfmail send --help
  cfmail prune --help
  cfmail admin webhook --help

环境变量可覆盖配置文件：EMAIL_INBOX_BASE / EMAIL_INBOX_EMAIL / EMAIL_INBOX_KEY /
EMAIL_INBOX_CONFIG（管理端同理 EMAIL_ADMIN_*）。`;

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

  // --email is global too: it picks which configured mailbox the command acts
  // on, so no command has to thread it through. `setup` is the exception — there
  // the address is the account being created, and it parses it itself.
  const at = rest.indexOf("--email");
  if (at !== -1 && name !== "setup") {
    const value = rest[at + 1];
    if (value === undefined || value.startsWith("--")) fail("--email requires an address");
    selectAccount(value);
    rest = rest.filter((_, i) => i !== at && i !== at + 1);
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
