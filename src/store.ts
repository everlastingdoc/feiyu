import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { id } from './util.js';
import type { Channel, ConversationState, InboxItem, InboundMessage, Memory, Notification, NotificationStatus } from './types.js';

const HASH = (text: string) => createHash('sha256').update(text).digest();
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 1) { this.db.close(); throw new Error('数据库版本高于当前程序；请恢复匹配版本的代码'); }
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL, senderId TEXT NOT NULL, messageId TEXT NOT NULL, text TEXT NOT NULL, receivedAt INTEGER NOT NULL, replyId TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, idempotencyKey TEXT NOT NULL UNIQUE, channel TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, dueAt INTEGER NOT NULL, nextAttemptAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT, receipt TEXT, confirmedAt INTEGER);
      CREATE INDEX IF NOT EXISTS outbox_due ON notifications(status,nextAttemptAt);
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status,receivedAt);
      PRAGMA user_version=1; COMMIT;`);
    if (process.platform !== 'win32') chmodSync(filename, 0o600);
  }
  close(): void { this.db.close(); }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  delete(key: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  owner(channel: Channel): string | undefined { return this.get<string>(`owner:${channel}`); }

  createPairing(channel: Channel, replace = false, now = Date.now()): string {
    if (this.owner(channel) && !replace) throw new Error('已绑定主人；替换绑定须显式使用 --replace');
    const code = randomBytes(8).toString('hex');
    this.set(`pair:${channel}`, { hash: HASH(code).toString('hex'), expiresAt: now + 600_000, replace });
    return code;
  }
  pair(channel: Channel, sender: string, code: string, now = Date.now()): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pair = this.get<{ hash: string; expiresAt: number; replace: boolean }>(`pair:${channel}`);
      if (!pair || now > pair.expiresAt || (this.owner(channel) && !pair.replace) || !timingSafeEqual(HASH(code), Buffer.from(pair.hash, 'hex'))) { this.db.exec('ROLLBACK'); return false; }
      this.set(`owner:${channel}`, sender);
      this.delete(`pair:${channel}`);
      this.set(`lastInbound:${channel}`, now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addMemory(content: string, source: string, now = Date.now()): Memory {
    this.checkMemory(content);
    const prior = this.db.prepare('SELECT * FROM memories WHERE source=?').get(source) as unknown as Memory | undefined;
    if (prior) return prior;
    const memory: Memory = { id: id(), content: content.trim(), source, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?)').run(memory.id, memory.content, source, now, now);
    this.set('memoryRevision', id());
    return memory;
  }
  private checkMemory(content: string): void { if (!content.trim() || content.length > 2000) throw new Error('每条记忆须为1–2000字符'); }
  listMemories(): Memory[] { return this.db.prepare('SELECT * FROM memories ORDER BY updatedAt DESC,id').all() as unknown as Memory[]; }
  editMemory(memoryId: string, content: string, source: string): boolean {
    this.checkMemory(content);
    const result = this.db.prepare('UPDATE memories SET content=?,source=?,updatedAt=? WHERE id=?').run(content.trim(), source, Date.now(), memoryId);
    if (result.changes) this.set('memoryRevision', id());
    return Boolean(result.changes);
  }
  forgetMemory(memoryId: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id=?').run(memoryId);
    if (result.changes) this.set('memoryRevision', id());
    return Boolean(result.changes);
  }
  memoryContext(query: string, limit = 4000): string {
    const lower = query.toLocaleLowerCase();
    const words: string[] = lower.match(/[a-z0-9]{2,}/g) ?? [];
    const chinese = lower.match(/[\p{Script=Han}]+/gu) ?? [];
    for (const word of chinese) for (let i = 0; i < word.length - 1; i++) words.push(word.slice(i, i + 2));
    const tokens = [...new Set(words)].slice(0, 100);
    const memories = this.listMemories().map((m, index) => ({ m, score: tokens.reduce((n, t) => n + (m.content.toLowerCase().includes(t) ? 10 : 0), 0) + 1 / (index + 1) })).sort((a,b) => b.score - a.score);
    let result = '';
    for (const { m } of memories) {
      const line = `[${m.id}] ${JSON.stringify(m.content)}\n`;
      if (result.length + line.length <= limit) result += line;
    }
    return result;
  }

  enqueueInbound(message: InboundMessage): boolean {
    if (message.kind !== 'private' || this.owner(message.channel) !== message.senderId) return false;
    const result = this.db.prepare('INSERT OR IGNORE INTO inbox(id,channel,senderId,messageId,text,receivedAt,replyId) VALUES(?,?,?,?,?,?,?)').run(`${message.channel}:${message.messageId}`, message.channel, message.senderId, message.messageId, message.text, message.receivedAt, message.replyId ?? null);
    if (result.changes) this.set(`lastInbound:${message.channel}`, message.receivedAt);
    return Boolean(result.changes);
  }
  nextInbound(channel: Channel): InboxItem | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE channel=? AND status='pending' ORDER BY receivedAt,id LIMIT 1").get(channel) as unknown as InboxItem | undefined;
    return row ? { ...row, kind: 'private', replyId: row.replyId ?? undefined } : undefined;
  }
  inboundStatus(messageId: string, status: string, error: string | null = null): void { this.db.prepare('UPDATE inbox SET status=?,error=? WHERE id=?').run(status, error, messageId); }
  recover(): void {
    this.db.prepare("UPDATE notifications SET status='unknown',error='发送期间进程退出，需核查后决定是否重发' WHERE status='sending'").run();
    this.db.prepare("UPDATE inbox SET status='pending' WHERE status='processing'").run();
    this.db.prepare("UPDATE inbox SET status='failed',error='回复提交期间进程退出，结果不明；不自动重发' WHERE status='sending'").run();
  }

  enqueueNotification(input: { channel: Channel; text: string; idempotencyKey: string; dueAt?: number }, now = Date.now()): Notification {
    if (!input.text.trim() || input.text.length > 12_000) throw new Error('通知文字须为1–12000字符');
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error('幂等键须为1–200字符');
    const recipient = this.owner(input.channel);
    if (!recipient) throw new Error('请先绑定当前QQ通道的主人');
    const dueAt = input.dueAt ?? now;
    if (!Number.isSafeInteger(dueAt) || dueAt < now - 1000 || dueAt > now + 366 * 86_400_000) throw new Error('通知时间无效');
    const existing = this.db.prepare('SELECT * FROM notifications WHERE idempotencyKey=?').get(input.idempotencyKey) as unknown as Notification | undefined;
    if (existing) {
      if (existing.text !== input.text || existing.channel !== input.channel || existing.recipient !== recipient) throw new Error('幂等键已用于另一条通知');
      return existing;
    }
    const notificationId = id();
    this.db.prepare('INSERT INTO notifications(id,idempotencyKey,channel,recipient,text,dueAt,nextAttemptAt,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(notificationId, input.idempotencyKey, input.channel, recipient, input.text, dueAt, dueAt, now);
    return this.notification(notificationId)!;
  }
  notification(notificationId: string): Notification | undefined { return this.db.prepare('SELECT * FROM notifications WHERE id=?').get(notificationId) as unknown as Notification | undefined; }
  notifications(): Notification[] { return this.db.prepare('SELECT * FROM notifications ORDER BY createdAt DESC LIMIT 100').all() as unknown as Notification[]; }
  claimNotification(channel: Channel, now = Date.now()): Notification | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT * FROM notifications WHERE channel=? AND status='pending' AND nextAttemptAt<=? ORDER BY nextAttemptAt,id LIMIT 1").get(channel, now) as unknown as Notification | undefined;
      if (row) this.db.prepare("UPDATE notifications SET status='sending',attempts=attempts+1 WHERE id=?").run(row.id);
      this.db.exec('COMMIT');
      return row ? this.notification(row.id) : undefined;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finishNotification(notificationId: string, status: NotificationStatus, error: string | null, receipt: unknown = null, retryAt = 0): void {
    this.db.prepare('UPDATE notifications SET status=?,error=?,receipt=?,nextAttemptAt=? WHERE id=?').run(status, error, receipt ? JSON.stringify(receipt) : null, retryAt, notificationId);
  }
  confirmNotification(notificationId: string, now = Date.now()): void {
    const notification = this.notification(notificationId);
    if (!notification || !['sent', 'unknown'].includes(notification.status)) throw new Error('仅已提交或结果不明的通知可以确认实际收到');
    this.db.prepare('UPDATE notifications SET confirmedAt=? WHERE id=?').run(now, notificationId);
  }
  retryNotification(notificationId: string, now = Date.now()): void {
    const notification = this.notification(notificationId);
    if (!notification || !['failed', 'unknown'].includes(notification.status)) throw new Error('仅失败或结果不明的通知可手动重试；重试前请确认未收到');
    this.db.prepare("UPDATE notifications SET status='pending',nextAttemptAt=?,attempts=0,error=NULL WHERE id=?").run(now, notificationId);
  }
  conversation(): ConversationState | undefined { return this.get<ConversationState>('conversation'); }
  setConversation(state: ConversationState): void { this.set('conversation', state); }
  async backup(destination: string): Promise<void> { await backup(this.db, destination); }
}
