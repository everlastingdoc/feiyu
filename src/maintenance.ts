import { cpSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isInside, paths, writeJson, DSH_VERSION } from './config.js';
import { assertOffline, acquireLock } from './lock.js';
import { Store } from './store.js';

export async function createBackup(destination: string): Promise<void> {
  const p = paths(); assertOffline(p.lock);
  if (isInside(p.data, destination) || isInside(destination, p.data)) throw new Error('备份目录须与运行数据目录分离');
  if (existsSync(destination)) throw new Error('备份目标已经存在，请使用新目录');
  const unlock = acquireLock(p.lock);
  try {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const store = new Store(p.db);
    try { await store.backup(resolve(destination, 'assistant.sqlite')); } finally { store.close(); }
    if (existsSync(resolve(p.home, 'sessions'))) cpSync(resolve(p.home, 'sessions'), resolve(destination, 'sessions'), { recursive: true });
    if (existsSync(p.config)) cpSync(p.config, resolve(destination, 'config.json'));
    writeJson(resolve(destination, 'manifest.json'), { version: 1, harness: DSH_VERSION, createdAt: new Date().toISOString(), includesSecrets: false });
  } finally { unlock(); }
}

export async function restoreBackup(source: string): Promise<void> {
  const p = paths(); assertOffline(p.lock);
  if (isInside(p.data, source) || isInside(source, p.data)) throw new Error('恢复源须与运行数据目录分离');
  const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')) as { version: number };
  if (manifest.version !== 1) throw new Error('不支持的备份格式');
  const check = new DatabaseSync(resolve(source, 'assistant.sqlite'), { readOnly: true });
  try { if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败'); } finally { check.close(); }
  const unlock = acquireLock(p.lock);
  try {
    const staged = resolve(p.data, `.restore-${Date.now()}`);
    mkdirSync(resolve(staged, 'harness'), { recursive: true, mode: 0o700 });
    cpSync(resolve(source, 'assistant.sqlite'), resolve(staged, 'assistant.sqlite'));
    if (existsSync(resolve(source, 'sessions'))) cpSync(resolve(source, 'sessions'), resolve(staged, 'harness/sessions'), { recursive: true });
    const previous = resolve(p.data, `before-restore-${Date.now()}`);
    mkdirSync(previous, { mode: 0o700 });
    const saved: string[] = []; const installed: string[] = [];
    try {
      for (const name of ['assistant.sqlite', 'assistant.sqlite-wal', 'assistant.sqlite-shm', 'harness']) {
        if (existsSync(resolve(p.data, name))) { renameSync(resolve(p.data, name), resolve(previous, name)); saved.push(name); }
      }
      for (const name of ['assistant.sqlite', 'harness']) { renameSync(resolve(staged, name), resolve(p.data, name)); installed.push(name); }
    } catch (error) {
      for (const name of installed.reverse()) renameSync(resolve(p.data, name), resolve(staged, name));
      for (const name of saved.reverse()) renameSync(resolve(previous, name), resolve(p.data, name));
      throw error;
    }
    // Current deployment config and environment remain administrator-owned. Copy config.json manually if needed.
  } finally { unlock(); }
}
