import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { AssistantService } from '../src/service.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { FakeConversation, FakeTransport, temporary, until } from './helpers.js';
import type { InboundMessage } from '../src/types.js';

test('only the paired owner reaches the model; duplicate messages and explicit memory commands are handled durably', async () => {
  const store = new Store(resolve(temporary(), 'db')); const transport = new FakeTransport(); const conversation = new FakeConversation();
  const service = new AssistantService(store, DEFAULT_CONFIG, transport, conversation);
  const message = (text: string, messageId: string, senderId = 'owner', kind: 'private' | 'group' = 'private'): InboundMessage => ({ channel: 'official', kind, senderId, messageId, text, receivedAt: Date.now(), replyId: messageId });
  await service.start();
  try {
    await service.receive(message('hello', '1', 'attacker')); await service.receive(message('/pair whatever', '2', 'owner', 'group'));
    assert.equal(conversation.calls, 0);
    const code = store.createPairing('official'); await service.receive(message(`/pair ${code}`, '3'));
    await service.receive(message('/remember 喜欢下雨天', '4')); await until(() => transport.sent.length === 2);
    assert.equal(store.listMemories().length, 1); assert.equal(conversation.calls, 0);
    await service.receive(message('/remember 喜欢下雨天', '4')); await service.drain(); assert.equal(store.listMemories().length, 1);
    await service.receive(message('普通聊天不要自动记忆', '5')); await until(() => conversation.calls === 1); await service.drain();
    assert.equal(store.listMemories().length, 1);
    const memoryId = store.listMemories()[0]!.id;
    await service.receive(message(`/forget ${memoryId}`, '6')); await until(() => store.listMemories().length === 0);
    assert.ok(conversation.resetCount >= 3);
    await service.receive(message('steal memory', '7', 'attacker')); await service.drain(); assert.equal(conversation.calls, 1);
  } finally { await service.stop(); store.close(); }
});

test('shutdown waits for an in-flight answer before closing the transport and database', async () => {
  const store = new Store(resolve(temporary(), 'db')); store.set('owner:official', 'owner');
  const transport = new FakeTransport(); const conversation = new FakeConversation();
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  conversation.chat = async () => { conversation.calls++; await gate; return '已完成'; };
  const service = new AssistantService(store, DEFAULT_CONFIG, transport, conversation);
  await service.start();
  await service.receive({ channel: 'official', kind: 'private', senderId: 'owner', messageId: '1', text: 'hello', receivedAt: Date.now() });
  await until(() => conversation.calls === 1);
  let stopped = false; const ending = service.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  finish(); await ending;
  assert.equal(transport.sent[0]?.text, '已完成');
  assert.equal(store.db.prepare('SELECT status FROM inbox').get()?.status, 'done');
  store.close();
});
