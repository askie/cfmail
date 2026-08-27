---
name: email-admin
description: Administer a cloudflare-email service with the admin key using the cfmail CLI. Use when the user wants to open a mailbox for someone (issue an API key bound to an email address), list or revoke issued keys, or configure the new-email webhook. Requires the service's admin token (MCP_TOKEN). The companion email-inbox skill is what an ordinary user runs with the key issued here.
---

# email-admin

用**管理员密钥**管理一台 **cloudflare-email** 服务：开通邮箱、签发/吊销访问密钥、配置新邮件通知。

管理员密钥就是服务部署时设置的 `MCP_TOKEN`。它能解锁普通邮箱密钥看不到的管理工具。普通用户拿到这里签发的 Key 后，用配套的 **email-inbox** 技能收发邮件。

所有操作走 `cfmail admin` 子命令，从任何目录都能跑。

## 何时使用

当用户（管理员）要求：给某人开一个邮箱 / 签发或重置访问密钥 / 看已经开通了哪些邮箱 / 吊销某人的密钥 / 设置新邮件通知地址时。

## 两个要素

1. **服务地址**：例如 `https://mail.example.com`（不带 `/mcp`）。
2. **管理员密钥**：服务的 `MCP_TOKEN`。**这是最高权限凭证，绝不能交给普通用户、不要泄露。**

## 前置：安装 cfmail（一次性）

```bash
cfmail --version
```

没有就装（需要 Node 20+）：

```bash
npm install -g cfmail
```

要跑仓库里最新未发布的代码才用源码安装：

```bash
git clone https://github.com/askie/cfmail.git
cd cfmail/cli && npm i -g $(npm pack | tail -1)
```

## 第一步：设置接入点（一次性）

```bash
cfmail admin setup --base <服务地址> --key <管理员MCP_TOKEN>
```

命令会连服务确认这把钥匙**确实是管理员密钥**（能看到管理工具才算通过），通过后写到 `~/.config/email-admin/config.json`（与普通用户的配置文件分开存放）。密钥只存在本机。

## 开通一个邮箱

```bash
cfmail admin create-key alice@你的域名
```

输出里的 **API Key 只显示这一次**，请立刻交给使用者。命令会顺带打印对方该跑的配置命令，直接转给他即可。

> 地址不需要预先创建。服务对整个域名做 catch-all 收信，签发 Key 的动作就是把某个地址的收件权限绑给这把 Key。

## 其余管理命令

```bash
cfmail admin list-keys                    # 看已发放的 Key（只列邮箱，不回显密钥）
cfmail admin delete-key alice@你的域名     # 吊销，立即失效
cfmail admin webhook                      # 看当前通知设置
cfmail admin webhook --set whk_xxx        # 新邮件推到 Grix 聊天里
cfmail admin webhook --set https://...    # 或 POST 原始 JSON 给自己的程序
cfmail admin webhook --clear              # 关闭通知
```

新邮件通知支持两种目标，服务按值的形态自动判断：`whk_` 开头是 Grix key（推送成一条可读的聊天消息），`http(s)://` 开头是普通 webhook（发原始 JSON 事件）。推送失败只记日志，不影响收信。

任何命令加 `--json` 可得到机器可读输出，失败时也是 JSON 且退出码非 0。

## 给 Agent 的执行提示

1. 首次管理操作而没有配置（报 `no service URL configured`）时，先问齐服务地址和管理员密钥，跑 `cfmail admin setup`。
2. 用户说「给 X 开个邮箱」→ `cfmail admin create-key X`，把输出里的 Key 和配置命令一起转达，并提醒**只显示这一次**。
3. 用户说「谁在用」→ `cfmail admin list-keys`；说「停掉某人」→ `cfmail admin delete-key <邮箱>`，执行前先复述要吊销谁并确认。
4. **管理员密钥绝不能出现在给普通用户的输出里**。要给普通用户的只有 `create-key` 签发出来的那把。
5. 报 `this key is not an admin token` 说明配的是普通邮箱 Key，不是 `MCP_TOKEN`。

## 故障排查

- **`cfmail: command not found`**：CLI 没装，重新跑上面「前置」里的安装命令。
- **401**：管理员密钥不对 —— 确认它是部署时 `wrangler secret put MCP_TOKEN` 设的那个值。
- **`this key is not an admin token`**：连上了，但这把 Key 只有普通邮箱权限。
- **连不上 / 超时**：确认服务地址正确且可访问。
- **签发后用户收不到信**：确认域名的 Email Routing catch-all 已指向这个 Worker，且地址域名和服务域名一致。
