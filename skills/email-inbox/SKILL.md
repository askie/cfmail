---
name: email-inbox
description: Read and send mail through a cloudflare-email mailbox using the cfmail CLI. Use when the user asks to check mail, read new/unread emails, look for a code/invoice/notification in their inbox, poll a mailbox served by a cloudflare-email (MCP) service, or send/reply to an email from that address (with attachments, including forwarding a received attachment). Tracks read state locally so repeated runs only return new mail.
---

# email-inbox

收发 **cloudflare-email** 邮箱里的邮件。这个服务把发到某个域名的邮件存档；你拿到一把绑定到某个邮箱地址的 **API Key**，就能读取属于这个邮箱的邮件，并**以这个地址发信**。

所有操作都通过 `cfmail` 这个命令行工具完成，从任何目录都能跑，不用 `cd` 到技能目录。

## 何时使用

- **收**：查收邮件 / 看有没有新邮件 / 读未读邮件 / 找验证码、发票、账单、通知 / 轮询某个邮箱
- **发**：发一封邮件 / 回复某封邮件 / 把某个附件发给谁 / 把收到的附件转发出去

## 前置：安装 cfmail（一次性）

先看有没有装：

```bash
cfmail --version
```

没有就装，两种来源任选（需要 Node 20+）：

```bash
# 已经有仓库
npm i -g /path/to/cloudflare-email/cli

# 没有仓库就先取一份（npm 不支持直接装 git 仓库的子目录）
git clone https://github.com/askie/cloudflare-email.git
npm i -g ./cloudflare-email/cli
```

装完 `cfmail` 在任何目录都能用，不需要 `cd` 到技能目录。

## 第一步：配置接入点（一次性）

```bash
cfmail setup --base <服务地址> --email <你的邮箱> --key <你的API Key>
```

- **服务地址**：例如 `https://mail.example.com`，不带 `/mcp`
- **邮箱地址**：这把 Key 绑定的收件地址，仅用于显示，权限由 Key 决定
- **API Key**：一串 32 位十六进制字符，由服务管理员发放。**这是凭证，不要泄露。**

命令会当场连服务验证，看到 `✅ Connected` 才算成功。配置写到 `~/.config/email-inbox/config.json`，Key 只存在本机这个文件里。

## 一台机器多个邮箱

对每个邮箱各跑一次 `cfmail setup` 即可，它们各有自己的密钥、未读游标、归档目录和通知设置。

```bash
cfmail accounts              # 看本机配了哪些，▸ 是当前那个
cfmail use <邮箱>             # 切换当前邮箱
cfmail unread --email <邮箱>  # 只这一次用别的邮箱，不改当前设置
```

配了多个之后，命令输出会标明当前是哪个邮箱。

## 收邮件

```bash
cfmail unread                      # 收最新未读（首次给存量，之后只给新的）
cfmail unread --peek               # 只看，不标记已读
cfmail unread --all                # 忽略已读状态，看最近的
cfmail unread --reset              # 把当前全部标为已读
cfmail read <邮件id>                # 读全文，末尾列出附件 id
cfmail read <邮件id> --html         # 连 HTML 正文一起
cfmail search "关键字"              # 全文搜索，中文可用
cfmail list --from someone@x.com   # 按发件人/主题/时间筛选
cfmail attachment <附件id> --out ./file.pdf   # 下载附件
cfmail stats                       # 邮箱统计
```

> 服务端不记录已读/未读。本机用一个游标记住「看到哪儿了」，每次只返回更新的邮件。已读状态是每台机器各自的。

## 归档到本地 / 定时清理

把邮件正文和附件按天存到本地目录：

```bash
cfmail sync --dir ~/cfmail     # 第一次指定目录，之后记住
cfmail sync                  # 之后只同步新邮件
cfmail sync --html           # 连 HTML 正文一起
```

目录结构是 `~/cfmail/2026-08-27/0930-主题-邮件id/`，里面有 `meta.json`、`body.txt` 和 `attachments/`。已存过的会跳过，邮箱再大也会自动翻页取全。

验证码、通知这类邮件常常只有 HTML 没有纯文本，`body.txt` 会是空的——这时会多一个 `body.md`，是 HTML 转成的 Markdown，推送通知也用它。

清理旧归档：

```bash
cfmail prune --older-than 90d          # 预演，只报告
cfmail prune --older-than 90d --yes    # 真删
```

**只删本地归档，服务器上的邮件不受影响。** 不加 `--yes` 只是预演；`--dir` 指到非归档目录会被拒绝。

## 新邮件推送到 Grix（带本地文件链接）

归档时顺手把新邮件推到 Grix，消息里带可点击的本地文件路径：

```bash
cfmail sync --dir ~/cfmail --notify whk_你的key   # 配一次，之后记住
cfmail sync                                      # 以后每次自动推新邮件
cfmail sync --no-notify                          # 这次不推
```

点附件名直接打开文件，点「打开邮件目录」打开整封邮件的文件夹。

第一次开启不会补推历史邮件（已归档的直接标记为已通知）；推送过的邮件目录里留 `.notified` 标记，反复跑 sync 不会重复推；推送失败不写标记，下次自动重试。

> 服务端跑在 Cloudflare 上碰不到本地硬盘，所以带文件链接的通知只能由本地发。如果同时配过 `cfmail admin webhook`，两边会各推一条，二选一即可。

## 发邮件与回信

用**这把 Key 绑定的地址**发信。发件人不能指定，服务端强制用绑定地址，所以你发不出别人的地址。

```bash
cfmail send --to a@x.com --subject "标题" --text "正文"
cfmail reply <邮件id> --text "回复内容"
cfmail send --to a@x.com --subject "报表" --text "见附件" --attach ./report.pdf
cfmail reply <邮件id> --text "转给你" --forward-attachment <附件id>
```

| 参数 | 作用 |
|---|---|
| `--to <地址>` | 收件人，可重复给多个 |
| `--cc <地址>` | 抄送，可重复 |
| `--subject <标题>` | 主题；回信时可省略，自动取 `Re: 原主题`，显式给了以你给的为准 |
| `--text <正文>` | 纯文本正文 |
| `--text-file <路径>` | 正文从文件读，**正文长或含多行、中文时用这个更省事** |
| `--attach <路径>` | 附上本地文件，可重复；MIME 类型按扩展名自动判断 |
| `--forward-attachment <附件id>` | 转发已存的附件，**不用先下载再上传** |

两个要点：

- **回信一定用 `cfmail reply <邮件id>`**：它会带上 `In-Reply-To`/`References`，收件人那边能看到是同一串对话，多轮往返也不断线。手工拼 `--to` + `--subject "Re: ..."` 做不到。
- **转发收到的附件用 `--forward-attachment`**：附件 id 来自 `cfmail read <邮件id>`。字节在服务端内部流转，几十 MB 的文件也不用下载到本地再传上去。

## 机器可读输出

任何命令加 `--json` 就输出 JSON，失败时也是 JSON（且退出码非 0），便于脚本处理：

```bash
cfmail unread --peek --json
cfmail send --to a@x.com --subject s --text b --json
```

## 给 Agent 的执行提示

1. 用户首次提到「查邮件」而 `cfmail --version` 跑不通时，先装 CLI；能跑但报「no service URL configured」时，问齐服务地址 / 邮箱 / Key 三个要素跑 `cfmail setup`。
2. 之后「看有没有新邮件」直接 `cfmail unread`，把结果用自然语言转述。
3. 「这封打开看看」→ `cfmail read <id>`；「把附件下载下来」→ 先 `cfmail read <id>` 拿附件 id，再 `cfmail attachment <附件id> --out <路径>`；「搜一下 xxx」→ `cfmail search "xxx"`。
4. 「回复这封」→ 用 `cfmail reply <邮件id>`，不要手工拼收件人和主题。要连附件一起转，先 `cfmail read` 拿附件 id，再加 `--forward-attachment`。
5. 正文超过一两行、或含中文和换行时，先把正文写进临时文件再用 `--text-file`，比在命令行里塞长字符串可靠。
6. **发信前先把收件人、主题、正文复述给用户确认**，尤其收件人不是用户自己时——邮件发出去收不回来。
7. 用户提到某个具体邮箱（「看看工作邮箱有没有新邮件」）而本机配了多个时，用 `--email <地址>` 指定，别贸然 `cfmail use` 改掉他的当前设置。不确定有哪些就先跑 `cfmail accounts`。
8. 用户说「把邮件存到本地 / 备份下来」→ `cfmail sync --dir <目录>`；说「新邮件通知我 / 推到聊天里」→ `cfmail sync --notify <whk_key>`；说「清理旧邮件」→ 先跑不带 `--yes` 的 `cfmail prune --older-than <期限>` 把清单给用户看，**确认后**再加 `--yes`。
9. 需要程序化处理结果时加 `--json`，靠退出码判断成败。

## 故障排查

- **`cfmail: command not found`**：CLI 没装或不在 PATH，重新跑上面「前置」里的安装命令。
- **401**：Key 不对或已被管理员吊销 —— 重新 `cfmail setup`。
- **连不上 / 超时**：确认服务地址正确且可访问（不要用会被阻断的 `*.workers.dev`，用自定义域名）。
- **首次就没有邮件**：该邮箱确实还没收到过邮件。
- **想重新看全部**：`cfmail unread --all`，或删掉配置里的 `cursor`。
- **发信报 `E_RECIPIENT_NOT_ALLOWED` 或域名未验证**：服务端还没配好对外发信，只能发给已验证的地址 —— 这要服务管理员处理。
- **发信报附件超限**：附件会 base64 编码、体积涨三分之一，服务按编码后的大小判断。换小文件或分几封发。

> 如果你的 Agent 已经把这个服务注册为 MCP 服务器，也可以直接调用 `list_emails` / `get_email` / `get_attachment` / `search_emails` / `send_email` 工具，效果等价。`cfmail` 是给**没有**注册 MCP 服务器的场景用的，也更适合脚本化。
