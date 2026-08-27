# cfmail · 给 Agent 一个自己能收发邮件的邮箱

[English](./README.md) | 简体中文

## 这是什么

**目标很直接：让 Agent 自己收邮件、自己发邮件，中间不用人转发、不用人审批、不用人点发送。** 搭在 [Cloudflare](https://cloudflare.com) 上，**没有网页界面**——这不是给你自己翻邮件用的收件箱，是给 AI/程序当成自己的邮箱在用的。

> 发到 `任意名字@你的域名` 的邮件会被自动收下来存好；Agent 自己去搜、自己读全文、自己回信、自己转发附件——你不用把邮件转发给它，它也不用等你点确认才能发出去。

```
别人给你发邮件 ──▶ Cloudflare 收下 ──▶ 自动解析、存进数据库和文件存储
                                                  │
Agent ──问问题 / 发邮件──▶ cfmail 命令行（或直接 MCP）──▶ 这个服务的接口 ──┘
```

**起步几乎零成本**，Cloudflare 和 Resend 的免费额度就够用，两边都不用绑信用卡：

| 环节 | 免费额度 |
| --- | --- |
| 收信（Cloudflare Email Routing） | 不限量，本来就免费 |
| 跑服务（Cloudflare Workers） | 每天 10 万次请求 |
| 存邮件正文/索引（Cloudflare D1） | 5 GB，每天 500 万次读 |
| 存附件原文（Cloudflare R2） | 10 GB/月 |
| 发信（Resend，默认后端） | 每月 3000 封、每天 100 封 |

一个小项目、一个人或几个 Agent 用，这些额度基本用不完；真的跑量大了再考虑升级也不迟。

它适合这些场景：

- 给 Agent 一个真正属于它自己的邮箱，让它独立完成「收信→读懂→回复/转发」的全流程，中间没有人工环节。
- 用一个自己的域名收**验证码、通知、账单、发票**等邮件，让 AI 统一帮你查找和整理。
- 想把邮件连正文带附件**定期同步到本机磁盘**存一份，新邮件来了直接推送到聊天里，点开就是本地文件。

技术细节（数据库表、检索原理、组件划分、双发信后端设计）见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

这份文档分两块：**配置**——把服务部署到你自己的 Cloudflare 账号；**使用**——部署好之后，怎么让 Agent 用它收发邮件。

---

## 配置：部署到 Cloudflare（约 10 分钟）

> 全部在你**自己的 Cloudflare 账号**里完成，邮件只存在你自己的账号下，别人碰不到。

### 你需要准备

1. 一个 **Cloudflare 账号**（免费版即可）。
2. 一个**已经添加到这个账号里的域名**（用来收邮件，也用来访问服务）。
3. 本机装好 **Node.js 18 以上**。

### 第 0 步：拿到代码、登录、建本地配置

```bash
git clone <this-repo> && cd cfmail
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

打开 `wrangler.local.jsonc`，把 `routes[0].pattern` 改成你想用的子域名，例如 `mail.yourdomain.com`（必须是你 Cloudflare 上的域名）。这个地址将来就是 Agent 访问服务的入口。

### 第 4 步：建表 + 设访问密码 + 部署

```bash
npm run db:remote                        # 在数据库里建好表
npx wrangler secret put MCP_TOKEN        # 设一个访问密码（见下方提示）
npm run deploy                           # 部署上线
```

> **访问密码**：执行上面那条命令后，粘贴一段足够长的随机字符串作为密码，可以先用 `openssl rand -hex 32` 生成一个。这个密码 Agent 接入时要用，**不要泄露**；要换随时重新跑这条命令，换完旧密码立即失效。

### 第 5 步：把「收到的邮件」转给这个服务

让发到你域名的所有邮件都进入这个服务（一次性配置）：

```bash
# 把 <ZONE_ID> 换成你域名的 Zone ID；<API_TOKEN> 换成一个有 "Email Routing 编辑" 权限的 Cloudflare API Token
curl -X PUT "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/email/routing/rules/catch_all" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  --data '{"enabled":true,"name":"catch-all to worker","matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["cloudflare-email"]}]}'
```

不想敲命令也可以在网页里点：**Cloudflare 控制台 → 你的域名 → Email Routing → Catch-all → 动作选 "Send to a Worker" → 选 `cloudflare-email`**。

> 如果这个域名以前没开过 Email Routing，先在控制台点一下开启（它会自动帮你加好收信需要的 DNS 记录）。

**完成！** 现在发到 `任意@你的域名` 的邮件都会被收下来，服务地址是 `https://你的子域名`。验证一下：给 `test@你的域名` 发一封测试邮件，几秒后用 `npx wrangler tail cloudflare-email` 应该能看到它被处理；接下来「使用」那节里 Agent 就能查到它。

### 可选：开启发信

不配这一步，服务只能收信、不能发信。有两个后端可选，**默认用 Resend**：

**方式一，Resend（推荐）：**

1. 在 [Resend](https://resend.com) 注册，添加你的域名——直接用根域 `yourdomain.com` 就行，不用退到子域。
2. 在 Cloudflare DNS 里加它给的三条记录：

   | 类型 | 名称 | 值 | 代理 |
   | --- | --- | --- | --- |
   | MX | `send` | Resend 给的地址，优先级 10 | — |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
   | TXT | `resend._domainkey` | Resend 给的 DKIM 公钥 | **DNS Only（关橙云）** |

   > 这条 MX 挂在 `send.yourdomain.com` 上，跟根域收信的 Email Routing 不冲突；DKIM 那条一定要关橙云代理，开着会验不过。

3. 把 key 设成 secret：`npx wrangler secret put RESEND_API_KEY -c wrangler.local.jsonc`

免费额度每月 3000 封、每天 100 封，够起步用；超出后付费或换回下面这个方式。

**方式二，Cloudflare 自带发信：** 确认 `wrangler.local.jsonc` 里有 `"send_email": [{ "name": "EMAIL" }]`（模板已带），然后去 Cloudflare 后台 Email → Email Sending 给域名做一次 onboarding。只发给自己在 Email Routing → Destination addresses 里验证过的地址的话，onboarding 这步能跳过，直接免费能发。

两个都没配，发信会返回一句「没有可用的发信后端」并告诉你怎么配，收信和查询不受影响。发信细节（附件多大、发件人限制、失败怎么排查）见 [ARCHITECTURE.md](./ARCHITECTURE.md) 和 [cli/README.md](./cli/README.md)——Agent 发信出错时会直接读懂错误码并告诉你原因，不需要你先记住这些限制。

### 部署后的日常维护

```bash
npx wrangler tail cloudflare-email        # 实时看收信和报错日志
npx wrangler secret put MCP_TOKEN         # 换访问密码
npx wrangler d1 execute email_db --remote --command "SELECT id,subject,from_addr,date FROM emails ORDER BY date DESC LIMIT 10"
```

> `wrangler.local.jsonc` 只存在你本机，记得别误删；删了就照「第 0 步」重新 `cp` 一份再把你的数据库编号和域名填回去。

---

## 使用：让 Agent 收发邮件

部署好之后，有三种方式把它接给 Agent 用，**优先用「技能」**——这是最省事、最贴近「Agent 自己收发邮件」这个目标的方式。

### 优先：用「技能」（推荐）

`skills/` 目录下有两份技能，教 Agent 用 `cfmail` 这个命令行工具干活：

```
skills/
  email-inbox/   普通用户：用绑定的 Key 收发邮件
  email-admin/   管理员：开通邮箱、签发/吊销 Key、配置新邮件提醒
```

两者配套：**管理员**用 `email-admin` 为某个邮箱地址签发一把 Key，**用户**把这把 Key 配进 `email-inbox` 就能收发信。

**第 0 步，装上 `cfmail`**（需要 Node 20+）：

```bash
npm install -g cfmail
```

**第 1 步，把技能拷进 Agent 的技能目录。** 以 Claude Code 为例，技能目录是 `.claude/skills/`：

```bash
cp -r skills/email-inbox  你的项目/.claude/skills/
cp -r skills/email-admin  你的项目/.claude/skills/
```

> 也可以软链接整个 `skills/`：`ln -s /路径/cfmail/skills 你的项目/.claude/skills`。

**第 2 步（管理员），开通一个邮箱：**

```bash
cfmail admin setup --base https://你的子域名 --key <管理员MCP_TOKEN>   # 一次性
cfmail admin create-key alice@你的域名                                # 打印一把明文 Key，只显示这一次
```

其它管理命令：`list-keys`（看已开通的）、`delete-key <邮箱>`（吊销）、`webhook --set whk_xxx`（新邮件推送到聊天，可选，见 [cli/README.md](./cli/README.md)）。

**第 3 步（用户），配上这把 Key：**

```bash
cfmail setup --base https://你的子域名 --email alice@你的域名 --key <上一步的Key>
```

**配完就交给 Agent 了**，直接说话：

- 「看看有没有新邮件」「找一下验证码邮件」
- 「回复一下那封发票邮件，告诉对方已收到」
- 「把这个附件转发给会计」

它会自己选合适的命令，按需读全文、取附件、回信。发信用的是 Key 绑定的那个地址，改不了——服务端强制的。

**想把邮件顺手同步到本机磁盘、来新邮件就推一条带文件链接的消息**，是这套技能之外的可选项：

```bash
cfmail sync --dir ~/cfmail --notify whk_你的key
```

放进 launchd/cron 定时跑；目录结构、去重规则、跟 `admin webhook` 的区别，都在 [cli/README.md](./cli/README.md) 里。

> 安全提醒：`email-admin` 用的是最高权限的管理员密钥，**只配在管理员自己机器上，绝不要交给普通用户**。

### 也可以：直接用 `cfmail` 命令行

不用技能，Agent（或你自己）直接敲命令也行：

```bash
cfmail unread                                              # 收最新未读
cfmail search "发票"                                        # 全文搜索，支持中文
cfmail read <邮件id>                                        # 读全文、看附件清单
cfmail send --to a@x.com --subject "标题" --text "正文"      # 发一封
cfmail reply <邮件id> --text "回复内容"                      # 在原会话里回信
cfmail config                                              # 看这份配置连的是哪个邮箱
```

一台机器管多个邮箱、多个 Agent 并发使用、本地归档目录结构、全部参数——完整说明见 [cli/README.md](./cli/README.md)（每个命令加 `--help` 也有）。

### 也可以：不装 CLI，直接把服务接成 MCP

不想装 CLI，把服务地址直接配进支持 MCP 的 AI 客户端也可以：

```bash
claude mcp add --transport http email https://你的子域名/mcp \
  --header "Authorization: Bearer 你设置的密码"
```

其他 MCP 客户端用配置文件：

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

接好之后直接用大白话问 AI：「搜一下含'发票'的邮件」「打开第一封，把附件下载下来」——背后会用到 `search_emails` / `list_emails` / `get_email` / `get_attachment` / `send_email` 等工具，AI 自己选，你不用记这些名字。这种接法没有本地归档、多邮箱管理这些 `cfmail` 才有的能力。

---

## 常见问题

- **服务地址打不开 / 连接被重置**：别用默认的 `*.workers.dev`（部分地区会被阻断），用你自己的域名（本项目默认就是这么做的）。
- **自己测试发邮件被退回（550 SPF）**：这是发件方校验问题；用正常邮箱（Gmail/QQ/Outlook 等）发信不受影响。
- **刚发的邮件查不到**：收信到入库有几秒延迟，稍等再查，或用 `npx wrangler tail cloudflare-email` 看是否收到。
- **提示 401 没权限**：检查 `Authorization: Bearer 密码` 是否填对。

## 给贡献者：本地开发

```bash
cp .dev.vars.example .dev.vars                 # 填一个本地访问密码
npm run db:local                               # 建本地数据库表
npm run dev                                     # 本地启动，:8787
MCP_TOKEN=本地密码 node scripts/mcp-smoke.mjs    # 连本地接口自检
npm test                                        # 单元测试
npm run typecheck                               # 类型检查
```

线上自检：`BASE="https://你的子域名" TOKEN="你的密码" node scripts/remote-check.mjs`

## 许可

[MIT](./LICENSE) — 可自由使用、修改、分发。
