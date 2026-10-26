import { Store } from './store.js';
import type { Channel } from './types.js';
import { id } from './util.js';

export interface AcceptanceRun { id: string; kind: '10m' | '72h'; channel: Channel; startedAt: number; notificationId: string }
export function startAcceptance(store: Store, channel: Channel, kind: '10m' | '72h', now = Date.now()): AcceptanceRun {
  const testId = id();
  const delay = kind === '10m' ? 600_000 : 72 * 3_600_000;
  const notification = store.enqueueNotification({ channel, text: `飞鱼主动通知测试 ${kind}\n测试ID：${testId}\n这条消息由定时任务主动发送，不引用你的上一条消息。收到后请在服务器确认验收。`, idempotencyKey: `acceptance:${testId}`, dueAt: now + delay }, now);
  const run = { id: testId, kind, channel, startedAt: now, notificationId: notification.id };
  store.set(`acceptance:${testId}`, run);
  const ids = store.get<string[]>('acceptance-runs') ?? [];
  store.set('acceptance-runs', [...ids.slice(-19), testId]);
  return run;
}
export function acceptanceReport(store: Store) {
  return (store.get<string[]>('acceptance-runs') ?? []).map(testId => {
    const run = store.get<AcceptanceRun>(`acceptance:${testId}`)!;
    const n = store.notification(run.notificationId)!;
    const receipt = n.receipt ? JSON.parse(n.receipt) as { proactive?: boolean; lastInboundAt?: number; submittedAt?: number } : undefined;
    const late = receipt && (receipt.submittedAt ?? 0) > n.dueAt + 60_000;
    const earlyOrInteracted = receipt && ((receipt.submittedAt ?? 0) < n.dueAt || (receipt.lastInboundAt ?? 0) > run.startedAt || !receipt.proactive);
    const status = earlyOrInteracted || late || n.status === 'failed' ? '未通过' : n.status === 'sent' && n.confirmedAt ? '通过' : '待验收';
    return { ...run, status, notificationStatus: n.status, dueAt: n.dueAt, confirmedAt: n.confirmedAt,
      note: earlyOrInteracted ? '测试期间有用户交互或发送证据不符合主动通知要求' : late ? '到期后超过60秒才提交，准时性验收未通过' : n.error ?? (status === '通过' ? 'API提交和人工接收确认均已记录' : '需等待到期发送，并由用户确认实际收到') };
  });
}
