# Ubuntu 22.04 x86_64 部署

本项目面向 2 核、1GB 物理内存机器。模型通过远程 API 调用；默认官方 QQ 机器人仅需一个助理进程。备用 NapCat 包含 Linux QQ 和 Xvfb，能否在预算内持续运行须实测，不能由“无界面”推断一定够用。脚本不新增交换空间、不提高物理内存要求。

## 目录与权限

| 路径 | 内容 |
| --- | --- |
| `/opt/feiyu/node` | 固定 Node.js 24.19.0 |
| `/opt/feiyu/releases/<commit>-<time>` | 只读源码、依赖及构建结果，root 持有 |
| `/opt/feiyu/current`、`previous` | 当前和上一个代码版本 |
| `/var/lib/feiyu` | SQLite、Harness 会话、运行锁、资源采样 |
| `/etc/feiyu/config.json` | 非密钥配置，服务用户可读，CLI 可修改 |
| `/etc/feiyu/assistant.env` | API Key、QQ 凭据，`feiyu:feiyu`、0600 |
| `/etc/feiyu/napcat.env` | 备用通道的快速登录账号，安装器生成，0600 |
| `/var/backups/feiyu` | 一致性备份及对应代码提交 |
| `/var/lib/feiyu-napcat` | 仅备用通道：QQ 登录态、NapCat 配置与运行数据 |

服务账号 `feiyu` 无登录 shell。安装、依赖下载及维护由 sudo 执行；聊天服务使用非 root 用户。`/usr/local/bin/feiyu` 会以该用户调用当前版本。环境文件由 Node 原生 dotenv 解析，脚本不会把它当 shell 脚本执行。

## 初次安装

先把本地源码、`package-lock.json` 和此文档提交到你的 GitHub 仓库。服务器用个人部署账号配置该仓库的读取权限；私有仓库可使用只读 Deploy Key。访问仓库的 SSH 私钥留在部署账号，助理进程不需要 GitHub Token。

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/everlastingdoc/feiyu.git ~/feiyu
cd ~/feiyu
sudo bash scripts/install.sh HEAD
```

脚本仅部署已提交的 Git 版本，拒绝有已跟踪文件修改的工作区；未提交文件不会进入 release。安装下载固定 Node 包并校验官方 SHASUMS，按锁文件执行 `npm ci --ignore-scripts`、构建和裁剪开发依赖，安装 systemd 单元。初装不会在空凭据状态启动服务。

填写配置：

```bash
sudoedit /etc/feiyu/assistant.env
sudoedit /etc/feiyu/config.json
sudo feiyu doctor --probe-model
sudo systemctl start feiyu
sudo feiyu health --require-connected
sudo feiyu pair
```

默认填写 `RIVER_API_KEY`、`QQBOT_APPID`、`QQBOT_SECRET`。在腾讯 QQ 开放平台完成机器人创建、适用的单聊能力和测试/上线账号配置；按平台实际能力管理可接收消息的人。机器人通过 WebSocket 连出，本项目无需公网入站端口或域名。

腾讯[官方文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)明确标注主动推送已停止提供；默认官方适配器并不代表该平台允许本项目要求的长期主动消息。若实际账号没有适用权限，应直接记录该限制并测试备用路线，不用旧入站 ID 绕成被动回复。

在自己的 QQ 私聊发送配对指令，收到绑定成功后测试 `/help`、普通聊天、`/remember`。配对码只在终端显示，不写日志。随后执行[完整验收](acceptance.md)，尤其是独立主动推送。官方通道不满足主动推送时使用下述备用路线。

首次启动失败可运行：

```bash
sudo journalctl -u feiyu -n 80 --no-pager
sudo bash scripts/doctor.sh --probe-model
sudo systemctl status feiyu --no-pager
```

诊断不输出密钥、请求正文或用户聊天内容。`doctor --probe-model` 会真实调用所选接口一次，可能计费。健康检查只证明进程心跳和 QQ 网关连接，不能证明消息实际送达。

## 通过 Git 更新

在本地测试并推送标签，例如 `v0.1.1`；服务器先用部署账号更新仓库，再交给 root 部署：

```bash
cd ~/feiyu
git pull --ff-only
git fetch --tags
sudo bash scripts/update.sh v0.1.1
```

也可以指定明确的提交哈希。更新脚本不替你使用 root 的 SSH 身份拉仓库，避免私有仓库权限混乱。

更新过程会暂停助理及正在运行的 NapCat，备份 SQLite 与原生会话，再安装/构建新 release，切换软链接、恢复组件并等待连接健康检查。这样避免在 1GB 机器上让构建与 Linux QQ 同时争用内存。暂停期间通知仍在 SQLite 中，到期未发的任务启动后处理；维护窗口可能导致延迟，定时验收期间应避免无关更新。

失败时自动切回原代码及其 systemd 单元，并尝试重启原服务；保留失败 release 和更新前备份供诊断。`/etc/feiyu` 及 `/var/lib/feiyu` 不随代码替换。V1 数据库结构为版本 1，固定 Harness 使用会话格式 v4；将来涉及数据库或会话格式升级时，先明确迁移及旧版本兼容性，不能只靠软链接回退。

旧 release 不自动清理。运行稳定后可人工清理不再需要的版本、下载缓存及过期备份，保留 `current`、`previous` 指向的版本和至少一个验证过的备份。运行数据及备份可能包含私人信息，分享诊断时只分享必要状态。

## 备份与回滚

```bash
cd ~/feiyu
sudo bash scripts/backup.sh
sudo bash scripts/rollback.sh
```

备份脚本停止相关服务，通过 SQLite 备份 API 生成数据库副本，并复制原生会话及非密钥配置；完成后按原状态恢复服务。如果安装了备用通道，还会打包 QQ 登录态。`napcat-login-data.tar.gz` 包含登录凭据与 OneBot/WebUI Token，应按密钥材料保护。`assistant.env` 不进入普通备份，需要自行单独加密保管。

回滚脚本先备份，再切到 `previous`，检查健康；失败则恢复原代码。**代码回滚保留最新运行数据**，避免已经送达的通知因数据回退再次发送。

只有确实需要恢复旧数据时，先停止服务，再显式恢复指定备份：

```bash
sudo systemctl stop feiyu
sudo feiyu restore --from /var/backups/feiyu/替换为备份目录
sudo feiyu doctor
sudo systemctl start feiyu
```

恢复前数据保留在 `/var/lib/feiyu/before-restore-时间戳`，不自动删除。恢复会回退绑定、记忆和通知状态；如果备份后有通知已经发出，需先核查队列，防止重复发送。环境文件和当前配置不自动回退，备份中的 `config.json` 可人工对比。恢复 NapCat 登录态时需同时停止 `feiyu-napcat`，由管理员将对应归档还原为 `feiyu:feiyu` 所有，再检查仅监听本机的配置。

## 备用路线：NapCat Shell + OneBot v11

仅当官方账号不能满足独立主动发送时启用。准备一个作为机器人的普通 QQ 账号；主人用另一个 QQ 私聊它。账号的登录、平台限制与真实主动送达能力仍须验证。

在 `/etc/feiyu/assistant.env` 中填写两个**不同的**随机值，均至少 24 字符：

```dotenv
ONEBOT_ACCESS_TOKEN=填写足够长的随机值
NAPCAT_WEBUI_TOKEN=填写另一个足够长的随机值
```

执行：

```bash
cd ~/feiyu
sudo bash scripts/setup-napcat.sh 机器人QQ号
sudo systemctl start feiyu-napcat
```

安装器固定下载 NapCat Shell v4.18.41 并验证 GitHub release 提供的 SHA256，加载器固定到已记录的 Git 提交和 SHA256。使用腾讯端固定 Linux QQ `3.2.34-53644` 安装包，检查架构和包版本并记录下载摘要；腾讯该下载端未提供可独立核验的签名摘要，包来源校验依赖 HTTPS。安装不会执行随时变化的远程 shell 脚本。该组合已在 Ubuntu 实机启动并确认收到即时主动通知；长期可达性及 QQ 重启后的免扫码恢复仍按下述状态验收。

从本地建立 SSH 转发：

```bash
ssh -L 6099:127.0.0.1:6099 你的服务器
```

浏览器打开 `http://127.0.0.1:6099`，使用你填写的 WebUI 密码登录、扫码登录机器人账号。不要在安全组开放 6099 或 3001。生成配置已将 WebUI 和 OneBot 都绑定到 `127.0.0.1`；其他 HTTP/反向连接、群消息处理及内容日志均关闭。应用只接受主人私聊。

QQ 登录成功后切换：

```bash
sudo feiyu transport use onebot
sudo systemctl restart feiyu
sudo feiyu health --require-connected
sudo feiyu pair
sudo ss -lntp '( sport = :3001 or sport = :6099 )'
```

NapCat 服务通过 `napcat.env` 中的 `FEIYU_QQ_ACCOUNT` 向启动器显式传入 `-q`，以尝试使用保存的登录态；启动参数不能保证平台接受已有登录态。**2026-10-26 实机测试中，QQ 重启后仍返回“登录态已失效，请重新登录”，需要重新扫码。** 因此目前只确认飞鱼进程自身可以重启恢复，QQ 组件整套重启后的免扫码恢复尚未通过。安装、备份或更新若停止了 QQ 组件，请准备重新扫码，不能把它当作已验证的无人值守恢复能力。

在普通 QQ 账号私聊完成重新配对。两个通道的用户标识不同，所以配对不跨通道猜测映射；长期记忆共用，旧通道排队通知不自动迁移，需要核查并在新通道重新创建。仅一个配置中的通道会运行。

`feiyu-napcat` 与 `feiyu` 同属 `feiyu.slice`，**750MiB 合计限制包含 Linux QQ、NapCat 和 Xvfb**。该服务关闭标准输出，避免登录 URL/Token 进入 journal；通过仅本机 WebUI 处理登录问题。NapCat/QQ 的独立数据目录同样需要备份保护，日后升级不要覆盖登录与配置目录。

完整重做记忆、重启恢复、10 分钟主动通知和 72 小时长期可达性及资源验收。如果官方路线缺乏主动权限，备用路线又超过预算或不能稳定送达，应报告**QQ 主动可达性与 1GB 内存约束冲突**，保持“待验收/未通过”，不能降低条件宣布成功。

参考：[官方 Shell 安装说明](https://napneko.github.io/guide/boot/Shell)、[固定 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.41)、[固定加载器源码](https://github.com/NapNeko/napcat-linux-launcher/blob/557b5ea2de8867ae8d72f5054ab0cdd96c0aa9c7/launcher.cpp)。
