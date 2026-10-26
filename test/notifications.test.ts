import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { NotificationWorker } from '../src/notifications.js';
import { DeliveryError } from '../src/types.js';
import { startAcceptance, acceptanceReport } from '../src/acceptance.js';
import { FakeTransport, temporary } from './helpers.js';

test('delayed notifications survive restart and never inherit passive reply metadata', async () => {
  const file = resolve(temporary(), 'data.db'); let now = 100_000;
  let store = new Store(file); store.set('owner:official', 'owner'); store.set('lastInbound:official', now - 72 * 3600_000);
  const n = store.enqueueNotification({ channel: 'official', text: '起床提醒', idempotencyKey: 'wake', dueAt: now + 600_000 }, now);
  assert.equal(store.enqueueNotification({ channel: 'official', text: '起床提醒', idempotencyKey: 'wake' }, now).id, n.id);
  store.close(); store = new Store(file);
  const transport = new FakeTransport(); const worker = new NotificationWorker(store, transport, () => now);
  await worker.tick(); assert.equal(transport.sent.length, 0);
  now += 600_000; await worker.tick(); await worker.tick();
  assert.equal(transport.sent.length, 1); assert.equal(transport.sent[0]?.options, undefined);
  assert.equal(store.notification(n.id)?.status, 'sent');
  assert.equal(store.notification(n.id)?.confirmedAt, null);
  assert.equal(JSON.parse(store.notification(n.id)!.receipt!).proactive, true);
  store.close();
});

test('uncertain sends are not retried, recover as unknown, and owner replacement prevents misdelivery', async () => {
  const store = new Store(resolve(temporary(), 'data.db')); store.set('owner:official', 'owner');
  const transport = new FakeTransport(); let attempts = 0;
  transport.send = async () => { attempts++; throw new DeliveryError('timeout', 'unknown'); };
  const n = store.enqueueNotification({ channel: 'official', text: 'hello', idempotencyKey: 'once' });
  const worker = new NotificationWorker(store, transport); await worker.tick(); await worker.tick();
  assert.equal(attempts, 1); assert.equal(store.notification(n.id)?.status, 'unknown');
  const n2 = store.enqueueNotification({ channel: 'official', text: 'hello', idempotencyKey: 'interrupted' });
  store.claimNotification('official'); store.recover(); assert.equal(store.notification(n2.id)?.status, 'unknown');
  const n3 = store.enqueueNotification({ channel: 'official', text: 'hello', idempotencyKey: 'old-owner' });
  store.set('owner:official', 'someone-else'); await worker.tick();
  assert.equal(store.notification(n3.id)?.status, 'failed'); assert.equal(attempts, 1); store.close();
});

test('definite transient failures retry on persisted bounds and eventually stop', async () => {
  const store = new Store(resolve(temporary(), 'data.db')); store.set('owner:official', 'owner');
  const transport = new FakeTransport(); let attempts = 0; let now = 100_000;
  transport.send = async () => { attempts++; throw new DeliveryError('rate limited', 'retry', '429'); };
  const n = store.enqueueNotification({ channel: 'official', text: 'hello', idempotencyKey: 'bounded' }, now);
  const worker = new NotificationWorker(store, transport, () => now);
  for (const delay of [5000, 30_000, 120_000, 600_000, 1_800_000]) {
    await worker.tick(); assert.equal(store.notification(n.id)?.status, 'pending');
    assert.equal(store.notification(n.id)?.nextAttemptAt, now + delay);
    await worker.tick(); now += delay;
  }
  await worker.tick(); assert.equal(attempts, 6); assert.equal(store.notification(n.id)?.status, 'failed');
  now += 86_400_000; await worker.tick(); assert.equal(attempts, 6); store.close();
});

test('72h acceptance needs actual client confirmation and fails if owner spoke during the interval', async () => {
  const store = new Store(resolve(temporary(), 'data.db')); store.set('owner:official', 'owner');
  const start = 1_000_000; store.set('lastInbound:official', start - 1000);
  const run = startAcceptance(store, 'official', '72h', start);
  const transport = new FakeTransport(); const worker = new NotificationWorker(store, transport, () => start + 72 * 3600_000);
  await worker.tick(); assert.equal(acceptanceReport(store)[0]?.status, '待验收');
  store.confirmNotification(run.notificationId); assert.equal(acceptanceReport(store)[0]?.status, '通过');
  const run2 = startAcceptance(store, 'official', '10m', start + 73 * 3600_000);
  store.set('lastInbound:official', start + 73 * 3600_000 + 1000);
  await new NotificationWorker(store, transport, () => start + 74 * 3600_000).tick();
  store.confirmNotification(run2.notificationId); assert.equal(acceptanceReport(store).at(-1)?.status, '未通过'); store.close();
});
