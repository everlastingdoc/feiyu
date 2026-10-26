import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_CONFIG, ROOT, writeJson } from '../src/config.js';
import { Store } from '../src/store.js';
import { temporary, until } from './helpers.js';

test('real official Harness + mocked Chat Completions + OneBot: memory, restart, compaction, provider switching and proactive delivery', { timeout: 120_000 }, async t => {
  const dir = temporary(); const data = resolve(dir, 'data'); const configPath = resolve(dir, 'config.json');
  const requests: { model: string; messages: { role: string; content: unknown }[]; stream?: boolean; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number }[] = [];
  const authenticated: boolean[] = [];
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request); authenticated.push(req.headers.authorization === 'Bearer secret-model-test-value');
    if (JSON.stringify(request.messages.at(-1)).includes('model-fail')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'secret-model-test-value rejected', type: 'invalid_api_key' } })); return;
    }
    const isSummary = String(JSON.stringify(request.messages)).includes('compaction engine');
    const content = isSummary ? '用户正在测试个人助理，长期偏好另存SQLite。' : `模型已回复第${requests.length}次。`;
    if (request.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: request.model, created: Math.floor(Date.now()/1000), choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model: request.model, created: Math.floor(Date.now()/1000), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: request.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
    }
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(ws, 'listening');
  const sockets: WebSocket[] = []; const outgoing: { action: string; params: { message: { data: { text: string } }[] } }[] = [];
  ws.on('connection', socket => {
    sockets.push(socket);
    socket.on('message', raw => { const event = JSON.parse(raw.toString()); outgoing.push(event); socket.send(JSON.stringify({ echo: event.echo, status: 'ok', retcode: 0, data: { message_id: outgoing.length } })); });
  });
  const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  const config = { ...structuredClone(DEFAULT_CONFIG), activeProvider: 'mock', providers: { mock: { baseUrl, model: 'first-model', apiKeyEnv: 'MOCK_API_KEY' }, other: { baseUrl, model: 'second-model', apiKeyEnv: 'MOCK_API_KEY', maxTokensField: 'max_completion_tokens' } }, qq: { ...DEFAULT_CONFIG.qq, transport: 'onebot', onebot: { url: `ws://127.0.0.1:${(ws.address() as { port: number }).port}`, tokenEnv: 'MOCK_QQ_TOKEN' } } };
  writeJson(configPath, config);
  let child: ChildProcess | undefined; let output = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child; const exited = once(current, 'exit'); current.kill('SIGTERM'); await exited;
  };
  t.after(async () => { await stop(); for (const socket of sockets) socket.terminate(); await new Promise<void>(r => ws.close(() => r())); model.closeAllConnections(); await new Promise<void>(r => model.close(() => r())); });
  const start = async () => {
    const count = sockets.length;
    child = spawn(process.execPath, [resolve(ROOT, 'bin/feiyu.mjs'), 'start'], { cwd: ROOT, windowsHide: true, env: { ...process.env, FEIYU_DATA_DIR: data, FEIYU_CONFIG: configPath, FEIYU_ENV_FILE: resolve(dir, 'absent.env'), MOCK_API_KEY: 'secret-model-test-value', MOCK_QQ_TOKEN: 'secret-qq-test-value' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', c => { output = (output + c.toString()).slice(-50_000); });
    child.stderr?.on('data', c => { output = (output + c.toString()).slice(-50_000); });
    try { await until(() => sockets.length > count, 25_000); } catch { throw new Error(`Harness未启动：${output}`); }
  };
  let messageId = 0;
  const send = async (text: string, expected: RegExp) => {
    const count = outgoing.length;
    sockets.at(-1)!.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 12345, self_id: 99999, message_id: ++messageId, message: [{ type: 'text', data: { text } }] }));
    try { await until(() => outgoing.slice(count).some(m => expected.test(m.params.message.map(p => p.data.text).join(''))), 20_000); }
    catch { throw new Error(`等待回复失败：${text}\n${output}\n${JSON.stringify(outgoing.slice(count))}`); }
  };
  let store = new Store(resolve(data, 'assistant.sqlite')); const code = store.createPairing('onebot'); store.close();
  await start(); await send(`/pair ${code}`, /绑定成功/);
  await send('/remember 最喜欢的颜色是蓝色。', /已记住/);
  await send('你好，记得我的偏好吗？' + '这是一段测试对话的背景资料。'.repeat(150), /模型已回复/);
  assert.match(JSON.stringify(requests.at(-1)?.messages), /最喜欢的颜色是蓝色/);
  assert.ok(!requests.at(-1)?.tools?.length, 'chat profile must not expose shell/files/plugin tools');
  assert.equal(requests.at(-1)?.max_tokens, 4096);
  const beforeRestart = requests.length;
  await stop(); await start(); await send('继续刚才的聊天', /模型已回复/);
  assert.ok(requests.length > beforeRestart);
  assert.match(JSON.stringify(requests.at(-1)?.messages), /你好，记得我的偏好吗/);
  await send('/compact', /压缩|较短/);
  store = new Store(resolve(data, 'assistant.sqlite')); const memoryId = store.listMemories()[0]!.id; store.close();
  await send('/new', /新对话/); await send('新会话记得我的偏好吗', /模型已回复/);
  assert.match(JSON.stringify(requests.at(-1)?.messages), /最喜欢的颜色是蓝色/);
  await send(`/memory edit ${memoryId} 最喜欢的颜色是绿色。`, /已更正/);
  await send('更正以后重新确认偏好', /模型已回复/);
  assert.match(JSON.stringify(requests.at(-1)?.messages), /最喜欢的颜色是绿色/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.messages), /最喜欢的颜色是蓝色/);
  await stop(); config.activeProvider = 'other'; writeJson(configPath, config); await start(); await send('换模型以后你好', /模型已回复/);
  assert.equal(requests.at(-1)?.model, 'second-model');
  assert.equal(requests.at(-1)?.max_completion_tokens, 4096);
  assert.match(JSON.stringify(requests.at(-1)?.messages), /最喜欢的颜色是绿色/);
  await send(`/forget ${memoryId}`, /已删除/); await send('重新开始，今天聊什么？', /模型已回复/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)?.messages), /最喜欢的颜色是绿色/);
  const summariesBefore = requests.filter(r => JSON.stringify(r.messages).includes('compaction engine')).length;
  for (let i = 0; i < 20; i++) await send(`测试自动摘要${i}：` + '自动压缩测试背景'.repeat(800), /模型已回复/);
  assert.ok(requests.filter(r => JSON.stringify(r.messages).includes('compaction engine')).length > summariesBefore, 'native pressure compaction must execute');
  await stop();
  store = new Store(resolve(data, 'assistant.sqlite')); const previous = store.conversation()!; store.setConversation({ ...previous, turns: 200 }); store.close();
  await start(); await send('轮换会话后继续', /模型已回复/);
  store = new Store(resolve(data, 'assistant.sqlite')); assert.notEqual(store.conversation()!.sessionId, previous.sessionId); assert.ok(store.conversation()!.carry); store.close();
  await send('model-fail', /本次处理未完成/);
  await send('模型错误之后恢复聊天', /模型已回复/);
  assert.ok(requests.some(r => r.stream === true));
  store = new Store(resolve(data, 'assistant.sqlite'));
  const n = store.enqueueNotification({ channel: 'onebot', text: '独立定时通知：无需用户消息', idempotencyKey: 'integration-notify', dueAt: Date.now() + 2000 }); store.close();
  await stop(); await start();
  await until(() => outgoing.some(m => m.params.message.some(p => p.data.text === '独立定时通知：无需用户消息')), 10_000);
  store = new Store(resolve(data, 'assistant.sqlite'));
  try { await until(() => store.notification(n.id)?.status === 'sent'); assert.equal(store.notification(n.id)?.status, 'sent'); } finally { store.close(); }
  assert.doesNotMatch(output, /secret-model-test-value|secret-qq-test-value/);
  assert.ok(authenticated.every(Boolean), 'all native requests must use the configured credential');
});
