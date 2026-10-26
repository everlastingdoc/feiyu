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
