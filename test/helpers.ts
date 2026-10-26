import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config.js';
import type { Channel, Conversation, InboundMessage, SendReceipt, Transport } from '../src/types.js';

export function temporary(): string {
  const root = resolve(ROOT, '.cache/tests'); mkdirSync(root, { recursive: true });
  return mkdtempSync(resolve(root, 'case-'));
}
export async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error('条件等待超时'); await new Promise(r => setTimeout(r, 15)); }
}
export class FakeTransport implements Transport {
  connected = true;
  sent: { target: string; text: string; options?: { replyId?: string } }[] = [];
  callback?: (message: InboundMessage) => void;
  constructor(readonly channel: Channel = 'official') {}
  async start(onMessage: (message: InboundMessage) => void) { this.callback = onMessage; }
  async stop() { this.connected = false; }
  async send(target: string, text: string, options?: { replyId?: string }): Promise<SendReceipt> {
    this.sent.push({ target, text, options }); return { messageIds: [String(this.sent.length)], acceptedAt: Date.now() };
  }
}
export class FakeConversation implements Conversation {
  resetCount = 0; calls = 0; active = false;
  async chat(text: string) { this.calls++; this.active = true; return `回复：${text}`; }
  async reset() { this.resetCount++; }
  async compact() { return '摘要完成'; }
  async release() { this.active = false; }
  status() { return { sessionId: 'test', turns: this.calls, active: this.active }; }
}
