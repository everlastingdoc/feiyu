import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/config.js';
import { temporary } from './helpers.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

test('Node installation and reuse both allow the separate service user to traverse its runtime directory', { skip: process.platform !== 'linux' }, () => {
  const dir = temporary(); const payload = resolve(dir, 'payload'); const app = resolve(dir, 'app');
  mkdirSync(resolve(payload, 'node-v24.19.0-linux-x64/bin'), { recursive: true });
  writeFileSync(resolve(payload, 'node-v24.19.0-linux-x64/bin/node'), '#!/bin/sh\nprintf "v24.19.0\\n"\n', { mode: 0o755 });
  const archive = resolve(dir, 'node.tar.xz');
  execFileSync('tar', ['-cJf', archive, '-C', payload, 'node-v24.19.0-linux-x64']);
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const checksums = resolve(dir, 'SHASUMS256.txt');
  writeFileSync(checksums, `${hash}  node-v24.19.0-linux-x64.tar.xz\n`);
  const script = `set -euo pipefail
source ${quote(resolve(ROOT, 'scripts/common.sh'))}
APP=${quote(app)}
download() {
  case "$1" in
    *SHASUMS256.txt) cp ${quote(checksums)} "$2" ;;
    *) cp ${quote(archive)} "$2" ;;
  esac
}
install_node
`;
  execFileSync('bash', ['-c', script]);
  assert.equal(statSync(resolve(app, 'node')).mode & 0o005, 0o005, 'fresh runtime must be traversable/readable by feiyu');
  chmodSync(resolve(app, 'node'), 0o700);
  execFileSync('bash', ['-c', script]);
  assert.equal(statSync(resolve(app, 'node')).mode & 0o005, 0o005, 'reuse must repair an older private runtime directory');
});
