import { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage, ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import { DeliveryError } from '../types.js';
import type { InboundMessage, SendReceipt, Transport } from '../types.js';
import { splitText, log } from '../util.js';

/** Narrow injectable SDK port: production uses the pinned Tencent SDK; tests exercise wire shape. */
export interface OfficialSdk {
  on(event: 'ready' | 'resumed', handler: (data: unknown) => void): unknown;
  on(event: 'disconnected', handler: (data: unknown) => void): unknown;
  on(event: 'error', handler: (error: Error) => void): unknown;
  on(event: 'message', handler: (ctx: unknown, message: QQBotInboundMessage) => void): unknown;
  start(): Promise<void>;
  stop(): void;
  sendText(target: ReplyTarget, text: string): Promise<{ id: string }>;
}

export class OfficialTransport implements Transport {
  readonly channel = 'official' as const;
  connected = false;
  private running?: Promise<void>;
  private stopping = false;
  private readonly bot: OfficialSdk;
  constructor(appId: string, appSecret: string, sdk?: OfficialSdk) {
    if (!appId || !appSecret) throw new Error('请配置QQ官方机器人的AppID和AppSecret');
    this.bot = sdk ?? new QQBot({ appId, appSecret, intents: 1 << 25,
      // SDK logger is disabled: upstream error bodies can contain credentials/content.
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      reconnect: { maxAttempts: 20 },
    });
  }
  async start(onMessage: (message: InboundMessage) => void): Promise<void> {
    this.stopping = false;
    this.bot.on('ready', () => { this.connected = true; log('qq.connected', { transport: this.channel }); });
    this.bot.on('resumed', () => { this.connected = true; });
    this.bot.on('disconnected', () => { this.connected = false; log('qq.disconnected', { transport: this.channel }); });
    this.bot.on('error', () => { log('qq.sdk-error', { transport: this.channel }); });
    this.bot.on('message', (_ctx, message) => {
      if (message.kind !== 'c2c' || !message.messageId || !message.senderId || !message.content?.trim()) return;
      onMessage({ channel: this.channel, kind: 'private', senderId: message.senderId, messageId: message.messageId,
        text: message.content, receivedAt: Date.now(), replyId: message.messageId });
    });
    this.running = this.bot.start();
    // start() owns a long-lived gateway. Failures are surfaced to the supervisor, not swallowed.
    this.running.catch(() => {
      this.connected = false;
      if (!this.stopping) { log('qq.fatal', { transport: this.channel }); process.exitCode = 1; process.emit('SIGTERM'); }
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    this.bot.stop();
    await this.running?.catch(() => {});
  }
  async send(target: string, text: string, options: { replyId?: string } = {}): Promise<SendReceipt> {
    if (!this.connected) throw new DeliveryError('QQ网关未连接', 'retry', 'DISCONNECTED');
    const messageIds: string[] = [];
    // Passive replies have per-inbound quotas: keep a normal response to at most four chunks.
    const chunks = splitText(text, options.replyId ? Math.max(1500, Math.ceil(text.length / 4)) : 1500);
    try {
      for (const chunk of chunks) {
        const replyTarget: ReplyTarget = { scope: 'c2c', targetId: target };
        // Proactive notifications NEVER inherit msgId/eventId from previous traffic.
        if (options.replyId) replyTarget.msgId = options.replyId;
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          this.bot.sendText(replyTarget, chunk),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryError('QQ发送超时，请核查', 'unknown', 'TIMEOUT')), 45_000); }),
        ]).finally(() => clearTimeout(timer));
        if (typeof result.id !== 'string' || !result.id) throw new DeliveryError('QQ未返回消息ID，请核查', 'unknown', 'NO_RECEIPT');
        messageIds.push(result.id);
      }
      return { messageIds, acceptedAt: Date.now() };
    } catch (error) {
      if (messageIds.length) throw new DeliveryError('部分分段可能已送达，请核查后再重发', 'unknown', 'PARTIAL');
      if (error instanceof DeliveryError) throw error;
      const e = error as { httpStatus?: number; bizCode?: number };
      if (typeof e.httpStatus === 'number') {
        const code = String(e.bizCode ?? e.httpStatus);
        if (e.httpStatus === 429) throw new DeliveryError(`QQ请求限流（${code}）`, 'retry', code);
        // A 5xx response can follow a committed send; do not assume it is safe to retry.
        if (e.httpStatus < 400 || e.httpStatus === 408 || e.httpStatus >= 500) throw new DeliveryError(`QQ发送结果不明（${code}）`, 'unknown', code);
        throw new DeliveryError(`QQ平台拒绝发送（${code}）`, 'failed', code);
      }
      throw new DeliveryError('QQ发送超时或连接异常，结果不明', 'unknown', 'NETWORK');
    }
  }
}
