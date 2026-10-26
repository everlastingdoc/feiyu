import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvironment, loadConfig, paths, DEFAULT_CONFIG, writeJson, checkNode, secretNames, DSH_VERSION } from './config.js';
import { Store } from './store.js';
import { generateProfile } from './profile.js';
import { acquireLock, processAlive } from './lock.js';
import { parseDelay, id, safeError } from './util.js';
import { startAcceptance, acceptanceReport } from './acceptance.js';
import { resourceReport } from './resources.js';
import { createBackup, restoreBackup } from './maintenance.js';
import { configureNapcat } from './napcat.js';

const HELP = `feiyu init                         创建本地配置（不覆盖）
feiyu start                        启动官方Harness及QQ网关
feiyu pair [--replace]             生成10分钟有效的一次性主人配对码
feiyu notify --text 内容 [--after 10m] [--idempotency-key KEY]
feiyu notifications [--confirm ID | --retry ID --ack-duplicate-risk]
feiyu acceptance start 10m|72h     建立真实账号定时主动通知验收
feiyu acceptance status            查看API提交与人工送达确认
feiyu model list|use NAME          查看或切换模型配置（切换后重启）
feiyu transport use official|onebot 切换QQ通道（重启后生效，须重新配对）
feiyu napcat-config --account QQ --output 目录  生成仅监听本机的备用通道配置
feiyu status                      查看服务、会话、待处理任务
feiyu health [--require-connected] 部署健康检查（失败时非零退出）
feiyu doctor [--probe-model]       检查配置，可选实际调用模型
feiyu resources                   查看服务器资源采样
feiyu backup --output 目录         停止服务后备份
feiyu restore --from 目录          停止服务后恢复数据，保留恢复前数据
提示：真实API Key与QQ凭据只放环境文件；服务更新不覆盖运行数据。`;

function print(value: unknown): void { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

export async function main(args: string[]): Promise<void> {
  checkNode(); loadEnvironment();
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    text: { type: 'string' }, after: { type: 'string' }, 'idempotency-key': { type: 'string' },
    replace: { type: 'boolean' }, confirm: { type: 'string' }, retry: { type: 'string' }, 'ack-duplicate-risk': { type: 'boolean' },
    output: { type: 'string' }, from: { type: 'string' }, account: { type: 'string' }, 'probe-model': { type: 'boolean' }, 'require-connected': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { print(HELP); return; }
  const p = paths();
  if (command === 'init') {
    mkdirSync(p.data, { recursive: true, mode: 0o700 });
    if (!existsSync(p.config)) writeJson(p.config, DEFAULT_CONFIG);
    print(`配置已就绪：${p.config}\n请填写环境文件，运行 feiyu doctor，再启动服务。`); return;
  }
  if (command === 'backup') { if (!values.output) throw new Error('需要 --output 新备份目录'); await createBackup(resolve(values.output)); print('备份完成；备份包含个人数据，请妥善保管。'); return; }
  if (command === 'restore') { if (!values.from) throw new Error('需要 --from 备份目录'); await restoreBackup(resolve(values.from)); print('数据已恢复，恢复前数据保存在数据目录的before-restore子目录。启动前运行doctor。'); return; }
  const config = loadConfig();
  if (command === 'transport' && positionals[1] === 'use') {
    const transport = positionals[2];
    if (transport !== 'official' && transport !== 'onebot') throw new Error('通道须为 official 或 onebot');
    writeJson(p.config, { ...config, qq: { ...config.qq, transport } });
    print(`已选择 ${transport}，请重启服务并在此通道配对；长期记忆保留，旧通道通知不会迁移。`);
    return;
  }
  if (command === 'napcat-config') {
    if (!values.account || !values.output) throw new Error('需要 --account QQ号 --output NapCat配置目录');
    configureNapcat(resolve(values.output), values.account, process.env[config.qq.onebot.tokenEnv] ?? '', process.env.NAPCAT_WEBUI_TOKEN ?? '');
    print('已生成本机OneBot与WebUI配置；未输出任何Token。'); return;
  }
  if (command === 'start') {
    const selected = config.providers[config.activeProvider]!;
    if (!process.env[selected.apiKeyEnv]) throw new Error(`缺少模型密钥环境变量 ${selected.apiKeyEnv}`);
    const unlock = acquireLock(p.lock);
    process.env.DSH_HOME = p.home;
    process.env.TZ = config.timezone;
    // Redact known secrets even in upstream launcher diagnostics.
    const secrets = secretNames(config).map(name => process.env[name]).filter((v): v is string => Boolean(v));
    for (const stream of [process.stderr, process.stdout]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        let out = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[REDACTED]');
        return Reflect.apply(original, stream, [out, ...rest]);
      }) as typeof stream.write;
    }
    try {
      generateProfile(config);
      const { runProfile } = await import('@deepseek-ai/dsh/profile-boot');
      const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot');
      await runProfile({ profile: 'feiyu', environment: loadLayeredEnv('feiyu'), args: [], patchFiles: [] });
      process.once('exit', unlock);
    } catch (error) { unlock(); throw error; }
    return;
  }
  if (command === 'model') {
    if (positionals[1] === 'use') {
      const name = positionals[2]; if (!name || !config.providers[name]) throw new Error('请指定已配置的模型服务名');
      writeJson(p.config, { ...config, activeProvider: name }); print(`已选择 ${name}，重启服务后生效；记忆保留。`);
    } else print({ active: config.activeProvider, providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, { ...provider, keyConfigured: Boolean(process.env[provider.apiKeyEnv]) }])) });
    return;
  }
  const store = new Store(p.db);
  try {
    if (command === 'pair') { const code = store.createPairing(config.qq.transport, Boolean(values.replace)); print(`在你要绑定的QQ私聊中发送：/pair ${code}\n10分钟有效、仅可使用一次。不要将配对码发给他人。`); return; }
    if (command === 'notify') {
      if (!values.text) throw new Error('需要 --text 通知内容');
      const notification = store.enqueueNotification({ channel: config.qq.transport, text: values.text, idempotencyKey: values['idempotency-key'] ?? `manual:${id()}`, dueAt: Date.now() + (values.after ? parseDelay(values.after) : 0) });
      print({ id: notification.id, dueAt: new Date(notification.dueAt).toISOString(), status: notification.status, note: '服务须保持运行；API提交不等于客户端实际送达' }); return;
    }
    if (command === 'notifications') {
      if (values.confirm) { store.confirmNotification(values.confirm); print('已记录人工确认实际收到。'); }
      else if (values.retry) { if (!values['ack-duplicate-risk']) throw new Error('请先核查未收到，再使用 --ack-duplicate-risk 手动重试'); store.retryNotification(values.retry); print('已重新排队。'); }
      else print(store.notifications());
      return;
    }
    if (command === 'acceptance') {
      if (positionals[1] === 'start') { const kind = positionals[2]; if (kind !== '10m' && kind !== '72h') throw new Error('验收类型须为10m或72h'); print(startAcceptance(store, config.qq.transport, kind)); }
      else print(acceptanceReport(store));
      return;
    }
    if (command === 'resources') { print(resourceReport(store)); return; }
    if (command === 'health') {
      const beat = store.get<{ pid: number; at: number; connected?: boolean; stopped?: boolean; transport?: string }>('heartbeat');
      const alive = Boolean(beat && !beat.stopped && processAlive(beat.pid) && Date.now() - beat.at < 10_000);
      const healthy = alive && (!values['require-connected'] || Boolean(beat?.connected && beat.transport === config.qq.transport));
      print({ healthy, alive, connected: Boolean(beat?.connected), transport: beat?.transport ?? null });
      if (!healthy) process.exitCode = 1;
      return;
    }
    if (command === 'status') {
      const conversation = store.conversation();
      print({ heartbeat: store.get('heartbeat') ?? null, ownerBound: Boolean(store.owner(config.qq.transport)), conversation: conversation ? { sessionId: conversation.sessionId, turns: conversation.turns } : null,
        inbox: store.db.prepare('SELECT status,count(*) AS count FROM inbox GROUP BY status').all(),
        notifications: store.db.prepare('SELECT status,count(*) AS count FROM notifications GROUP BY status').all(), acceptance: acceptanceReport(store) }); return;
    }
    if (command === 'doctor') {
      const provider = config.providers[config.activeProvider]!;
      const modelKey = Boolean(process.env[provider.apiKeyEnv]);
      const qqKeys = config.qq.transport === 'official' ? Boolean(process.env[config.qq.official.appIdEnv] && process.env[config.qq.official.appSecretEnv]) : Boolean(process.env[config.qq.onebot.tokenEnv]);
      const report: Record<string, unknown> = { node: process.version, harness: DSH_VERSION, configPath: p.config, dataPath: p.data, transport: config.qq.transport, modelKeyConfigured: modelKey, qqKeysConfigured: qqKeys, ownerBound: Boolean(store.owner(config.qq.transport)),
        databaseIntegrity: store.db.prepare('PRAGMA integrity_check').get()?.integrity_check, liveAcceptance: acceptanceReport(store), resources: resourceReport(store) };
      if (values['probe-model']) {
        if (!modelKey) throw new Error(`缺少 ${provider.apiKeyEnv}`);
        const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[provider.apiKeyEnv]}` }, body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], [provider.maxTokensField ?? 'max_tokens']: 128, stream: false }), signal: AbortSignal.timeout(30_000) });
        const body = await response.json().catch(() => ({})) as { choices?: unknown[] };
        report.modelProbe = { httpStatus: response.status, validChoices: Array.isArray(body.choices) && body.choices.length > 0 };
        if (!response.ok || !body.choices?.length) process.exitCode = 1;
      }
      print(report);
      if (!modelKey || !qqKeys) process.exitCode = 1;
      return;
    }
    throw new Error(`未知命令 ${command}；运行 feiyu --help`);
  } finally { store.close(); }
}
