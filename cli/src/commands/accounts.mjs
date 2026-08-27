import { listAccounts, setCurrentAccount, removeAccount, configPath } from "../config.mjs";
import { parseArgs } from "../args.mjs";
import { out, json, fail, isJson } from "../output.mjs";

export const help = `用法: cfmail accounts

列出这台机器上配置过的所有邮箱，标出当前用哪个。

每个邮箱各有自己的密钥、未读游标、归档目录和通知设置，互不干扰。

切换与删除:
  cfmail use <邮箱>        把某个邮箱设为当前，之后的命令默认用它
  cfmail forget <邮箱>     删掉本机上这个邮箱的配置（不影响服务端）

临时用别的邮箱跑一条命令，不改当前设置:
  cfmail unread --email other@example.com

配置文件: ${configPath("user")}`;

export async function run(argv) {
  parseArgs(argv, {});
  const { current, names, accounts } = listAccounts("user");

  if (isJson()) {
    return json({
      ok: true,
      current: current || null,
      accounts: names.map((n) => ({
        email: n,
        base: accounts[n]?.base || null,
        sync_dir: accounts[n]?.syncDir || null,
        notify: !!accounts[n]?.notifyKey,
        current: n === current,
      })),
    });
  }

  if (!names.length) {
    return out("还没有配置任何邮箱。\n\n  cfmail setup --base <服务地址> --email <你的邮箱> --key <你的Key>");
  }

  out(`${names.length} 个邮箱：\n`);
  for (const n of names) {
    const a = accounts[n] || {};
    const mark = n === current ? "▸" : " ";
    out(`${mark} ${n}`);
    out(`    服务: ${a.base || "(未配置)"}`);
    if (a.syncDir) out(`    归档: ${a.syncDir}${a.notifyKey ? "  （新邮件推送到 Grix）" : ""}`);
  }
  out(`\n▸ 是当前邮箱。切换: cfmail use <邮箱>`);
}

export const useHelp = `用法: cfmail use <邮箱地址>

把某个邮箱设为当前，之后的命令默认用它。

只改本机的选择，不动服务端，也不影响其它邮箱的游标和归档。

多个程序同时用 cfmail 时不要用它
  「当前邮箱」是写进配置文件的共享状态，谁后跑谁说了算。几个 agent 各自
  cfmail use 会互相覆盖，然后都以为自己在操作别的邮箱。

  各自指定邮箱，互不干扰：

    cfmail unread --email work@example.com          每条命令自己带
    EMAIL_INBOX_EMAIL=work@example.com cfmail unread  或者整个进程固定一个

示例:
  cfmail use work@example.com
  cfmail accounts              看有哪些、当前是谁`;

export async function runUse(argv) {
  const { positional } = parseArgs(argv, {});
  const email = positional[0];
  if (!email) fail("missing address. Usage: cfmail use <邮箱地址>");

  setCurrentAccount(email, "user");
  if (isJson()) return json({ ok: true, current: email });

  out(`当前邮箱: ${email}`);
  // Worth saying wherever several mailboxes exist: this is shared state, and a
  // second program switching it out from under this one is silent.
  if (listAccounts("user").names.length > 1) {
    out(`\n本机有多个邮箱。如果还有别的程序在用 cfmail，让它们各自带 --email <地址>，\n别依赖「当前邮箱」——那是共享的，会被互相改掉。`);
  }
}

export const forgetHelp = `用法: cfmail forget <邮箱地址>

删掉本机上这个邮箱的配置：密钥、未读游标、归档目录和通知设置。

只删本机配置，服务端的邮箱和已经归档到磁盘的文件都不受影响；
这把 Key 也不会被吊销（那是管理员的 cfmail admin delete-key）。

示例:
  cfmail forget old@example.com`;

export async function runForget(argv) {
  const { positional } = parseArgs(argv, {});
  const email = positional[0];
  if (!email) fail("missing address. Usage: cfmail forget <邮箱地址>");

  const current = removeAccount(email, "user");
  if (isJson()) return json({ ok: true, removed: email, current: current || null });
  out(`已删除本机上 ${email} 的配置。`);
  out(current ? `当前邮箱: ${current}` : "已经没有配置任何邮箱了。");
}
