# 飞鱼：个人助理 V1

基于**官方 DeepSeek Harness**的单用户 QQ 文字助理，提供明确保存的长期记忆、原生近期会话与摘要、独立于入站消息的主动通知。天气、招聘监控、MCP、群聊和多媒体暂未接入。

固定 Node.js **24.19.0**、`@deepseek-ai/dsh` **0.2.1-rc.2**、腾讯 QQ SDK **1.0.5**。默认官方机器人通道；备用为同机 NapCat Shell **v4.18.41** + OneBot v11。无需在服务器运行本地模型，模型通过可配置的 Chat Completions 接口调用。

**交付状态：已在 Ubuntu 实机部署，长期上线仍待验收。** 已验证真实模型、OneBot 小号登录、文字聊天、即时主动送达，以及等待期间重启飞鱼后的十分钟定时送达，均有用户接收确认。凭据只保存在服务器。QQ 完整重启后的快速登录态被拒绝，需重新扫码；72 小时可达性及持续资源验收仍待完成，详情见[验证记录](docs/verification.md)。不能把 SDK 有发送方法或 HTTP 成功响应当作送达证明。

腾讯[官方发送消息文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)目前明确写明主动推送已停止提供。因此默认官方适配器保留作为计划要求的实现，实际满足独立长期主动通知很可能需要备用 OneBot 路线；两条路线都未做真实账号验收。

## Windows 本地开始

安装固定版本 Node.js，确认 `node --version` 为 `v24.19.0`，然后在项目目录运行：

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
node bin/feiyu.mjs init
Copy-Item .env.example .env
```

编辑 `.env`，填写 `RIVER_API_KEY`、`QQBOT_APPID`、`QQBOT_SECRET`。配置文件为 `config.local.json`；[模板](config.example.json)包含你指定的默认 URL 和模型 ID。确认 QQ 开放平台已开启适用的单聊能力，测试账号可以私聊该机器人。

```powershell
node bin/feiyu.mjs doctor --probe-model
node bin/feiyu.mjs start
```

保持进程运行，在第二个终端生成配对码：

```powershell
node bin/feiyu.mjs pair
```

用自己的 QQ 私聊机器人，发送终端给出的 `/pair 配对码`。配对码仅能使用一次，10 分钟失效。其他用户和群聊消息不会进入模型；替换主人必须从终端运行 `pair --replace`。

`npm ci --ignore-scripts` 是项目的预期安装方式：精简 profile 不加载 Harness 的终端、子进程和 PTY 插件，不需要它们的安装钩子。请勿在原版 Harness CLI 的完整默认 profile 下运行本项目。

## 日常使用

| QQ 私聊命令 | 行为 |
| --- | --- |
| `/remember 内容`、`记住：内容`、`请记住：内容` | 成功写入 SQLite 后才确认，返回记忆 ID |
| `/memories`、`/memories 2` | 分页查看记忆及 ID |
| `/memory edit ID 新内容` | 更正记忆，重建当前模型上下文 |
| `/forget ID` | 删除记忆，重建当前模型上下文 |
| `/new` | 新建近期会话，保留长期记忆 |
| `/compact` | 调用 Harness 原生手动摘要；摘要未缩短时保留原文 |
| `/status`、`/help` | 查看状态或帮助 |

普通聊天不会自动提取长期事实。每条长期记忆最多 2,000 字符，保存来源、时间和 ID。检索使用轻量关键词与中文双字相关性，按更新顺序补充，向模型注入最多 4,000 字符；没有额外向量数据库或 Embedding 服务。

近期聊天存为 Harness 原生 JSONL 会话。默认 32K 上下文、4K 输出上限；自动压缩阈值 80%、余量 2K、保留近期约 4K、摘要上限 4K。`/compact` 是原生强制摘要入口，其策略会压缩可用的历史范围；自动压缩使用保留近期内容的策略。空闲 15 分钟释放活跃 Agent，下次消息从磁盘恢复；200 个用户轮次后用摘要衔接新会话。模型请求串行，QQ 输出会在模型流式结果结束后分段发送。

编辑、删除或新增长期记忆时，当前近期上下文重建，避免旧资料继续参与请求。旧 JSONL 历史、入站记录和已有备份仍可能包含原文字；这不是对全部历史副本的物理擦除。

## 主动通知

本地示例：

```powershell
node bin/feiyu.mjs notify --text "十分钟到了，起床啦。" --after 10m --idempotency-key wake-test-001
node bin/feiyu.mjs notifications
```

省略 `--after` 即立即排队。到期时间、目标主人、幂等键和发送状态均落盘；服务重启后继续处理。主动消息**不引用旧 `msg_id/event_id`**，也不需要等待用户再说一句话。V1 先提供一次性相对延时，后续天气或招聘程序可以直接调用这个命令；每天北京时间 09:00 的周期调度和天气查询尚未实现。

服务需要持续运行。明确未提交的临时故障最多重试 5 次，间隔为 5 秒、30 秒、2 分钟、10 分钟、30 分钟；断线期间保留队列。超时、断线时结果不明或部分分段已发送，记为 `unknown`，不自动重发。核查后可人工确认或重试：

```powershell
node bin/feiyu.mjs notifications --confirm 通知ID
node bin/feiyu.mjs notifications --retry 通知ID --ack-duplicate-risk
```

`sent` 表示接口已接受，`confirmedAt` 才是用户人工确认实际收到。等待期间重启、72 小时无入站消息以及资源验收的操作见[验收文档](docs/acceptance.md)。

## 多家模型接口

在 `config.local.json` 的 `providers` 增加命名配置，密钥只填环境变量名：

```json
{
  "river": {
    "baseUrl": "https://api.river.ai/v1",
    "model": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "apiKeyEnv": "RIVER_API_KEY",
    "thinkingFormat": "deepseek"
  },
  "backup": {
    "baseUrl": "https://your-provider.example/v1",
    "model": "your-model-id",
    "apiKeyEnv": "BACKUP_API_KEY"
  }
}
```

将这段对象放在 `providers` 内；示例域名须替换。基础 URL 不带 `/chat/completions`、密钥或查询参数。不同服务可省略 `thinkingFormat` 或设为 `openai` / `deepseek`；以实际协议兼容性为准。支持标准流式 Chat Completions，未实现 Responses 或 Anthropic Messages。

```powershell
node bin/feiyu.mjs model list
node bin/feiyu.mjs model use backup
```

切换后重启服务，长期记忆和会话保留；不会自动轮换供应商。服务器上的等价命令是 `sudo feiyu model use backup`，然后 `sudo systemctl restart feiyu`。

默认发送标准 `max_tokens` 输出上限；如果供应商要求 `max_completion_tokens`，在该 provider 中设置 `"maxTokensField": "max_completion_tokens"`，模型调用和诊断探测会一致使用该字段。

## 部署与开发

- [Ubuntu 安装、更新、备份、回滚](docs/deployment.md)
- [真实账号送达与资源验收](docs/acceptance.md)
- [架构、持久化与扩展边界](docs/architecture.md)
- [测试范围及当前验收状态](docs/verification.md)

服务器代码位于 `/opt/feiyu`，运行数据位于 `/var/lib/feiyu`，配置和密钥位于 `/etc/feiyu`。Git 更新采用固定提交的独立 release，再切换 `current` 软链接；不覆盖运行数据。systemd 使用专用非 root 用户，助理与备用 QQ 组件同属 `feiyu.slice`，合计硬限制 750MiB，禁止使用交换空间。

开发验证：

```powershell
npm.cmd run typecheck
npm.cmd test
```

GitHub Actions 配置包含 Windows 和 Ubuntu 22.04 两个平台。集成测试使用真实固定版本 Harness，并用本地 HTTP/SSE、WebSocket 模拟模型与 QQ 端点，不需要生产密钥、不向真实账号发送消息。

源码及锁文件通过 GitHub 管理。`.env`、`config.local.json`、数据库、会话、依赖和缓存均已加入 `.gitignore`；真实凭据只保存在运行环境。服务器可 `git pull --ff-only`，再按指定标签或提交执行更新脚本；执行前请阅读当前 QQ 重新登录的实机限制。

上游参考：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[腾讯 QQ SDK](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)、[NapCat Shell 官方文档](https://napneko.github.io/guide/boot/Shell)。
