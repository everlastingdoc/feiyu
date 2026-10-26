import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { temporary } from './helpers.js';
import { validateConfig, DEFAULT_CONFIG } from '../src/config.js';
import { profileEntries } from '../src/profile.js';

test('pairing is one-use, expires, and replacement needs an operator action', () => {
  const store = new Store(resolve(temporary(), 'data.db'));
  try {
    const code = store.createPairing('official', false, 1000);
    assert.equal(store.pair('official', 'attacker', 'a'.repeat(16), 2000), false);
    assert.equal(store.pair('official', 'owner', code, 602_000), false);
    const next = store.createPairing('official', false, 700_000);
    assert.equal(store.pair('official', 'owner', next, 700_001), true);
    assert.equal(store.pair('official', 'attacker', next, 700_002), false);
    assert.throws(() => store.createPairing('official'), /replace/);
    const replace = store.createPairing('official', true);
    assert.equal(store.pair('official', 'new-owner', replace), true);
  } finally { store.close(); }
});

test('memory survives restart and backup, is idempotent by inbound, and forget removes retrieval', async () => {
  const dir = temporary(); const file = resolve(dir, 'data.db');
  let store = new Store(file);
  const m = store.addMemory('求职偏好：上海物流岗位。', 'official:msg-1');
  assert.equal(store.addMemory('求职偏好：上海物流岗位。', 'official:msg-1').id, m.id);
  store.close(); store = new Store(file);
  assert.match(store.memoryContext('物流'), /上海物流/);
  assert.equal(store.editMemory(m.id, '求职偏好：北京技术岗位。', 'official:msg-2'), true);
  assert.doesNotMatch(store.memoryContext('物流'), /上海/);
  await store.backup(resolve(dir, 'backup.db'));
  assert.equal(store.forgetMemory(m.id), true);
  assert.equal(store.memoryContext('北京'), '');
  assert.ok(store.memoryContext('anything').length <= 4000);
  store.close();
  const backup = new Store(resolve(dir, 'backup.db'));
  assert.equal(backup.listMemories()[0]?.content, '求职偏好：北京技术岗位。'); backup.close();
});

test('config accepts multiple editable endpoints and rejects credential-bearing or remote plain HTTP URLs', () => {
  const c = validateConfig({ ...DEFAULT_CONFIG, activeProvider: 'other', providers: { ...DEFAULT_CONFIG.providers, other: { baseUrl: 'https://example.com/v1/', model: 'custom-model', apiKeyEnv: 'OTHER_KEY' } } });
  assert.equal(c.providers.other?.baseUrl, 'https://example.com/v1');
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, providers: { bad: { baseUrl: 'https://key@example.com/v1', model: 'm', apiKeyEnv: 'KEY' } } }));
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, providers: { bad: { baseUrl: 'http://example.com/v1', model: 'm', apiKeyEnv: 'KEY' } } }));
  const entries = JSON.stringify(profileEntries(c));
  assert.match(entries, /openai-completions/);
  assert.doesNotMatch(entries, /dsh-tool-(bash|pwsh|fs|subagent|web)|dsh-web-app|session-log-deepseek|telemetry-otel/);
  assert.match(entries, /"headroomTokens":2048/);
});
