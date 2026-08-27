# cfmail

收发 [cloudflare-email](../README.md) 邮箱的命令行工具。零依赖，只要 Node 18+。

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
