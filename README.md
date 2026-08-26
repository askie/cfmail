# cloudflare-email · 让 AI 帮你收邮件、查邮件

## 这是什么

一个搭在 [Cloudflare](https://cloudflare.com) 上的「邮件收件箱」，但它**没有网页界面**——它把收到的邮件交给 **AI 助手（比如 Claude）来读、来查**。

简单说：

> 发到 `任意名字@你的域名` 的邮件，会被自动收下来、存好。
> 然后你可以直接对 AI 说：「帮我找上周那封发票邮件」「最近有没有验证码邮件」「把那封邮件的附件下下来」——AI 就能查到并读给你。

它适合这些场景：

- 用一个自己的域名收**验证码、通知、账单、发票**等邮件，让 AI 统一帮你查找和整理。
- 给 AI Agent 一个「邮箱」，让它能自动读取收到的邮件来完成任务。
- 不想登录邮箱一封封翻，想用「问一句、答一句」的方式查邮件。

## 它能做什么

- 📥 **自动收信**：发到你域名下任意地址的邮件，全部收下并存档（正文 + 附件都留着）。
- 🔎 **AI 可查询**：AI 能搜索关键词、按发件人/时间筛选、读邮件全文、下载附件。
- 🈶 **中文也能搜**：中文主题和正文都能搜到。
- 📤 **能发信、能回信**：AI 可以用你的地址发邮件（走 Resend，也可用 Cloudflare 自带发信），还能对着某封邮件直接回复（自动带上原主题和会话线索）。
- 🔔 **新邮件提醒（可选）**：每来一封新邮件，可以自动通知到你指定的地址。
- 🔐 **有访问密码**：接口由一个密钥保护，只有持密钥的人/AI 才能查。

## 它是怎么跑的（一张图）

```
别人给你发邮件 ──▶ Cloudflare 收下 ──▶ 自动解析、存进数据库和文件存储
                                                  │
你 / 你的 AI 助手 ──问问题──▶ 这个服务的接口 ──查询──┘
```

技术细节（数据库表、检索原理、组件划分）见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 快速部署到 Cloudflare（约 10 分钟）

> 全部在你**自己的 Cloudflare 账号**里完成，邮件只存在你自己的账号下，别人碰不到。

### 你需要准备

1. 一个 **Cloudflare 账号**（免费版即可）。
2. 一个**已经添加到这个账号里的域名**（用来收邮件，也用来访问服务）。
3. 本机装好 **Node.js 18 以上**。

### 第 0 步：拿到代码、登录、建本地配置

```bash
git clone <this-repo> && cd cloudflare-email
npm install
npx wrangler login                       # 浏览器里登录你的 Cloudflare 账号
cp wrangler.jsonc wrangler.local.jsonc   # 你的私有配置，不会被上传到代码仓库
```

> 你的域名、数据库编号这些「跟你账号绑定」的信息，都填在 `wrangler.local.jsonc` 里。它已被忽略，不会进代码仓库；后面的命令会自动用它。

### 第 1 步：创建数据库（存邮件的元信息和正文）

```bash
npx wrangler d1 create email_db
```

命令会输出一个 `database_id`，把它复制到 `wrangler.local.jsonc` 里 `d1_databases[0].database_id` 那一行。

### 第 2 步：创建文件存储（存邮件原文和附件）

```bash
npx wrangler r2 bucket create email-store
```

### 第 3 步：填好你的域名

打开 `wrangler.local.jsonc`，把 `routes[0].pattern` 改成你想用的子域名，例如 `mail.yourdomain.com`（必须是你 Cloudflare 上的域名）。这个地址将来就是 AI 访问服务的入口。

### 第 4 步：建表 + 设访问密码 + 部署

```bash
npm run db:remote                        # 在数据库里建好表
npx wrangler secret put MCP_TOKEN        # 设一个访问密码（见下方提示）
npm run deploy                           # 部署上线
```

> **访问密码**：执行上面那条命令后，粘贴一段足够长的随机字符串作为密码。可以先用 `openssl rand -hex 32` 生成一个。这个密码 AI 接入时要用，**不要泄露**。

### 第 5 步：把「收到的邮件」转给这个服务

让发到你域名的所有邮件都进入这个服务（一次性配置）：

```bash
# 把 <ZONE_ID> 换成你域名的 Zone ID；<API_TOKEN> 换成一个有 “Email Routing 编辑” 权限的 Cloudflare API Token
curl -X PUT "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/email/routing/rules/catch_all" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  --data '{"enabled":true,"name":"catch-all to worker","matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["cloudflare-email"]}]}'
```

不想敲命令也可以在网页里点：**Cloudflare 控制台 → 你的域名 → Email Routing → Catch-all → 动作选 “Send to a Worker” → 选 `cloudflare-email`**。

> 如果这个域名以前没开过 Email Routing，先在控制台点一下开启（它会自动帮你加好收信需要的 DNS 记录）。

**完成！** 现在发到 `任意@你的域名` 的邮件都会被收下来，服务地址是 `https://你的子域名`。

---

## 让 AI 用起来

把下面信息给到你的 AI 客户端即可：

- 接口地址：`https://你的子域名/mcp`
- 访问密码（放在请求头里）：`Authorization: Bearer 你设置的密码`

**用 Claude Code，一行命令接入：**

```bash
claude mcp add --transport http email https://你的子域名/mcp \
  --header "Authorization: Bearer 你设置的密码"
```

**其他 MCP 客户端，用配置文件：**

```json
{
  "mcpServers": {
    "email": {
      "url": "https://你的子域名/mcp",
      "headers": { "Authorization": "Bearer 你设置的密码" }
    }
  }
}
```

接好之后，直接用大白话问 AI 就行，例如：

- 「搜一下含‘发票’的邮件」
- 「看看最近 10 封邮件」
- 「打开第一封，把附件下载下来」
- 「上个月有没有来自某某的邮件」

> 背后 AI 会用到这些能力：搜索 `search_emails`、列表 `list_emails`、读单封 `get_email`、取附件 `get_attachment`、统计 `stats`、发信 `send_email`，以及设置新邮件提醒 `set_webhook` / 查看 `get_webhook`。你不用记这些名字，AI 会自己选。

---

## 用「技能」让 Agent 上手（可移植，推荐）

上面那种方式要把整个服务当 MCP 服务器接进客户端。如果你想让某个 **AI Agent**（Claude Code、或任何支持 skill 的 Agent）直接「会收邮件、会开通邮箱」，用 `skills/` 目录下这两份**自包含技能**更省事——拷过去就能用，运行时只需要 Node 18+，**不用 `npm install`**。

```
skills/
  email-inbox/   普通用户：用绑定的 Key 收取最新未读邮件
  email-admin/   管理员：开通邮箱、签发/吊销 Key、配置新邮件提醒
```

两者配套：**管理员**用 `email-admin` 为某个邮箱地址签发一把 Key，**用户**把这把 Key 配进 `email-inbox` 就能收信。

### 第 1 步：把技能放进 Agent 的技能目录

把需要的技能整个目录拷过去即可。以 Claude Code 为例，技能目录是 `.claude/skills/`：

```bash
# 拷贝（任选其一或两个都拷）
cp -r skills/email-inbox  你的项目/.claude/skills/
cp -r skills/email-admin  你的项目/.claude/skills/
```

> 也可以软链接整个 `skills/`：`ln -s /路径/cloudflare-email/skills 你的项目/.claude/skills`。Agent 启动后会读取每个技能里的 `SKILL.md`，在合适的时候自动调用。

### 第 2 步（管理员）：开通一个邮箱

```bash
cd .claude/skills/email-admin
# 一次性配置：服务地址 + 管理员密钥（部署时设置的 MCP_TOKEN）
node scripts/admin.mjs setup --base https://你的子域名 --key <管理员MCP_TOKEN>
# 给某个地址开通邮箱，命令会打印一把明文 Key（只显示一次）
node scripts/admin.mjs create-key --email alice@你的域名
```

其它管理命令：`list-keys`（看已开通的邮箱）、`delete-key --email ...`（吊销）、`get-webhook` / `set-webhook --url ...`（新邮件提醒）。

### 第 3 步（用户）：用 Key 收信

```bash
cd .claude/skills/email-inbox
# 一次性配置：服务地址 + 自己的邮箱 + 上一步拿到的 Key
node scripts/setup.mjs --base https://你的子域名 --email alice@你的域名 --key <你的Key>
# 收取最新未读邮件（首次给最近的存量，之后只给新到的）
node scripts/fetch-unread.mjs
```

配好之后，对 Agent 说「看看有没有新邮件」「找一下验证码邮件」，它就会自己跑 `fetch-unread`，并按需用 `get_email` / `get_attachment` 读全文、取附件。

### 配置存哪、怎么改

- 连接信息（含 Key）只存在**运行 Agent 的本机**：
  - 用户端：`~/.config/email-inbox/config.json`
  - 管理端：`~/.config/email-admin/config.json`
- 可用环境变量覆盖文件，便于多账号或脚本化：`EMAIL_INBOX_BASE` / `EMAIL_INBOX_EMAIL` / `EMAIL_INBOX_KEY` / `EMAIL_INBOX_CONFIG`（管理端同理 `EMAIL_ADMIN_*`）。
- 「未读」由本机游标记录（服务端不分已读/未读）：`fetch-unread.mjs --peek` 只看不标记、`--all` 看最近全部、`--reset` 全部标为已读、`--json` 机器可读输出。

> 安全：`email-admin` 用的是最高权限的管理员密钥，**只配在管理员自己机器上，绝不要交给普通用户**；普通用户只该拿到 `email-inbox` 用的、绑定到自己邮箱的 Key。

---

## 试一下（30 秒跑通）

**第 1 步：发一封测试邮件。** 两种方式任选其一：

- 用你的手机或任意邮箱，给 `test@你的域名` 发一封邮件，主题、正文随便写。
- 或者用项目自带的自测脚本一键发送（会发一封带中文正文和 PDF 附件的样例邮件）：

  ```bash
  node scripts/send-test-email.mjs test@你的域名
  ```

**第 2 步：让 AI 查出来。** 对接好的 AI 说一句「帮我查最新的邮件」，它就能查到刚发的那封。AI 拿到的内容大致长这样：

```json
{
  "emails": [
    {
      "from": "selftest@你的域名",
      "subject": "测试邮件 发票 E2E",
      "date": 1781421031676,
      "has_attachments": true,
      "snippet": "你好，这是一封测试邮件，发票金额 8888 元。..."
    }
  ]
}
```

接着你就可以说「打开它」「把里面的附件下载下来」。

> 还没接 AI 也能验证：`npx wrangler tail cloudflare-email` 看是否收到，或直接查数据库：
> `npx wrangler d1 execute email_db --remote --command "SELECT subject,from_addr FROM emails ORDER BY date DESC LIMIT 3"`

---

## 发邮件（可选）

服务不只收信，也能用你的地址把邮件发出去。接好之后直接对 AI 说：

- 「用我的邮箱给 xxx@xx.com 发一封邮件，主题是……」
- 「回复刚才那封发票邮件，告诉对方已收到」——会自动带上原主题（`Re: …`）和会话线索，收件人那边能看到是同一串对话。

### 走哪条通道

有两个后端，**默认用 Resend**，没配 Resend 时自动退回 Cloudflare 自带的发信：

| | Resend（默认，推荐） | Cloudflare Email Sending（回退） |
| --- | --- | --- |
| 发给外部收件人 | 免费档 3000 封/月、100 封/天 | 要 Workers 付费计划 + 域名 onboarding |
| 发给自己已验证的地址 | 同上，计入额度 | 免费，不计配额 |
| 退信/打开率统计 | 有面板 | 没有 |
| 怎么启用 | 设一个 secret（见下） | 配 `send_email` binding |

两个都没配的话，发信会返回一句「没有可用的发信后端」并告诉你怎么配，收信和查询不受影响。

### 配置 Resend（约 5 分钟）

**1. 在 [Resend](https://resend.com) 注册，添加你的域名**——直接用根域 `yourdomain.com` 就行，不用退到子域。

**2. 在 Cloudflare DNS 里加它给的三条记录：**

| 类型 | 名称 | 值 | 代理 |
| --- | --- | --- | --- |
| MX | `send` | Resend 给的地址，优先级 10 | — |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
| TXT | `resend._domainkey` | Resend 给的 DKIM 公钥 | **DNS Only（关橙云）** |

> **不会和收信打架**：这条 MX 挂在 `send.yourdomain.com` 上（Resend 用它收退信），根域的 MX 仍然归 Email Routing。所以你可以用 `me@yourdomain.com` 发信，对方回过来又被这个服务收下——收发闭环在同一个地址上。
>
> DKIM 那条一定要关橙云代理，开着会验不过。

**3. 把 key 设成 secret：**

```bash
npx wrangler secret put RESEND_API_KEY -c wrangler.local.jsonc
```

设完就能发了。

### 想用 Cloudflare 自带的发信

不设 `RESEND_API_KEY`，改成确认 `wrangler.local.jsonc` 里有这一行（`wrangler.jsonc` 模板里已经带了）：

```jsonc
"send_email": [{ "name": "EMAIL" }],
```

然后去 Cloudflare 后台 Email → Email Sending 给域名做一次 onboarding。只发给自己在 Email Routing → Destination addresses 里验证过的地址的话，这步可以跳过，直接就能发且免费。

### 发件人是谁

- 用普通 Key 的用户：**只能用自己 Key 绑定的那个地址**发信，改不了，也发不出别人的地址。
- 管理员：没有绑定地址，发信时要自己指定 `from`。

发失败时工具会把错误码和该怎么处理一并返回，AI 能直接读懂告诉你。比如 `validation_error` 一般是域名还没在 Resend 验证通过。

---

## 新邮件提醒（可选）

想让新邮件来的时候自动通知你（或通知你的某个程序）？让 AI 执行：

```
set_webhook(url="https://你的接收地址")
```

之后每来一封邮件，服务就会往这个地址发一条 JSON 通知（含发件人、主题、摘要等）。不想要了就设成空：`set_webhook(url="")`。

---

## 从旧版本升级

如果你的服务是在「发信」功能之前部署的，数据库需要补一列（用来记住邮件的会话线索，让多轮回信不断线）：

```bash
npx wrangler d1 execute email_db --remote -c wrangler.local.jsonc \
  --command "ALTER TABLE emails ADD COLUMN refs TEXT"
```

跑一次就行，报「duplicate column」说明已经加过了，可以忽略。不加也能用，只是对**升级前收到的**老邮件回信时，会话线索会短一截。

---

## 日常维护

```bash
npx wrangler tail cloudflare-email        # 实时看收信和报错日志
npx wrangler secret put MCP_TOKEN         # 换访问密码（换完旧密码立即失效）
# 直接翻看最近 10 封邮件
npx wrangler d1 execute email_db --remote \
  --command "SELECT id,subject,from_addr,date FROM emails ORDER BY date DESC LIMIT 10"
```

> 提示：`wrangler.local.jsonc` 只存在你本机，记得别误删；删了就照「第 0 步」重新 `cp` 一份再把你的数据库编号和域名填回去。

---

## 给开发者：本地运行与自检

```bash
cp .dev.vars.example .dev.vars                 # 填一个本地访问密码
npm run db:local                               # 建本地数据库表
npm run dev                                     # 本地启动，:8787
MCP_TOKEN=本地密码 node scripts/mcp-smoke.mjs    # 连本地接口自检
npm test                                        # 单元测试
npm run typecheck                               # 类型检查
```

线上自检：`BASE="https://你的子域名" TOKEN="你的密码" node scripts/remote-check.mjs`

---

## 安全说明

- 访问密码以 Cloudflare 加密保管（`MCP_TOKEN`），**不在代码里、不会进代码仓库**。
- 别把密码贴进代码或公开分享；要换随时 `wrangler secret put MCP_TOKEN`。
- 你的真实域名、数据库编号写在 `wrangler.local.jsonc`，本地保存、不入库。

## 常见问题

- **服务地址打不开 / 连接被重置**：别用默认的 `*.workers.dev`（部分地区会被阻断），用你自己的域名（本项目默认就是这么做的）。
- **自己测试发邮件被退回（550 SPF）**：这是发件方校验问题；用正常邮箱（Gmail/QQ/Outlook 等）发信不受影响。
- **刚发的邮件查不到**：收信到入库有几秒延迟，稍等再查，或用 `wrangler tail` 看是否收到。
- **提示 401 没权限**：检查 `Authorization: Bearer 密码` 是否填对。

## 许可

[MIT](./LICENSE) — 可自由使用、修改、分发。
