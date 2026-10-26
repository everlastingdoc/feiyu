import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { resourceReport } from '../src/resources.js';
import { temporary } from './helpers.js';

test('resource verification remains pending with missing evidence and fails on measured violations', () => {
  const store = new Store(resolve(temporary(), 'db'));
  assert.equal(resourceReport(store).status, '待验收');
  store.db.prepare('INSERT INTO resource_samples VALUES(?,?)').run(1, JSON.stringify({ at: 1, platform: 'linux', cgroupScope: 'feiyu.slice', cgroupMiB: 300, availableMiB: 200 }));
  assert.equal(resourceReport(store).status, '待验收');
  store.db.prepare('INSERT INTO resource_samples VALUES(?,?)').run(2, JSON.stringify({ at: 2, platform: 'linux', cgroupScope: 'feiyu.slice', cgroupMiB: 751, availableMiB: 149 }));
  assert.equal(resourceReport(store).status, '未通过'); store.close();
});

test('isolated swap bursts do not accumulate into a sustained-pressure failure', () => {
  const store = new Store(resolve(temporary(), 'db')); resourceReport(store);
  const insert = store.db.prepare('INSERT INTO resource_samples VALUES(?,?)');
  const add = (index: number, pages: number) => {
    const at = 1000 + index * 30_000;
    insert.run(at, JSON.stringify({ at, platform: 'linux', cgroupScope: 'feiyu.slice', cgroupMiB: 400, availableMiB: 300, oomKills: 0, swapIn: pages, swapOut: 0 }));
  };
  [0, 8000, 8001, 8002, 16002, 16003].forEach((pages, index) => add(index, pages));
  assert.equal(resourceReport(store).status, '待验收');
  assert.equal(resourceReport(store).longestHighSwapSeconds, 30);
  store.db.exec('DELETE FROM resource_samples');
  [0, 600, 1200, 1800].forEach((pages, index) => add(index, pages));
  assert.equal(resourceReport(store).status, '未通过');
  assert.equal(resourceReport(store).longestHighSwapSeconds, 90);
  store.close();
});
