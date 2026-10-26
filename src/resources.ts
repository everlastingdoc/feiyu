import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from './store.js';

export interface ResourceSample {
  at: number;
  platform: string;
  availableMiB?: number;
  cgroupMiB?: number;
  cgroupPeakMiB?: number;
  cgroupScope?: string;
  oomKills?: number;
  swapIn?: number;
  swapOut?: number;
}
function readNumber(path: string): number | undefined {
  try { const n = Number(readFileSync(path, 'utf8').trim()); return Number.isFinite(n) ? n : undefined; } catch { return undefined; }
}
export function readResources(): ResourceSample {
  const sample: ResourceSample = { at: Date.now(), platform: process.platform };
  if (process.platform !== 'linux') return sample;
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info);
    if (match) sample.availableMiB = Number(match[1]) / 1024;
    const group = /^0::(.+)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    if (group) {
      let path = resolve('/sys/fs/cgroup', `.${group}`);
      if (path.endsWith('/feiyu.service') && dirname(path).endsWith('/feiyu.slice')) path = dirname(path);
      sample.cgroupScope = path.endsWith('/feiyu.slice') ? 'feiyu.slice' : 'other';
      const current = readNumber(resolve(path, 'memory.current'));
      const peak = readNumber(resolve(path, 'memory.peak'));
      if (current !== undefined) sample.cgroupMiB = current / 1024 ** 2;
      if (peak !== undefined) sample.cgroupPeakMiB = peak / 1024 ** 2;
      if (existsSync(resolve(path, 'memory.events'))) {
        const events = readFileSync(resolve(path, 'memory.events'), 'utf8');
        sample.oomKills = Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0);
      }
    }
    const vm = readFileSync('/proc/vmstat', 'utf8');
    sample.swapIn = Number(/^pswpin (\d+)$/m.exec(vm)?.[1] ?? 0);
    sample.swapOut = Number(/^pswpout (\d+)$/m.exec(vm)?.[1] ?? 0);
  } catch { /* A missing counter stays unavailable, never becomes a zero/pass. */ }
  return sample;
}
export function recordResources(store: Store): void {
  const sample = readResources();
  store.db.exec('CREATE TABLE IF NOT EXISTS resource_samples(at INTEGER PRIMARY KEY, sample TEXT NOT NULL)');
  store.db.prepare('INSERT OR REPLACE INTO resource_samples VALUES(?,?)').run(sample.at, JSON.stringify(sample));
  store.db.prepare('DELETE FROM resource_samples WHERE at<?').run(sample.at - 7 * 86_400_000);
}
export function resourceReport(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS resource_samples(at INTEGER PRIMARY KEY, sample TEXT NOT NULL)');
  const samples = store.db.prepare('SELECT sample FROM resource_samples ORDER BY at').all().map(r => JSON.parse(String(r.sample)) as ResourceSample);
  const available = samples.flatMap(s => s.availableMiB === undefined ? [] : [s.availableMiB]);
  const peaks = samples.flatMap(s => s.cgroupPeakMiB === undefined ? [] : [s.cgroupPeakMiB]);
  const current = samples.flatMap(s => s.cgroupMiB === undefined ? [] : [s.cgroupMiB]);
  const spanHours = samples.length > 1 ? (samples.at(-1)!.at - samples[0]!.at) / 3_600_000 : 0;
  const maxGap = samples.reduce((max, s, i) => Math.max(max, i ? s.at - samples[i-1]!.at : 0), 0);
  const known = samples.length > 1 && samples.every(s => s.platform === 'linux' && s.cgroupScope === 'feiyu.slice' && s.availableMiB !== undefined && s.cgroupMiB !== undefined && s.oomKills !== undefined && s.swapIn !== undefined && s.swapOut !== undefined);
  const swappingIntervals = samples.filter((s, i) => i && ((s.swapIn ?? 0) > (samples[i-1]!.swapIn ?? 0) || (s.swapOut ?? 0) > (samples[i-1]!.swapOut ?? 0))).length;
  const violation = available.some(n => n < 150) || [...peaks, ...current].some(n => n > 750) || samples.some(s => (s.oomKills ?? 0) > 0) || swappingIntervals > 2;
  return { status: violation ? '未通过' : !known || spanHours < 72 || maxGap > 120_000 ? '待验收' : '通过采样验收',
    sampleCount: samples.length, spanHours, minAvailableMiB: available.length ? Math.min(...available) : null,
    maxObservedCgroupMiB: current.length ? Math.max(...current) : null, kernelPeakMiB: peaks.length ? Math.max(...peaks) : null,
    maxGapSeconds: maxGap / 1000, swappingIntervals,
    note: '采样结果不等于容量保证。Ubuntu旧内核没有memory.peak时，需结合750MiB的slice硬限制及完整OOM/重启日志核查。' };
}
