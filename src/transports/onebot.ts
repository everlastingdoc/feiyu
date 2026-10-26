import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { DeliveryError } from '../types.js';
import type { InboundMessage, SendReceipt, Transport } from '../types.js';
import { log, splitText } from '../util.js';

interface Pending { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class OneBotTransport implements Transport {
  readonly channel = 'onebot' as const;
  connected = false;
  private socket?: WebSocket;
  private stopped = true;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private pong = true;
  private attempts = 0;
  private pending = new Map<string, Pending>();
  private onMessage?: (message: InboundMessage) => void;
  constructor(private readonly url: string, private readonly token: string, private readonly reconnectBaseMs = 1000) {
    const parsed = new URL(url);
    if (!['ws:', 'wss:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('OneBot必须使用本机WebSocket地址');
    if (!token) throw new Error('请配置ONEBOT_ACCESS_TOKEN，并在NapCat端设置相同的Token');
  }
  async start(onMessage: (message: InboundMessage) => void): Promise<void> { this.stopped = false; this.onMessage = onMessage; this.connect(); }
  private connect(): void {
    if (this.stopped) return;
    const socket = this.socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` }, handshakeTimeout: 15_000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    socket.on('open', () => {
      this.connected = true; this.attempts = 0; this.pong = true;
      log('qq.connected', { transport: this.channel });
      this.heartbeatTimer = setInterval(() => { if (!this.pong) { socket.terminate(); return; } this.pong = false; socket.ping(); }, 30_000);
    });
    socket.on('pong', () => { this.pong = true; });
    socket.on('message', raw => {
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;
      if (typeof event.echo === 'string') {
        const pending = this.pending.get(event.echo);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(event.echo);
        if (event.status === 'ok' && event.retcode === 0) pending.resolve((event.data ?? {}) as Record<string, unknown>);
        else pending.reject(new DeliveryError(`OneBot拒绝发送（${String(event.retcode)}）`, 'failed', String(event.retcode)));
        return;
      }
      if (event.post_type !== 'message' || event.message_type !== 'private' || String(event.user_id) === String(event.self_id)) return;
      // Keep only text segments. CQ codes, images and files are never interpreted as executable markup.
      const text = Array.isArray(event.message)
        ? event.message.filter(s => s && typeof s === 'object' && s.type === 'text' && typeof s.data?.text === 'string').map(s => s.data.text).join('')
        : typeof event.raw_message === 'string' ? event.raw_message.replace(/\[CQ:[^\]]*\]/g, '') : '';
      if (!text.trim() || event.user_id === undefined || event.message_id === undefined) return;
      this.onMessage?.({ channel: this.channel, kind: 'private', senderId: String(event.user_id), messageId: String(event.message_id), text, receivedAt: Date.now() });
    });
    socket.on('error', () => { /* close handles connection recovery without logging headers. */ });
    socket.on('close', () => {
      this.connected = false; clearInterval(this.heartbeatTimer);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new DeliveryError('OneBot发送期间连接断开，请核查', 'unknown', 'CLOSED')); }
      this.pending.clear();
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(60_000, this.reconnectBaseMs * 2 ** Math.min(this.attempts++, 6)));
    });
  }
  async stop(): Promise<void> {
    this.stopped = true; this.connected = false;
    clearTimeout(this.reconnectTimer); clearInterval(this.heartbeatTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new DeliveryError('网关正在停止', 'unknown', 'STOPPED')); }
    this.pending.clear(); this.socket?.terminate();
  }
  private call(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new DeliveryError('OneBot未连接', 'retry', 'DISCONNECTED');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new DeliveryError('OneBot发送超时，请核查', 'unknown', 'TIMEOUT')); }, 15_000);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(echo); reject(new DeliveryError('OneBot发送结果不明', 'unknown', 'WRITE')); }
      });
    });
  }
  async send(target: string, text: string): Promise<SendReceipt> {
    if (!/^\d{5,20}$/.test(target)) throw new DeliveryError('OneBot主人QQ号格式错误', 'failed');
    const messageIds: string[] = [];
    try {
      for (const chunk of splitText(text)) {
        const result = await this.call('send_private_msg', { user_id: target, message: [{ type: 'text', data: { text: chunk } }], auto_escape: true });
        if (typeof result.message_id !== 'string' && typeof result.message_id !== 'number') throw new DeliveryError('OneBot未返回消息ID，请核查', 'unknown', 'NO_RECEIPT');
        messageIds.push(String(result.message_id));
      }
      return { messageIds, acceptedAt: Date.now() };
    } catch (error) {
      if (messageIds.length) throw new DeliveryError('部分分段可能已送达，请核查', 'unknown', 'PARTIAL');
      throw error;
    }
  }
}
