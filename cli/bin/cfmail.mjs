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

配置
  cfmail setup --base <url> --email <地址> --key <key>    配置邮箱并当场验证
  cfmail config                                          看当前配的是哪个邮箱

  新开一个邮箱地址要两步，分属两个角色：
    1. 管理员  cfmail admin create-key <地址>    签发 Key（只显示这一次）
    2. 使用者  cfmail setup --base ... --key ... 拿这把 Key 配到自己机器上
  两步都是自己做的话，照着顺序跑一遍即可。

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

一份配置 = 一个邮箱
  没有「当前邮箱」这种共享设置，所以不存在被别的程序改掉的问题。
  要再收一个邮箱，就再开一份配置：

    export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
    cfmail setup --base <服务地址> --email work@example.com --key <Key>
    cfmail unread                               这个进程之后都走 work 这份

  密钥、未读游标、归档目录、推送设置都在各自的文件里，互相看不见。
  几个 Agent 同时跑，各设各的 EMAIL_INBOX_CONFIG 就行。
  同一份配置被并发读写也是安全的：不会丢更新，也不会读到写了一半的内容。

环境变量（优先于配置文件）
  EMAIL_INBOX_CONFIG  配置文件路径，换一个就是一套完全独立的设置
  EMAIL_INBOX_BASE    服务地址
  EMAIL_INBOX_KEY     API Key
  管理端同理 EMAIL_ADMIN_*（BASE / KEY / CONFIG）。`;

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
