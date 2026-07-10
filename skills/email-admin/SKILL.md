---
name: email-admin
description: Administer a cloudflare-email service with the admin key. Use when the user wants to open a mailbox for someone (issue an API key bound to an email address), list or revoke issued keys, or configure the new-email webhook. Requires the service's admin token (MCP_TOKEN). The companion email-inbox skill is what an ordinary user runs with the key issued here.
---

# email-admin

用**管理员密钥**管理一台 **cloudflare-email** 服务:开通邮箱、签发/吊销访问密钥、配置新邮件通知。

管理员密钥就是服务部署时设置的 `MCP_TOKEN`。它能解锁普通邮箱密钥看不到的管理工具。普通用户拿到这里签发的 Key 后,用配套的 **email-inbox** 技能收信。

这份技能是**自包含**的:把整个 `email-admin/` 目录拷到任意 Agent 的技能目录即可使用,运行时只需 Node 18+(用内置 `fetch`,无需 `npm install`)。

## 何时使用

当用户(管理员)要求:给某人开一个邮箱 / 签发或重置访问密钥 / 看已经开通了哪些邮箱 / 吊销某人的密钥 / 设置新邮件通知地址时。

## 两个要素

1. **服务地址 base**:例如 `https://mail.example.com`(不带 `/mcp`)。
2. **管理员密钥**:服务的 `MCP_TOKEN`。**这是最高权限凭证,绝不能交给普通用户、不要泄露。**

## 运行位置(重要)

下面所有命令都写成相对路径(`scripts/admin.mjs`),必须在**本技能目录**(这份 `SKILL.md` 所在的目录,如 `.claude/skills/email-admin/`)下执行才能找到脚本。执行前先 `cd` 到这个目录;如果不确定当前目录,用 `SKILL.md` 自己的路径推出技能目录再 `cd` 进去,或者直接把命令里的 `scripts/admin.mjs` 换成它的绝对路径。

## 第一步:设置接入点(一次性)

```bash
node scripts/admin.mjs setup --base <服务地址> --key <管理员MCP_TOKEN>
```

它会连服务校验这把钥匙**确实是管理员密钥**(能看到管理工具才算通过),通过后把配置写到 `~/.config/email-admin/config.json`(可用 `EMAIL_ADMIN_CONFIG` 改路径)。密钥只存在本机这个文件里。

## 日常操作

| 命令 | 作用 |
|---|---|
| `node scripts/admin.mjs create-key --email 某人@你的域名` | **开通邮箱**:为该地址签发一把 Key,**只显示一次**,立刻复制 |
| `node scripts/admin.mjs list-keys` | 列出已开通的邮箱(只显示地址,Key 哈希存储不可回看) |
| `node scripts/admin.mjs delete-key --email 某人@你的域名` | **吊销**该邮箱的 Key,立即失效 |
| `node scripts/admin.mjs get-webhook` | 查看新邮件通知地址 |
| `node scripts/admin.mjs set-webhook --url https://...` | 设置新邮件通知地址 |
| `node scripts/admin.mjs set-webhook --url ""` | 清除新邮件通知 |

任何读命令加 `--json` 可得到机器可读输出。

## 开通邮箱的完整流程

1. 管理员执行:`node scripts/admin.mjs create-key --email alice@你的域名`
2. 命令打印一把明文 Key(**只此一次**)。把它安全地交给 Alice。
3. Alice 在自己的 Agent 里用 **email-inbox** 技能配置这把 Key,就能收发到 `alice@你的域名` 的邮件了:
   ```bash
   node setup.mjs --base <服务地址> --email alice@你的域名 --key <你的Key>
   ```

> 一个邮箱地址同时只持有一把有效 Key:对同一地址再次 `create-key` 会签发新 Key 并使旧 Key 失效(等于重置密钥)。

## 给 Agent 的执行提示

1. 首次管理操作而本机还没有配置(`config.json` 不存在)时,先问齐 base 和管理员密钥,跑 `setup`。
2. 用户说"给某某开个邮箱""签发密钥"→ `create-key`,然后把那把 Key 原样、完整地转达给用户,并提醒**只显示一次**。
3. 绝不要把管理员密钥写进回复、日志或交给普通用户;它只用于本技能的本地配置。
4. 报错"不是管理员密钥"说明填的是普通邮箱 Key,提示改用服务的 `MCP_TOKEN`;401 说明密钥错或服务地址不对。

## 故障排查

- **不是管理员密钥**:填成了普通邮箱 Key。管理需要服务的 `MCP_TOKEN`。
- **401**:密钥错误,或 base 地址不对。
- **连不上**:确认 base 可达;不要用会被阻断的 `*.workers.dev`,用服务方自定义域名。
- **Key 丢了**:无法找回(只存哈希),对该邮箱重新 `create-key` 签发一把新的即可。
