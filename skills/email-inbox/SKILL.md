---
name: email-inbox
description: Fetch the latest unread emails from a cloudflare-email mailbox using a bound API key. Use when the user asks to check mail, read new/unread emails, look for a code/invoice/notification in their inbox, or poll a mailbox served by a cloudflare-email (MCP) service. Tracks read state locally so repeated runs only return new mail.
---

# email-inbox

收取来自 **cloudflare-email** 服务的最新未读邮件。这个服务把发到某个域名的邮件存档，并通过 MCP 接口开放查询。你（或你的 Agent）拿到一个绑定到某个邮箱地址的 **API Key**，就能只读取属于这个邮箱的邮件。

这份技能是**自包含**的：把整个 `email-inbox/` 目录拷到任意 Agent 的技能目录即可使用，运行时只依赖 Node 18+（用内置 `fetch`，无需 `npm install`）。

## 何时使用

当用户要求：查收邮件 / 看有没有新邮件 / 读未读邮件 / 找验证码、发票、账单、通知 / 轮询某个邮箱时。

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

## 读全文与附件

`fetch-unread` 只返回摘要和每封邮件的 `id`。要读全文或取附件，直接调用该服务的 MCP 工具（这些工具同样受你的 Key 限定在你的邮箱内）：

- `get_email(id, include_html?)` —— 读某封邮件的完整正文与附件清单。
- `get_attachment(attachment_id)` —— 取某个附件的字节（base64）。
- `search_emails(query, limit?)` —— 全文搜索（支持中文）。
- `list_emails(...)` —— 按发件人/时间等筛选。

如果你的 Agent 已把这个 cloudflare-email 服务注册为 MCP 服务器，直接用上面这些工具即可；否则用 `fetch-unread.mjs --json` 配合 `id` 也能驱动后续查询脚本。

## 给 Agent 的执行提示

1. 用户首次提到「查邮件」而本机还没有配置文件（`config.json` 不存在）时，先问齐 base / email / key 三个要素，跑 `setup.mjs`。
2. 之后每次「看有没有新邮件」直接跑 `fetch-unread.mjs`，把结果用自然语言转述给用户。
3. 用户说「这封打开看看 / 把附件下载下来」时，用邮件 `id` 调 `get_email` / `get_attachment`。
4. 报错 401 表示 Key 失效或填错，提示用户重新设置；连接错误则检查 base 地址是否可达。

## 故障排查

- **401**：API Key 不对或已被管理员删除 —— 重新 `setup.mjs`。
- **连不上 / 超时**：确认 base 地址正确且可访问（不要用会被阻断的 `*.workers.dev`，用服务方的自定义域名）。
- **首次就没有邮件**：该邮箱确实还没收到过邮件；可让发件人发到这个地址再试。
- **想重新看全部**：删掉配置里的 `cursor`（或设为 0）后再 `fetch-unread.mjs`。
