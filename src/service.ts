import { Store } from './store.js';
import type { AppConfig, Conversation, InboundMessage, InboxItem, Transport } from './types.js';
import { NotificationWorker } from './notifications.js';
import { log, safeError } from './util.js';
import { recordResources } from './resources.js';

const HELP = `个人助理 V1\n/remember 内容：明确保存长期记忆\n记住：内容（等价写法）\n/memories：查看长期记忆\n/memory edit ID 内容：更正记忆\n/forget ID：删除记忆\n/new：开始新对话，保留长期记忆\n/compact：压缩近期对话\n/status：查看连接、会话及通知状态\n/help：显示帮助\n定时通知由服务器命令 feiyu notify 创建。`;

export class AssistantService {
  private processing = false;
  private draining?: Promise<void>;
  private idleRelease?: Promise<void>;
  private pairing?: Promise<void>;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private readonly notifications: NotificationWorker;
  private lastActivity = Date.now();
  private lastResourceSample = 0;
  private pairingAttempts = new Map<string, { count: number; expires: number }>();
  constructor(private readonly store: Store, private readonly config: AppConfig, private readonly transport: Transport, private readonly conversation: Conversation) {
    this.notifications = new NotificationWorker(store, transport);
  }
  async start(): Promise<void> {
    this.store.recover();
    await this.transport.start(message => { void this.receive(message).catch(() => log('inbound.rejected')); });
    this.timer = setInterval(() => { void this.tick().catch(() => log('service.tick-failed')); }, 1000);
    await this.tick();
  }
  async receive(message: InboundMessage): Promise<void> {
    if (this.stopping || message.kind !== 'private' || message.channel !== this.transport.channel || message.text.length > 8000) return;
    const pair = /^\/pair\s+([a-f0-9]{16})\s*$/i.exec(message.text.trim());
    if (pair) {
      if (this.pairing) return;
      const now = Date.now();
      if (this.pairingAttempts.size > 1000) this.pairingAttempts.clear();
      const attempt = this.pairingAttempts.get(message.senderId);
      const active = attempt && attempt.expires > now ? attempt : { count: 0, expires: now + 600_000 };
      this.pairingAttempts.set(message.senderId, active);
      if (++active.count > 5) return;
      this.pairing = (async () => {
        await this.draining; await this.idleRelease; await this.notifications.idle();
        if (this.stopping) return;
        if (this.store.pair(message.channel, message.senderId, pair[1]!.toLowerCase())) {
          await this.conversation.reset();
          await this.transport.send(message.senderId, '主人绑定成功。发送 /help 查看命令。', { replyId: message.replyId });
        }
      })();
      try { await this.pairing; } finally { this.pairing = undefined; }
      return;
    }
    if (this.store.owner(message.channel) !== message.senderId) return;
    this.store.enqueueInbound(message);
    this.lastActivity = Date.now();
    void this.drain().catch(() => log('inbox.drain-failed'));
  }
  async tick(): Promise<void> {
    if (this.stopping) return;
    this.store.set('heartbeat', { pid: process.pid, at: Date.now(), connected: this.transport.connected, transport: this.transport.channel, memory: process.memoryUsage(), conversation: this.conversation.status() });
    if (Date.now() - this.lastResourceSample >= 30_000) { recordResources(this.store); this.lastResourceSample = Date.now(); }
    await this.notifications.tick();
    void this.drain().catch(() => log('inbox.drain-failed'));
    if (!this.stopping && !this.processing && !this.pairing && !this.idleRelease && Date.now() - this.lastActivity > this.config.idleMinutes * 60_000) {
      this.idleRelease = this.conversation.release();
      try { await this.idleRelease; } finally { this.idleRelease = undefined; }
    }
  }
  private async command(item: InboxItem): Promise<string | undefined> {
    const text = item.text.trim();
    if (text === '/help') return HELP;
    if (text === '/status') {
      const s = this.conversation.status();
      const unknown = this.store.notifications().filter(n => n.status === 'unknown').length;
      return `通道：${this.transport.channel}\n连接：${this.transport.connected ? '在线' : '离线'}\n模型：${this.config.activeProvider}\n会话：${s.sessionId}\n轮次：${s.turns}\n长期记忆：${this.store.listMemories().length}条\n待核查通知：${unknown}条\n主动通知真实账号验收：请查看服务器 feiyu acceptance status`;
    }
    if (text === '/new') { await this.conversation.reset(); return '已开始新对话；长期记忆保留。'; }
    if (text === '/compact') return this.conversation.compact();
    const memories = /^\/memories(?:\s+(\d+))?$/.exec(text);
    if (memories) {
      const all = this.store.listMemories();
      const page = Number(memories[1] ?? 1);
      const selected = all.slice((page - 1) * 2, page * 2);
      return all.length ? `长期记忆 ${page}/${Math.ceil(all.length / 2)} 页；/memories 页码\n\n${selected.map(m => `${m.id}\n${m.content}`).join('\n\n') || '该页为空。'}` : '还没有长期记忆。';
    }
    const remember = /^(?:\/remember\s+|(?:请)?记住[：:])([\s\S]+)$/.exec(text);
    if (remember) {
      // Reset first. If the process crashes after the write, no stale session is reused.
      await this.conversation.reset();
      const m = this.store.addMemory(remember[1]!, item.id);
      return `已记住，ID：${m.id}\n${m.content}`;
    }
    const edit = /^\/memory\s+edit\s+([a-f0-9]{16})\s+([\s\S]+)$/.exec(text);
    if (edit) { await this.conversation.reset(); return this.store.editMemory(edit[1]!, edit[2]!, item.id) ? '记忆已更正，当前对话上下文已更新。' : '没有找到该记忆ID。'; }
    const forget = /^\/forget\s+([a-f0-9]{16})$/.exec(text);
    if (forget) { await this.conversation.reset(); return this.store.forgetMemory(forget[1]!) ? '长期记忆已删除，当前对话上下文已重建。历史日志及旧备份仍按保留规则保存。' : '没有找到该记忆ID。'; }
    if (text.startsWith('/')) return '无法识别命令，请发送 /help。';
    return undefined;
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.stopping || this.pairing || this.idleRelease || !this.transport.connected) return Promise.resolve();
    this.draining = this.processInbox().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async processInbox(): Promise<void> {
    this.processing = true;
    try {
      let item: InboxItem | undefined;
      while (!this.stopping && this.transport.connected && (item = this.store.nextInbound(this.transport.channel))) {
        if (this.store.owner(item.channel) !== item.senderId) { this.store.inboundStatus(item.id, 'failed', '主人绑定已变化'); continue; }
        this.store.inboundStatus(item.id, 'processing');
        let sending = false;
        try {
          // Persist the computed response before attempting the QQ write. A crash must not rerun a memory command.
          const cacheKey = `response:${item.id}`;
          let reply = this.store.get<string>(cacheKey);
          if (reply === undefined) {
            reply = await this.command(item) ?? await this.conversation.chat(item.text, item.id);
            this.store.set(cacheKey, reply);
          }
          this.store.inboundStatus(item.id, 'sending');
          sending = true;
          await this.transport.send(item.senderId, reply, { replyId: item.replyId });
          this.store.inboundStatus(item.id, 'done');
          this.store.delete(cacheKey);
        } catch (error) {
          this.store.inboundStatus(item.id, 'failed', safeError(error));
          log('inbound.failed', { id: item.id });
          // Error feedback is best-effort and never retries an uncertain original send.
          if (!sending) {
            await this.transport.send(item.senderId, '本次处理未完成。请稍后重试；服务器日志只记录错误类型，详细状态可用 feiyu status 查看。', { replyId: item.replyId }).catch(() => {});
          }
        }
        this.lastActivity = Date.now();
      }
    } finally { this.processing = false; }
  }
  async stop(): Promise<void> {
    this.stopping = true; clearInterval(this.timer);
    // Let a running model turn finish/cancel before the host disposes its plugin tree.
    await Promise.all([this.draining, this.pairing, this.idleRelease, this.notifications.idle()]);
    await this.conversation.release();
    await this.transport.stop();
    this.store.set('heartbeat', { pid: process.pid, at: Date.now(), stopped: true });
  }
}
