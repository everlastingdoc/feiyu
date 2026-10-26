# 上线验收：当前全部真实环境项目均为待验收

本地测试使用模拟接口和虚拟时间；不能代替真实 QQ 收到消息、72 小时等待或 1GB Ubuntu 服务器资源测量。使用选定的实际通道逐项记录结果，失败时保留错误类型、通知 ID、时间及相应版本，不要记录 API Key 或完整请求头。

## 1. 模型、权限及记忆

1. `sudo feiyu doctor --probe-model`：实际接口接受 Chat Completions 请求并返回有效 choices。
2. 私聊一句普通问题，确认回复；配置备用服务后 `model use 名称` 并重启，确认请求使用新模型，恢复原服务也正常。
3. 其他 QQ 用户和群聊发消息应不进入模型、不能查看记忆。重复入站消息 ID 只处理一次。
4. `/remember 我的测试偏好是蓝色`，保存返回的 ID。服务重启、`/compact`、`/new`、Git 更新后，明确保存的资料仍存在。
5. `/memory edit ID 我的测试偏好是绿色`，继续问偏好，随后 `/forget ID`。新请求不再注入旧内容；可用本地集成测试确认请求正文，不应开启生产请求全文日志。
6. 暂时制造网络中断，确认 QQ 自动重连；模型端错误应得到明确失败反馈，之后恢复仍能聊天。

## 2. 十分钟后主动发送

先完成主人配对，然后在服务器执行：

```bash
sudo feiyu acceptance start 10m
sudo feiyu acceptance status
```

记下返回的 `notificationId` 与 `dueAt`。**从创建任务起，不再向机器人发任何消息**。到期时用 QQ 客户端观察是否实际收到测试文字，记录收到时间。调度每秒检查一次，本项目的准时性验收允许提交延迟最多 60 秒；客户端送达也需人工确认符合预期，接口提交时间不能代替客户端时间。

收到后从服务器确认，不通过 QQ 回复以免干扰测试证据：

```bash
sudo feiyu notifications --confirm 通知ID
sudo feiyu acceptance status
```

只有同时满足接口提交成功、无期间用户入站消息、到期后 60 秒内提交、人工确认收到，工具才显示“通过”。`sent` 而没有确认仍显示“待验收”；`unknown` 表示待核查，不应盲目重发。

发送路径使用主人持久化标识；官方 SDK `sendText` 的 target 不带 `msgId`，OneBot 使用独立 `send_private_msg`，不取旧消息 ID。自动化线缆测试检查实际 SDK 构造的 HTTP JSON，确认主动消息没有 `msg_id/event_id`；生产通知记录中 `receipt.proactive` 应为 `true`。如果需平台侧核查，只看字段是否存在，勿导出含凭据或聊天内容的完整抓包。

再创建一个新的十分钟测试，在等待中段执行：

```bash
sudo systemctl restart feiyu
```

仍不发送 QQ 消息。确认任务从持久队列恢复、到期送达、只发一次，再对该通知执行人工确认。这两次结果都需留存。

## 3. 连续七十二小时无用户入站

```bash
sudo feiyu acceptance start 72h
```

从此刻连续 72 小时不向机器人发送私聊；服务器端 `status`、`resources` 不影响这个条件。保留正常进程运行和日志，避免更新、重新配对或改通道。在 72 小时任务到期后观察 QQ 客户端，实际收到才执行：

```bash
sudo feiyu notifications --confirm 通知ID
sudo feiyu acceptance status
```

如果测试期间发过消息，重新开始计时。过了 72 小时只有 HTTP 成功响应、没有客户端收到的人工确认，仍为“待验收”。未收到、平台权限拒绝、发送超出允许时间等均不满足本次上线条件。

## 4. 一千兆字节物理内存约束

部署单元通过 cgroup v2 合并计算助理及 QQ 登录组件：

```bash
sudo systemctl show feiyu.slice -p MemoryCurrent -p MemoryPeak -p MemoryMax -p MemorySwapMax
sudo systemctl status feiyu feiyu-napcat --no-pager
sudo feiyu resources
free -m
vmstat 5 12
sudo journalctl -k --since '72 hours ago' --grep='oom\|Out of memory\|Killed process'
sudo systemctl show feiyu feiyu-napcat -p NRestarts -p Result -p OOMPolicy
```

官方路线未安装 NapCat 时，相应 unit 不存在是正常的。备用路线务必确认 `feiyu-napcat.service` 也在同一个 `feiyu.slice`，否则数据不完整。

- 应用 cgroup 总峰值目标 **≤750MiB**，slice 已设硬上限；被 OOM 杀死并不算“资源达标”。
- 整机 `MemAvailable` **≥150MiB**，无 OOM，无持续 `vmstat si/so` 换页。
- 同时覆盖长对话、自动摘要、空闲释放、QQ 重连及主动发送。Ubuntu 22.04 旧内核可能没有 `memory.peak`，此时依靠 slice 硬上限、连续采样以及完整 OOM/重启日志人工核查，不能把缺失计数当作 0。
- 程序每 30 秒采样，保留最近 7 天。`resources` 在采样跨度不足 72 小时、样本缺字段或间隙过长时保持“待验收”；出现预算/可用内存/OOM/换页问题显示“未通过”。“通过采样验收”仍需结合上述系统日志，特别是服务重启可能重建 cgroup 计数的情况。

`feiyu.slice` 的 `MemorySwapMax=0` 只限制应用组，系统其他进程仍可能换页，因此也检查整机。脚本不为满足预算而新增 swap。如果 QQ 组件在合并预算内被频繁杀死，停止该路线并报告实际约束冲突，不反复提升内存上限。

报告保留所有有换页活动的采样区间计数，但不把七天内零星页面换入累计为“持续换页”。自动告警阈值为连续至少 90 秒达到 16 页/秒（本部署的 x86_64 系统约 64KiB/秒）；它是诊断阈值，最终仍需结合 `vmstat` 判断持续内存压力。750MiB、150MiB 与无 OOM 的要求保持不变。

## 5. 选择最终路线

先验收官方机器人。它若无法在 72 小时无入站条件下主动送达，记录账号权限/平台拒绝信息，按[部署文档](deployment.md)切到同机 NapCat，再完成全部项目。

两条路线都不满足时，结论应是“当前 QQ 主动可达性与 1GB 资源条件不能同时满足”，附上具体未通过项；不以被动回复、收到 HTTP 200 或模拟端点通过替代上线条件。
