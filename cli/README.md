# cfmail

收发 [cloudflare-email](../README.md) 邮箱的命令行工具。零依赖，只要 Node 20+。

```bash
npm i -g ./cli          # 从本仓库安装
cfmail --help
```

在别的机器上：

```bash
git clone https://github.com/askie/cloudflare-email.git
npm i -g ./cloudflare-email/cli
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
cfmail sync --dir ~/mail      # 第一次指定目录，之后会记住
cfmail sync                   # 之后只同步新邮件
cfmail sync --html            # 连 HTML 正文一起存
cfmail sync --dry-run         # 只看会存什么，不落盘
```

存出来长这样：

```
~/mail/2026-08-27/0930-发票-Q3-a1b2c3/
    meta.json          发件人、主题、时间、附件清单
    body.txt           纯文本正文
    body.html          仅 --html 时
    attachments/
        invoice.pdf    原始文件名
```

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
cfmail admin webhook [--set <url> | --clear]
```

## 脚本化

任何命令加 `--json`：输出 JSON，失败时也是 JSON 且退出码非 0。

```bash
cfmail unread --peek --json | jq '.emails[].subject'
cfmail send --to a@x.com --subject s --text b --json || echo "发送失败"
```
