import { Store } from './store.js';
import { DeliveryError } from './types.js';
import type { Transport } from './types.js';
import { log } from './util.js';

const RETRY_DELAYS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
export class NotificationWorker {
  private active?: Promise<void>;
  constructor(private readonly store: Store, private readonly transport: Transport, private readonly clock = Date.now) {}
  tick(): Promise<void> {
    if (this.active) return this.active;
    if (!this.transport.connected) return Promise.resolve();
    const operation = this.run();
    this.active = operation.finally(() => { this.active = undefined; });
    return this.active;
  }
  async idle(): Promise<void> { await this.active; }
  private async run(): Promise<void> {
    const notification = this.store.claimNotification(this.transport.channel, this.clock());
    if (!notification) return;
    if (this.store.owner(notification.channel) !== notification.recipient) {
      this.store.finishNotification(notification.id, 'failed', '主人绑定已变化，拒绝发送到旧账号');
      return;
    }
    try {
      // No reply options: this is a genuinely independent proactive send.
      const receipt = await this.transport.send(notification.recipient, notification.text);
      this.store.finishNotification(notification.id, 'sent', null, { ...receipt, proactive: true, lastInboundAt: this.store.get<number>(`lastInbound:${notification.channel}`) ?? null, submittedAt: this.clock() });
      log('notification.submitted', { id: notification.id, transport: notification.channel });
    } catch (error) {
      const known = error instanceof DeliveryError ? error : new DeliveryError('发送结果不明，请核查', 'unknown');
      const delay = RETRY_DELAYS[notification.attempts - 1];
      const status = known.outcome === 'retry' && delay !== undefined ? 'pending' : known.outcome === 'unknown' ? 'unknown' : 'failed';
      this.store.finishNotification(notification.id, status, known.message, null, this.clock() + (delay ?? 0));
      log('notification.result', { id: notification.id, status, code: known.code });
    }
  }
}
