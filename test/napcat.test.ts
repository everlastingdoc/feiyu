import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configureNapcat } from '../src/napcat.js';
import { temporary } from './helpers.js';

test('fallback configuration has token authentication, loopback listeners and disabled content logs', () => {
  const dir = temporary(); configureNapcat(dir, '123456789', 'a'.repeat(32), 'b'.repeat(32));
  const read = (name: string) => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
  const network = read('onebot11_123456789.json').network;
  assert.equal(network.websocketServers[0].host, '127.0.0.1');
  assert.equal(network.websocketServers[0].token, 'a'.repeat(32));
  assert.equal(network.httpServers.length, 0);
  assert.equal(read('webui.json').host, '127.0.0.1');
  assert.equal(read('napcat_123456789.json').fileLog, false);
  assert.throws(() => configureNapcat(dir, '123456789', '', ''), /24/);
});
