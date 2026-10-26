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
  // Counters are system-wide pages: occasional faults of old swapped pages are not
  // sustained swapping. Require consecutive, materially active intervals instead
  // of adding isolated events across the entire seven-day history.
  const swapRateThresholdPagesPerSecond = 16;
  const sustainedSwapThresholdSeconds = 90;
  let swappingIntervals = 0, maxSwapPagesPerSecond = 0, consecutiveHighSwapSeconds = 0, longestHighSwapSeconds = 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]!, previous = samples[i - 1]!;
    const seconds = (s.at - previous.at) / 1000;
    if (seconds <= 0 || seconds > 120 || s.swapIn === undefined || s.swapOut === undefined || previous.swapIn === undefined || previous.swapOut === undefined || s.swapIn < previous.swapIn || s.swapOut < previous.swapOut) { consecutiveHighSwapSeconds = 0; continue; }
    const pages = s.swapIn - previous.swapIn + s.swapOut - previous.swapOut;
    if (pages > 0) swappingIntervals++;
    const rate = pages / seconds;
    maxSwapPagesPerSecond = Math.max(maxSwapPagesPerSecond, rate);
    consecutiveHighSwapSeconds = rate >= swapRateThresholdPagesPerSecond ? consecutiveHighSwapSeconds + seconds : 0;
    longestHighSwapSeconds = Math.max(longestHighSwapSeconds, consecutiveHighSwapSeconds);
  }
  const violation = available.some(n => n < 150) || [...peaks, ...current].some(n => n > 750) || samples.some(s => (s.oomKills ?? 0) > 0) || longestHighSwapSeconds >= sustainedSwapThresholdSeconds;
  return { status: violation ? '未通过' : !known || spanHours < 72 || maxGap > 120_000 ? '待验收' : '通过采样验收',
    sampleCount: samples.length, spanHours, minAvailableMiB: available.length ? Math.min(...available) : null,
    maxObservedCgroupMiB: current.length ? Math.max(...current) : null, kernelPeakMiB: peaks.length ? Math.max(...peaks) : null,
    maxGapSeconds: maxGap / 1000, swappingIntervals, maxSwapPagesPerSecond, longestHighSwapSeconds, swapRateThresholdPagesPerSecond, sustainedSwapThresholdSeconds,
    note: '采样结果不等于容量保证。换页告警采用连续90秒达到16页/秒（x86_64通常约64KiB/秒），需结合vmstat及OOM/重启日志核查；零星换入保留计数但不累计判失败。旧内核无memory.peak时结合slice硬限制人工核查。' };
}
