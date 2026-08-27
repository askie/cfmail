# cfmail

收发 [cloudflare-email](../README.md) 邮箱的命令行工具。只要 Node 20+，`npm i -g` 会自动装上依赖。

```bash
cd cli && npm i -g $(npm pack | tail -1)   # 从本仓库安装
cfmail --help
```

> **别用 `npm i -g ./cli`**：那样装的是一个指向源码目录的符号链接，仓库一移动
> CLI 就坏了。更麻烦的是，如果仓库放在外置卷上，`launchd` / 计划任务这类受限
> 环境访问不到那个路径，定时同步会以 `EPERM` 失败。先 `npm pack` 再装是真正的复制。

在别的机器上：

```bash
git clone https://github.com/askie/cloudflare-email.git
cd cloudflare-email/cli && npm i -g $(npm pack | tail -1)
```

## 配置

```bash
cfmail setup --base https://mail.example.com --email you@example.com --key <你的Key>
```

会当场连服务验证再保存。配置在 `~/.config/email-inbox/config.json`（权限 600）。

管理员另配一份，与用户配置分开存放：

```bash
cfmail admin setup --base https://mail.example.com --key <MCP_TOKEN>
```

环境变量优先于配置文件：`EMAIL_INBOX_BASE` / `EMAIL_INBOX_EMAIL` / `EMAIL_INBOX_KEY` / `EMAIL_INBOX_CONFIG`（管理端同理 `EMAIL_ADMIN_*`），便于在脚本里切换邮箱。

## 一台机器多个邮箱

对每个邮箱各跑一次 `setup` 就行，它们各有自己的密钥、未读游标、归档目录和通知设置，互不干扰。

```bash
cfmail setup --base https://mail.example.com --email me@example.com  --key <Key1>
cfmail setup --base https://mail.example.com --email work@example.com --key <Key2>

cfmail accounts            # 看本机配了哪些，▸ 标出当前那个
cfmail use work@example.com # 切换当前邮箱
cfmail forget old@example.com  # 删掉本机上这个邮箱的配置（不动服务端）
```

不想切换、只想临时用一次别的邮箱：**任何命令都能带 `--email`**。

```bash
cfmail unread --email work@example.com
cfmail send --email work@example.com --to a@x.com --subject s --text b
```

配了多个之后，输出会标明当前是哪个邮箱：

```
$ cfmail unread
1 封未读邮件（work@example.com）：
```

没选中而本机又有好几个时，命令会直接告诉你有哪些、怎么选：

```
error: no mailbox selected, and this machine has several.
configured: me@example.com, work@example.com
Pick one with: cfmail use <address>   (or add --email <address> to this command)
```

> 选哪个邮箱的优先级：命令上的 `--email` → 环境变量 `EMAIL_INBOX_EMAIL` → 配置里记的当前邮箱。
> 只配了一个时不用管这些，怎么写都是它。

## 收信

```bash
cfmail unread                    # 最新未读，并推进游标
cfmail unread --peek             # 只看不标记
cfmail unread --all              # 忽略游标看最近的
cfmail unread --reset            # 全部标为已读
cfmail read <邮件id> [--html]     # 全文 + 附件清单
cfmail search "关键字"            # 全文搜索，支持中文
cfmail list --from x@y.com --limit 50
cfmail attachment <附件id> --out ./file.pdf
cfmail stats
```

已读状态是本机游标，服务端不记录，所以每台机器各自独立。

## 归档到本地

把邮件（正文 + 附件）按天存到本地目录，方便自己翻、备份、或者用别的工具处理：

```bash
cfmail sync --dir ~/cfmail      # 第一次指定目录，之后会记住
cfmail sync                   # 之后只同步新邮件
cfmail sync --html            # 连 HTML 正文一起存
cfmail sync --dry-run         # 只看会存什么，不落盘
```

存出来长这样：

```
~/cfmail/2026-08-27/0930-发票-Q3-a1b2c3/
    meta.json          发件人、主题、时间、附件清单
    body.txt           纯文本正文
    body.md            仅当邮件没有纯文本正文时：由 HTML 转成的 Markdown
    body.html          仅 --html 时
    attachments/
        invoice.pdf    原始文件名
```

> **HTML-only 邮件也能读**：验证码、通知、营销邮件常常只有 HTML、没有纯文本部分，
> 这类邮件的 `body.txt` 是空的。服务会把 HTML 转成 Markdown 存进 `body.md`，
> 标题、加粗、列表、链接都保留，推送到 Grix 的通知也用它——不会再出现"收到新邮件但正文一片空白"。

已经存过的会跳过，所以反复跑很便宜，适合放进定时任务。邮箱再大也会自动翻页取全，目录名带邮件 id 后缀，同一分钟的同主题邮件不会互相覆盖。

附件没取全的邮件不会被标记成已归档，下次跑会重新取。

## 定时清理旧归档

```bash
cfmail prune --older-than 90d          # 预演：只报告会删什么
cfmail prune --older-than 90d --yes    # 真正删除
```

年龄支持 `30d` / `12w` / `6m` / `1y`（`m` 按 30 天、`y` 按 365 天近似）。**不加 `--yes` 就只是预演**，删除不可逆，先看清单再动手。

两个安全设计：

- 只在 `sync` 标记过的归档目录里动手（根目录有个 `.cfmail-archive` 文件），`--dir` 指错地方会直接拒绝
- 只删日期目录（`YYYY-MM-DD` 格式），你放在同一个目录下的其它文件不会被碰
- 按邮件自身日期判断，不看文件修改时间——拷贝或恢复备份不会让归档"重新变新"

**只删本地归档，服务器上的邮件一封都不动。**

放进 cron 就能自动跑：

```bash
0 4 * * *  cfmail sync && cfmail prune --older-than 90d --yes
```

## 新邮件推送到 Grix（带本地文件链接）

`cfmail sync` 归档完可以顺手把新邮件推到 Grix，消息里带**可点击的本地文件路径**：

```bash
cfmail sync --dir ~/cfmail --notify whk_你的key    # 配一次，之后记住
cfmail sync                                       # 以后每次都会推新邮件
cfmail sync --no-notify                           # 这次不推
```

推出来长这样：

```
📬 新邮件（含附件）
发件人: 张三 <zhangsan@example.com>
收件人: you@你的域名
主题: 8 月对账单

对账单已生成，请查收。

附件 1 个:
- [对账单 8月.xlsx](file:///Users/you/cfmail/2026-08-27/0930-8月对账单-a1b2c3/attachments/对账单%208月.xlsx)  36 KB

📁 [打开邮件目录](file:///Users/you/cfmail/2026-08-27/0930-8月对账单-a1b2c3)
```

点文件名直接打开附件，点目录打开整封邮件的归档文件夹。

### 为什么由本地推，而不是服务端

服务端跑在 Cloudflare 上，**碰不到你的硬盘**，所以它只能说「来邮件了」，给不出文件在哪。只有刚把文件写下来的这台机器知道绝对路径——链接能点开，就是因为推送发生在本地。

代价是通知不再即时，取决于 sync 多久跑一次。放进 cron 每分钟跑一遍就够快了：

```bash
* * * * *  cfmail sync
```

> 如果你之前用 `cfmail admin webhook --set whk_...` 配过服务端推送，两边会**各推一条**。
> 二选一：想要文件链接就 `cfmail admin webhook --clear` 关掉服务端那条；想要即时提醒就 `cfmail sync --no-notify`。

### 不会重复打扰

- **第一次开启时不补推历史**：已归档的邮件会被标记成「已通知」，只有之后新到的才推
- 推送成功后邮件目录里留一个 `.notified` 标记，**反复跑 sync 不会重复推**
- 推送失败**不写标记**，下次 sync 自动重试
- 单次最多推 20 封，积压的下次继续，不会一口气刷屏

> 一个边角，知道就好：换一把新 key 时不会再静默——如果你手动删过 `.notified` 或从备份恢复了归档，那些邮件会推到新会话。

**同一个归档目录同时只跑一个 sync。** 撞上了就跳过这次，退出码仍是 0，所以 cron 间隔短于单次耗时也不会乱，也不需要 `flock` 之类的外部工具（Windows 上本来也没有）。上一次跑崩了留下的锁，五分钟后自动接管。

## 定时自动同步

`sync` 设计成可以反复跑（撞上没跑完的会自己跳过），扔进系统的定时机制即可。

**macOS（launchd，推荐）** —— cron 在 macOS 上要写系统目录、需要「完全磁盘访问」权限，
launchd 写的是你自己的 `~/Library/LaunchAgents`，不需要额外授权：

```bash
cat > ~/Library/LaunchAgents/com.cfmail.sync.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.cfmail.sync</string>
    <key>ProgramArguments</key>
    <array><string>$(which cfmail)</string><string>sync</string></array>
    <key>StartInterval</key><integer>60</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$HOME/.cfmail-sync.log</string>
    <key>StandardErrorPath</key><string>$HOME/.cfmail-sync.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$(dirname $(which cfmail)):/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.cfmail.sync.plist
tail -f ~/.cfmail-sync.log      # 看它在跑
```

停掉：`launchctl unload ~/Library/LaunchAgents/com.cfmail.sync.plist`

**Linux（cron）**

```bash
* * * * *  cfmail sync >> $HOME/.cfmail-sync.log 2>&1
0 4 * * *  cfmail prune --older-than 90d --yes
```

**Windows（任务计划程序）**

```powershell
schtasks /create /tn "cfmail sync" /tr "cfmail sync" /sc minute /mo 1
```

> 不需要 `flock` 之类的外部工具：同一个归档目录同时只跑一个 `sync`，
> 撞上就跳过这次并以 0 退出，间隔设多密都不会乱。

## 发信

```bash
cfmail send --to a@x.com --subject "标题" --text "正文"
cfmail reply <邮件id> --text "回复内容"
cfmail send --to a@x.com --subject "报表" --text "见附件" --attach ./report.pdf
cfmail reply <邮件id> --text "转给你" --forward-attachment <附件id>
cfmail send --to a@x.com --subject "长文" --text-file ./body.txt
```

发件人恒为这把 Key 绑定的地址，服务端强制，改不了。

`reply` 会带上 `In-Reply-To`/`References`，多轮往返不断线；手工拼 `--subject "Re: ..."` 做不到这一点。

`--forward-attachment` 转发已存附件时字节在服务端内部流转，不经过本机。

## 管理

```bash
cfmail admin create-key alice@example.com   # 开通邮箱，Key 只显示一次
cfmail admin list-keys
cfmail admin delete-key alice@example.com

cfmail admin webhook                        # 看当前通知设置
cfmail admin webhook --set whk_xxx          # 新邮件推到 Grix 聊天里
cfmail admin webhook --set https://...      # 或 POST 原始 JSON 给自己的程序
cfmail admin webhook --clear
```

## 脚本化

任何命令加 `--json`：输出 JSON，失败时也是 JSON 且退出码非 0。

```bash
cfmail unread --peek --json | jq '.emails[].subject'
cfmail send --to a@x.com --subject s --text b --json || echo "发送失败"
```
