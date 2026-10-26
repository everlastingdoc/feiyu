import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { OfficialTransport } from '../src/transports/official.js';
import { OneBotTransport } from '../src/transports/onebot.js';
import { until } from './helpers.js';
import type { InboundMessage } from '../src/types.js';

test('pinned Tencent SDK submits real HTTP requests without msg_id/event_id for proactive sends', async t => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let rejectMessages = false;
  let breakConnection = false;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || '{}') as Record<string, unknown>;
    requests.push({ url: req.url!, body }); res.setHeader('Content-Type', 'application/json');
    if (req.url === '/app/getAppAccessToken') res.end(JSON.stringify({ access_token: 'mock-token', expires_in: 7200 }));
    else if (breakConnection) req.socket.destroy();
    else if (rejectMessages) { res.statusCode = 403; res.end(JSON.stringify({ code: 40034105, message: 'no proactive permission' })); }
    else res.end(JSON.stringify({ id: 'message-1', timestamp: new Date().toISOString() }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}`;
  const bot = new QQBot({ appId: 'test-app', appSecret: 'test-secret', baseUrl: url, tokenBaseUrl: url });
  const transport = new OfficialTransport('test-app', 'test-secret', bot);
  t.after(() => transport.stop()); transport.connected = true;
  await transport.send('owner-openid', '定时主动发送');
  const proactive = requests.find(r => r.url.includes('/messages'))!;
  assert.equal(proactive.body.content, '定时主动发送');
  assert.equal(Object.hasOwn(proactive.body, 'msg_id'), false);
  assert.equal(Object.hasOwn(proactive.body, 'event_id'), false);
  await transport.send('owner-openid', '正常回复', { replyId: 'incoming-id' });
  assert.equal(requests.at(-1)!.body.msg_id, 'incoming-id');
  rejectMessages = true;
  await assert.rejects(transport.send('owner-openid', '主动失败'), error => (error as { outcome: string }).outcome === 'failed');
  breakConnection = true;
  await assert.rejects(transport.send('owner-openid', '发送期间断线'), error => (error as { outcome: string }).outcome === 'unknown');
});

test('OneBot filters groups/self messages, preserves text safely, and reconnects with token authentication', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const sockets: WebSocket[] = []; const sent: Record<string, unknown>[] = [];
  server.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer local-token'); sockets.push(socket);
    socket.on('message', raw => { const event = JSON.parse(raw.toString()); sent.push(event); socket.send(JSON.stringify({ echo: event.echo, status: 'ok', retcode: 0, data: { message_id: 99 } })); });
  });
  const address = server.address() as { port: number };
  const transport = new OneBotTransport(`ws://127.0.0.1:${address.port}`, 'local-token', 20);
  t.after(async () => { await transport.stop(); for (const socket of sockets) socket.terminate(); await new Promise<void>(r => server.close(() => r())); });
  const received: InboundMessage[] = []; await transport.start(m => received.push(m)); await until(() => transport.connected);
  sockets[0]!.send('null'); sockets[0]!.send('[]');
  sockets[0]!.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 12345, message_id: 0, message: [null, { type: 'text', data: { text: 123 } }] }));
  sockets[0]!.send(JSON.stringify({ post_type: 'message', message_type: 'group', user_id: 12345, self_id: 99999, message_id: 1, message: [{ type: 'text', data: { text: 'group' } }] }));
  sockets[0]!.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 99999, self_id: 99999, message_id: 2, message: [{ type: 'text', data: { text: 'self' } }] }));
  sockets[0]!.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 12345, self_id: 99999, message_id: 3, message: [{ type: 'text', data: { text: '你好' } }, { type: 'image', data: { file: 'not-downloaded' } }] }));
  await until(() => received.length === 1); assert.equal(received[0]!.text, '你好');
  await transport.send('12345', '[CQ:at,qq=all]作为文字');
  const params = sent[0]!.params as { message: { type: string; data: { text: string } }[] };
  assert.equal(params.message[0]!.type, 'text'); assert.match(params.message[0]!.data.text, /CQ:at/);
  sockets[0]!.terminate(); await until(() => sockets.length === 2 && transport.connected);
  await transport.send('12345', '重连后'); assert.equal(sent.length, 2);
});
