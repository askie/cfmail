---
name: email-inbox
description: Read and send mail through a cloudflare-email mailbox using a bound API key. Use when the user asks to check mail, read new/unread emails, look for a code/invoice/notification in their inbox, poll a mailbox served by a cloudflare-email (MCP) service, or send/reply to an email from that address (with attachments, including forwarding a received attachment). Tracks read state locally so repeated runs only return new mail.
---

# email-inbox

收发 **cloudflare-email** 服务上的邮件。这个服务把发到某个域名的邮件存档，并通过 MCP 接口开放查询和发送。你（或你的 Agent）拿到一个绑定到某个邮箱地址的 **API Key**，就能读取属于这个邮箱的邮件，也能**以这个地址发信**。

这份技能是**自包含**的：把整个 `email-inbox/` 目录拷到任意 Agent 的技能目录即可使用，运行时只依赖 Node 18+（用内置 `fetch`，无需 `npm install`）。

## 何时使用

当用户要求：

- **收**：查收邮件 / 看有没有新邮件 / 读未读邮件 / 找验证码、发票、账单、通知 / 轮询某个邮箱
- **发**：发一封邮件 / 回复某封邮件 / 把某个附件发给谁 / 把收到的附件转发出去

## 三个要素（缺一不可）

1. **服务地址 base**：例如 `https://mail.example.com`（cloudflare-email 服务的根地址，不带 `/mcp`）。
2. **邮箱地址 email**：这个 Key 绑定的收件地址，例如 `you@example.com`（仅用于显示，权限由 Key 决定）。
3. **API Key**：形如一串32位十六进制字符，由该服务的管理员用 `create_api_key` 生成并交给你。**它是凭证，不要泄露。**

> 关于「未读」：服务端不记录已读/未读状态。本技能在**本机**用一个游标（cursor）记住「已经看过的最新一封邮件的时间」，每次只返回比游标更新的邮件，然后推进游标。已读状态是每台机器各自的。

## 运行位置（重要）

下面所有命令都写成相对路径（`scripts/setup.mjs`、`scripts/fetch-unread.mjs`），必须在**本技能目录**（这份 `SKILL.md` 所在的目录，如 `.claude/skills/email-inbox/`）下执行才能找到脚本。执行前先 `cd` 到这个目录；如果不确定当前目录，用 `SKILL.md` 自己的路径推出技能目录再 `cd` 进去，或者直接把命令里的脚本路径换成绝对路径。

## 第一步：设置接入点（一次性）

用三个要素配置并**当场验证连通性**：

```bash
node scripts/setup.mjs --base <服务地址> --email <你的邮箱> --key <你的API Key>
```

看到 `✅ Connected` 和可见邮件数量即表示接入成功。配置默认写到 `~/.config/email-inbox/config.json`（可用环境变量 `EMAIL_INBOX_CONFIG` 改路径）。Key 只保存在本机这个文件里。

## 第二步：收取最新未读邮件

```bash
node scripts/fetch-unread.mjs
```

- 首次运行返回最近的存量邮件（默认最多 20 封），并把它们标记为已读；
- 之后每次只返回**新到的**邮件。

常用参数：

| 命令 | 作用 |
|---|---|
| `node scripts/fetch-unread.mjs` | 列出未读并标记已读（推进游标） |
| `node scripts/fetch-unread.mjs --peek` | 列出未读但**不**标记已读 |
| `node scripts/fetch-unread.mjs --all` | 忽略已读状态，看最近邮件 |
| `node scripts/fetch-unread.mjs --limit 50` | 限制返回数量（1–100） |
| `node scripts/fetch-unread.mjs --reset` | 把当前所有邮件标记为已读 |
| `node scripts/fetch-unread.mjs --json` | 机器可读输出（便于程序处理） |

## 读全文、搜索与附件

`fetch-unread` 默认**不下载正文**，只返回摘要（发件人/主题/日期/纯文本 snippet）和每封邮件的 `id`。要看正文、搜全文或存附件，用下面几个脚本（同样受你的 Key 限定在你的邮箱内，不需要额外配置）：

```bash
node scripts/get-email.mjs <id>                    # 读正文（纯文本）
node scripts/get-email.mjs <id> --html              # 同时取 HTML 正文（默认不取）
node scripts/get-email.mjs <id> --json               # 机器可读，含 attachments 列表
node scripts/search-emails.mjs "<关键字>"             # 全文搜索（支持中文）
node scripts/get-attachment.mjs <attachment_id> --out ./file.pdf   # 下载附件
```

`get-email.mjs` 会在输出末尾列出附件的 `id`，拿着它去 `get-attachment.mjs` 下载即可。

## 发邮件与回信

用**这个 Key 绑定的地址**发信。发件人不能指定，服务端强制用绑定地址，所以你发不出别人的地址。

```bash
node scripts/send-email.mjs --to a@x.com --subject "标题" --text "正文"
node scripts/send-email.mjs --reply <email_id> --text "回复内容"
node scripts/send-email.mjs --to a@x.com --subject "报表" --text "见附件" --attach ./report.pdf
node scripts/send-email.mjs --reply <email_id> --text "转给你" --forward-attachment <attachment_id>
```

| 参数 | 作用 |
|---|---|
| `--to <地址>` | 收件人，可重复给多个 |
| `--cc <地址>` | 抄送，可重复 |
| `--subject <标题>` | 主题；用 `--reply` 时可省略，自动取原邮件的 `Re: 原主题` |
| `--text <正文>` | 纯文本正文 |
| `--text-file <路径>` | 正文从文件读，**正文长或含多行、中文时用这个更省事** |
| `--reply <邮件id>` | 在原会话里回信：收件人、主题、会话线索全部自动推导 |
| `--attach <路径>` | 附上本地文件，可重复；MIME 类型按扩展名自动判断 |
| `--forward-attachment <附件id>` | 转发已存的附件，**不用先下载再上传** |
| `--json` | 机器可读输出 |

两个要点：

- **回信优先用 `--reply`**：它会带上 `In-Reply-To`/`References`，收件人那边能看到是同一串对话，多轮往返也不断线。手工拼 `--to` + `--subject "Re: ..."` 做不到这一点。
- **转发收到的附件用 `--forward-attachment`**：附件 id 来自 `get-email.mjs <id> --json`。字节在服务端内部流转，几十 MB 的文件也不用下载到本地再传上去。

发送失败时脚本会把服务返回的错误码和处置建议一起打出来，例如：

```
发送失败: destination address is not a verified address
错误码: E_RECIPIENT_NOT_ALLOWED
怎么办: Recipient is not a verified destination address. ...
```

照着「怎么办」那句做即可，通常是服务的管理员需要在后台补一次配置。

> 如果你的 Agent 已经把这个 cloudflare-email 服务注册为 MCP 服务器，也可以直接调用 `get_email` / `get_attachment` / `search_emails` / `list_emails` / `send_email` 这些工具，效果等价；上面几个脚本是给**没有**注册 MCP 服务器的场景用的。

## 给 Agent 的执行提示

1. 用户首次提到「查邮件」而本机还没有配置文件（`config.json` 不存在）时，先问齐 base / email / key 三个要素，跑 `setup.mjs`。
2. 之后每次「看有没有新邮件」直接跑 `fetch-unread.mjs`，把结果用自然语言转述给用户。
3. 用户说「这封打开看看」时，用邮件 `id` 跑 `get-email.mjs <id>`（要 HTML 加 `--html`）；说「把附件下载下来」时先 `get-email.mjs <id> --json` 拿附件 `id`，再跑 `get-attachment.mjs`；说「搜一下 xxx」时跑 `search-emails.mjs "xxx"`。
4. 用户说「回复这封」时，务必用 `send-email.mjs --reply <邮件id>`，不要手工拼收件人和主题——只有 `--reply` 会带上会话线索。要连附件一起转，先 `get-email.mjs <id> --json` 拿附件 `id`，再加 `--forward-attachment`。
5. 正文超过一两行、或者含中文和换行时，先把正文写进临时文件再用 `--text-file`，比在命令行里塞长字符串可靠。
6. **发信前先把收件人、主题、正文复述给用户确认**，尤其是收件人不是用户自己的时候——邮件发出去收不回来。
7. 报错 401 表示 Key 失效或填错，提示用户重新设置；连接错误则检查 base 地址是否可达。

## 故障排查

- **401**：API Key 不对或已被管理员删除 —— 重新 `setup.mjs`。
- **连不上 / 超时**：确认 base 地址正确且可访问（不要用会被阻断的 `*.workers.dev`，用服务方的自定义域名）。
- **首次就没有邮件**：该邮箱确实还没收到过邮件；可让发件人发到这个地址再试。
- **想重新看全部**：删掉配置里的 `cursor`（或设为 0）后再 `fetch-unread.mjs`。
- **发信报 `E_RECIPIENT_NOT_ALLOWED` 或域名未验证**：服务端还没配好对外发信，只能发给已验证的地址 —— 这要服务的管理员处理，不是你这边的问题。
- **发信报附件超限**：邮件带附件时会 base64 编码、体积涨三分之一，服务按编码后的大小判断。换小一点的文件，或分几封发。
