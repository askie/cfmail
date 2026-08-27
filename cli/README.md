# cfmail

收发 [cloudflare-email](../README.md) 邮箱的命令行工具。只要 Node 20+。

```bash
npm install -g cfmail
cfmail --help
```

想跑仓库里最新未发布的代码，从源码装：

```bash
git clone https://github.com/askie/cfmail.git
cd cfmail/cli && npm i -g $(npm pack | tail -1)
```

> 从源码装时别用 `npm i -g ./cli`：那样装的是一个指向源码目录的符号链接，仓库一
> 移动 CLI 就坏了。更麻烦的是，如果仓库放在外置卷上，`launchd` / 计划任务这类
> 受限环境访问不到那个路径，定时同步会以 `EPERM` 失败。先 `npm pack` 再装是真正
> 的复制。

## 配置

```bash
cfmail setup --base https://mail.example.com --email you@example.com --key <你的Key>
```

会当场连服务验证再保存。配置在 `~/.config/email-inbox/config.json`（权限 600）。

管理员另配一份，与用户配置分开存放：

```bash
cfmail admin setup --base https://mail.example.com --key <MCP_TOKEN>
```

环境变量优先于配置文件：`EMAIL_INBOX_CONFIG` 换配置文件，`EMAIL_INBOX_BASE` / `EMAIL_INBOX_KEY` 覆盖凭据（管理端同理 `EMAIL_ADMIN_*`）。

## 一台机器多个邮箱

**一份配置文件 = 一个邮箱。** 没有「当前邮箱」这种全局设置，所以也不存在被别的程序改掉的问题。

再收一个邮箱，就再开一份配置：

```bash
export EMAIL_INBOX_CONFIG=~/.config/email-inbox/work.json
cfmail setup --base https://mail.example.com --email work@example.com --key <Key2>

cfmail unread        # 这个 shell 之后都走 work 这份
cfmail config        # 不确定现在是哪个邮箱时看一眼
```

密钥、未读游标、归档目录、推送设置全在各自的文件里，互相看不见。默认那份在
`~/.config/email-inbox/config.json`，不设 `EMAIL_INBOX_CONFIG` 就用它。

输出会标明这次读的是哪个邮箱：

```
$ cfmail unread
1 封未读邮件（work@example.com）：
```

不想要某个邮箱了，删掉它那份配置文件即可（不影响服务端，也不吊销 Key）。

> 旧版本把多个邮箱塞在同一份配置里。只配过一个的会自动转成新格式，你不用做什么；
> 配过多个的，cfmail 会列出它们并告诉你怎么拆成几份文件——不替你猜该用哪个。

## 多个程序同时用

给每个程序设一个 `EMAIL_INBOX_CONFIG` 就行：

```bash
# agent A
EMAIL_INBOX_CONFIG=~/.config/email-inbox/a.json cfmail unread
# agent B
EMAIL_INBOX_CONFIG=~/.config/email-inbox/b.json cfmail unread
```

两个程序要读**同一个**邮箱、又想各带各的未读游标，也是这么做：两份配置写同样的
`--base/--email/--key`，游标各存各的。

同一份配置被并发读写也是安全的：

| 场景 | 行为 |
| --- | --- |
| 多个进程同时写同一份配置（游标、归档目录…） | 每次更新都完整保留，不会互相覆盖 |
| 一个进程读、另一个正在写 | 读到的要么是旧内容要么是新内容，不会是半个文件 |
| 同一邮箱同时 `sync` | 后来的跳过这次并以 0 退出 |
| 不同邮箱同时 `sync` | 各跑各的，互不阻塞 |
| `prune` 撞上正在写的 `sync` | 跳过这次，不会删到一半的邮件 |

配置文件权限是 600（只有你自己能读），写入时会重新收紧一次。读到别人也能读的
配置时会警告并给出 `chmod 600` 的命令——里面是明文凭据。

配置写入走「临时文件 + 原子重命名」，并用一把短锁把「读—改—写」包起来；
崩溃留下的锁十秒后自动失效，不会卡住后续的运行。

> 一个语义上的提醒：两份配置指向**同一个邮箱**时，各跑 `cfmail unread` 会各自拉到同一批
> 未读邮件——游标是「看到哪儿了」，不是任务队列。要分工请让它们用不同邮箱。

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
~/cfmail/me@example.com/2026-08-27/0930-3f8a2c1b04/
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

**先按邮箱分，再按天分**——多个邮箱可以共用同一个 `--dir`，各归各的不会混在一起，一眼就能看出哪封信属于哪个邮箱。`prune` 也只清理这份配置对应邮箱的那份。

邮件目录名是「时间 + 邮件标识的哈希」，**不含标题**。标题是发件人写的任意文本，拿它当文件名永远有边界情况（斜杠、emoji、超长、shell 元字符……）；完整标题在 `meta.json` 里，那里不需要任何转义。要找某封邮件用 `cfmail search`，不用翻目录名。

哈希取自邮件自带的 `Message-ID`，所以**同一封邮件无论收几次都落在同一个目录**——这比按存储 id 命名更稳，后者每次入库都会变。

> 早先版本把日期目录直接放在根下（那时还没按邮箱分层）。第一次跑新版会自动把它们移到邮箱名下，内容原样保留，你不用做什么。

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
- [对账单 8月.xlsx](file:///Users/you/cfmail/me@example.com/2026-08-27/0930-3f8a2c1b04/attachments/对账单%208月.xlsx)  36 KB

📁 [打开邮件目录](file:///Users/you/cfmail/me@example.com/2026-08-27/0930-3f8a2c1b04)
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
