import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id } from './util.js';

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const nonce = id();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce })); closeSync(descriptor);
      return () => {
        try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) unlinkSync(path); } catch { /* already released */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let previous: { pid?: number };
      try { previous = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('服务锁无效；请确认服务停止后人工检查service.lock'); }
      if (previous.pid && processAlive(previous.pid)) throw new Error('另一个feiyu服务已经运行');
      unlinkSync(path);
    }
  }
  throw new Error('无法取得服务锁');
}
export function assertOffline(path: string): void {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    if (processAlive(data.pid)) throw new Error('操作需要先停止feiyu服务');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
