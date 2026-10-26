import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { createBackup, restoreBackup } from '../src/maintenance.js';
import { temporary } from './helpers.js';

test('consistent backup and restore preserve pairing, memory, notification queue and native sessions without environment secrets', async () => {
  const dir = temporary(); const data = resolve(dir, 'data'); const backup = resolve(dir, 'snapshot');
  const oldData = process.env.FEIYU_DATA_DIR, oldConfig = process.env.FEIYU_CONFIG;
  process.env.FEIYU_DATA_DIR = data; process.env.FEIYU_CONFIG = resolve(dir, 'config.json');
  try {
    mkdirSync(resolve(data, 'harness/sessions/test'), { recursive: true });
    writeFileSync(resolve(data, 'harness/sessions/test/session.v4.jsonl'), 'durable session');
    writeFileSync(resolve(dir, 'config.json'), '{"activeProvider":"river"}');
    writeFileSync(resolve(dir, '.env'), 'RIVER_API_KEY=never-back-up-this-secret');
    let store = new Store(resolve(data, 'assistant.sqlite'));
    store.pair('official', 'owner', store.createPairing('official'));
    const memory = store.addMemory('备份前的记忆', 'test');
    const notification = store.enqueueNotification({ channel: 'official', text: '排队通知', idempotencyKey: 'restore-test' });
    store.close();
    await createBackup(backup);
    assert.equal(existsSync(resolve(backup, '.env')), false);
    store = new Store(resolve(data, 'assistant.sqlite')); store.forgetMemory(memory.id); store.close();
    await restoreBackup(backup);
    store = new Store(resolve(data, 'assistant.sqlite'));
    assert.equal(store.owner('official'), 'owner');
    assert.equal(store.listMemories()[0]?.content, '备份前的记忆');
    assert.equal(store.notification(notification.id)?.status, 'pending');
    assert.equal(readFileSync(resolve(data, 'harness/sessions/test/session.v4.jsonl'), 'utf8'), 'durable session');
    store.close();
    await assert.rejects(createBackup(resolve(data, 'unsafe')), /分离/);
  } finally {
    if (oldData === undefined) delete process.env.FEIYU_DATA_DIR; else process.env.FEIYU_DATA_DIR = oldData;
    if (oldConfig === undefined) delete process.env.FEIYU_CONFIG; else process.env.FEIYU_CONFIG = oldConfig;
  }
});
