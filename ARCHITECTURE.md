# 架构说明

## 一句话

一个 Cloudflare Worker：左手用 Email Routing 收邮件、解析后落库；右手用 HTTP MCP 协议把邮件开放给 AI 查询。无前端、无人工界面。

## 组件与数据流

```
                         ┌──────────────────────── Cloudflare Worker (cloudflare-email) ───────────────────────┐
   发件方                │                                                                                      │
  (任意邮箱) ──SMTP──▶  Email Routing(你的域名, catch-all)                                                       │
                        │        │                                                                             │
                        │        ▼  email()                                                                    │
                        │   parseRaw(postal-mime)                                                              │
                        │        │                                                                             │
                        │        ├─▶ R2 (email-store): 原始 .eml / HTML 正文 / 附件                            │
                        │        ├─▶ D1 (email_db):   元数据 + 纯文本正文 + FTS5 索引                          │
                        │        └─▶ webhook 推送(可选, ctx.waitUntil)                                          │
                        │                                                                                      │
   AI 客户端 ──HTTP───▶  fetch() /mcp  ── Bearer 校验 ──▶ McpAgent(Streamable HTTP, Durable Object)             │
   (Claude 等)          │                                   工具: search/list/get_email/get_attachment/stats  │
                        │                                        send_email / get_webhook/set_webhook          │
                        │                                             │                                        │
                        │                       Resend API (默认) / send_email binding (回退) ──▶ 收件方         │
                        └──────────────────────────────────────────────────────────────────────────────────────┘
```

两条路径共用同一套 D1 + R2 存储，互不耦合：收信只写，查询只读（webhook 配置与发信除外）。

## 发信路径 `send_email`

两个后端，按配置自动择一，同一套上层逻辑：

| 优先级 | 后端 | 启用条件 |
|---|---|---|
| 1（默认） | Resend HTTP API | 配了 `RESEND_API_KEY` secret |
| 2（回退） | Cloudflare Email Sending 的 `send_email` binding | 没配 Resend key，但有 `EMAIL` binding |

选择逻辑只有一处（`sendEmail` 入口的 key 判空），没有 provider 注册表或工厂；收件人推导、鉴权、校验都在 `buildEnvelope` 里做完，两个后端只负责把同一个 envelope 发出去。结果里带 `provider` 字段，调用方知道实际走的是哪条。

**为什么 Resend 和 Email Routing 不打架**：Resend 要求的 MX 记录挂在 `send` 子域上（收退信用），根域 MX 仍归 Email Routing。因此可以直接验证根域，`From` 用根域地址，对方回信又被 Email Routing 收回来，收发闭环在同一个地址上。

- **发件人不可伪造**：`resolveSender` 里普通 Key 的 `from` 恒等于 Key 绑定的地址，请求里传的 `from` 会被忽略；只有管理员身份（无绑定地址）需要显式指定 `from`。
- **回信复用收信数据**：`in_reply_to` 传一个已存邮件 id，经 `getEmail` 按调用方邮箱鉴权后取出原件，推导收件人、`Re:` 主题以及 `In-Reply-To`/`References` 头。鉴权走的是查询路径同一把锁，因此回不了别人的信。入站 Message-ID 是攻击者可控文本，只有形如 `<...>` 且不含空白的才会被复制进出信头。
- **失败不抛异常**：D1 查询异常、网络异常、以及两家的错误码（Resend 的 `validation_error`、Cloudflare 的 `E_SENDER_NOT_VERIFIED` 等）都连同处置建议作为结果返回，方便 AI 直接读懂并转述给用户。
- **两个后端都可缺省**：都没配时只有发信返回提示，收信与查询不受影响。
- **迁移自愈**：`refs` 是首批部署之后才加的列。缺列会让每次 INSERT 失败、静默停掉收信，所以 `storeEmail` 前先跑一次幂等的 `ALTER TABLE ... ADD COLUMN`（每 isolate 一次，`duplicate column` 视为已完成，其他错误清缓存下次重试），不依赖运维记得手动迁移。
- **附件两种来源**：调用方直接传 base64（AI 现生成的文件），或传 `forward_attachment_ids` 转发已存邮件里的附件——后者经 `getAttachment` 按调用方邮箱鉴权，转不了别人邮箱里的文件，且不用把字节在 AI 上下文里搬一遍。校验（base64 合法性、数量、总大小）按选定后端的上限在真正发之前做完：Cloudflare 5 MiB / Resend 40 MB，都是 32 个上限。
- **线程链完整**：入站邮件的 `References` 头存进 `emails.refs`，回信时按 RFC 5322 §3.6.4 拼成「父邮件的引用链 + 父邮件的 Message-ID」，多轮回复不断线。链条超过 20 个时保留线程根（它是线程身份）加最近的 19 个祖先，和主流客户端一致。老数据 `refs` 为空时自动退化成只带父 Message-ID，不影响可用性。

## 收信路径 `email()`

1. Email Routing 的 catch-all 规则把发往 `*@你的域名` 的邮件投递给本 Worker，触发 `email()`。
2. 读取原始字节 → `parseRaw()`（postal-mime）解析出发件人/收件人/主题/日期/正文/附件。
3. `storeEmail()`：
   - 原始 `.eml`、HTML 正文、每个附件分别写入 R2；
   - 元数据 + 纯文本正文写入 D1 `emails`，同时写入 FTS 索引 `emails_fts`，附件元数据写入 `attachments`（一次 `D1.batch` 事务）。
4. `ctx.waitUntil(pushNewEmail())`：异步投递 webhook，**不阻塞收信**，失败只记日志。

## 查询路径 `fetch()`

- `/health`：健康检查。
- `/mcp`、`/sse`：先校验 `Authorization: Bearer <MCP_TOKEN>`，再交给 `McpAgent`（官方 `agents` SDK）处理 MCP 协议（Streamable HTTP）。
- 每个 MCP 会话由一个 Durable Object（`EmailMCP`）承载，这是 McpAgent 的标准实现方式。

## 存储设计

**为什么 D1 + R2 分开**：可查询的小字段放 D1（SQLite，支持索引和全文检索），大块二进制（原文、附件）放 R2（对象存储，便宜、无行大小限制）。D1 里只存 R2 的 key。

D1 表（见 `schema.sql`）：

| 表 | 作用 |
|---|---|
| `emails` | 每封邮件一行：发件人/收件人/主题/日期/纯文本正文 + R2 的 raw_key/html_key |
| `attachments` | 每个附件一行：文件名/类型/大小 + r2_key |
| `emails_fts` | FTS5 全文索引（trigram 分词），列：email_id(UNINDEXED)/subject/text_body |
| `config` | 键值配置，目前存 `webhook_url` |

R2 key 布局：

```
raw/{email_id}.eml
html/{email_id}.html
att/{email_id}/{attachment_id}-{文件名}
```

## 全文检索（中文）

FTS5 默认分词器不切中文，故采用 **trigram** 分词器，对中文按 3 字滑窗建索引。检索策略（`searchEmails`）：

- 查询词 **≥ 3 字符**：走 FTS5 `MATCH`，带 `snippet()` 高亮片段，按相关度排序；
- 查询词 **< 3 字符**（如两个汉字）：trigram 无法成词，自动回退到 `LIKE` 子串匹配，保证仍能命中。

## 鉴权

公网端点，必须挡一层。采用**固定 Bearer Token**（`MCP_TOKEN`，Cloudflare Secret），在 `fetch()` 进入 MCP 前校验。简单稳定，适合 AI 程序化调用；后续如需多方接入可升级为 OAuth。

## 新邮件推送

MCP 协议本身支持服务端→客户端的订阅推送，但只在客户端保持长连接时有效，不适合"离线也要收到"的场景。因此采用**独立 webhook**：收信后把摘要 POST 到配置的地址（地址通过 `set_webhook` 工具配置，存在 D1 `config`）。可靠、与 AI 是否在线无关。

## 关键选型与取舍

- **McpAgent（agents SDK）**：Cloudflare 官方的远程 MCP 实现，原生支持 Streamable HTTP，按文档接入，不自造协议。代价是引入一个 Durable Object 承载会话。
- **postal-mime**：纯 JS、可在 Workers 运行的邮件解析库，处理 MIME/编码字头/附件。
- **自定义域名**：默认的 `*.workers.dev` 在部分地区（含国内）会被 TLS 重置不可达，故绑定到你自己的 Cloudflare 托管域（如 `mail.yourdomain.com`），端点稳定可达。

## 线上资源清单

| 资源 | 名称/标识 |
|---|---|
| Worker | `cloudflare-email` |
| 自定义域名 | 你的子域名（如 `mail.yourdomain.com`） |
| Durable Object | `EmailMCP`（binding `MCP_OBJECT`） |
| D1 | `email_db`（binding `DB`） |
| R2 | `email-store`（binding `BUCKET`） |
| Secret | `MCP_TOKEN` |
| Email Routing | 你的域名，catch-all → worker `cloudflare-email` |
| 发信（默认） | Resend；secret `RESEND_API_KEY`，域名在 Resend 验证（MX 在 `send` 子域） |
| 发信（回退） | Cloudflare Email Sending，`send_email` binding `EMAIL`；发任意外部地址需给域名做 sending onboarding |

## 目录结构

```
src/
  index.ts    入口：email() 收信 + fetch() 路由与鉴权，导出 EmailMCP
  email.ts    收信编排：读流→解析→落库→推送
  parse.ts    纯解析：原始字节 → ParsedEmail（postal-mime）
  store.ts    D1/R2 读写：存邮件 + list/search/get/stats + 幂等列迁移
  config.ts   D1 键值配置（webhook 地址）
  push.ts     webhook 投递
  send.ts     发信：Resend/CF 双后端、组装 envelope、回信线程头、错误码转提示
  mcp.ts      McpAgent + 8 个 MCP 工具
  types.ts    Env 与数据类型
schema.sql    D1 建表
wrangler.jsonc 部署配置与绑定
test/         解析单测
scripts/      MCP 联调脚本
```
