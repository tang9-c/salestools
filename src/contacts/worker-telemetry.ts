import { readFileSync } from 'node:fs';

const phases = new Set(['preflight_started', 'preflight_completed', 'dependencies_loading',
  'dependencies_loaded', 'converter_initializing', 'converter_initialized',
  'conversion_started', 'conversion_completed', 'blocks_started', 'blocks_completed']);
export function parserPhase(line: string): string | undefined {
  const value = line.startsWith('CONTACT_PHASE ') ? line.slice(14) : '';
  return phases.has(value) ? value : undefined;
}

// Read only fixed kernel counters. Missing procfs/cgroup v2 data is omitted, never zero-filled.
// RSS covers the direct Python child; cgroup values cover the whole worker container.
export function memorySnapshot(pid: number | undefined,
  read: (path: string) => string = path => readFileSync(path, 'utf8')): Record<string, number> {
  const result: Record<string, number> = {};
  const numeric = (key: string, raw: string, scale = 1) => {
    if (!/^\d+$/.test(raw)) return;
    const value = Number(raw) * scale;
    if (Number.isSafeInteger(value)) result[key] = value;
  };
  if (pid !== undefined) try {
    const status = read(`/proc/${pid}/status`);
    for (const [field, key] of [['VmRSS', 'parser_rss_bytes'], ['VmHWM', 'parser_peak_rss_bytes']]) {
      const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(status);
      if (match) numeric(key, match[1], 1024);
    }
  } catch { /* Process already exited or procfs unavailable. */ }
  for (const name of ['current', 'peak', 'max']) try {
    numeric(`cgroup_memory_${name}_bytes`, read(`/sys/fs/cgroup/memory.${name}`).trim());
  } catch { /* cgroup v2 counter unavailable. */ }
  try {
    for (const line of read('/sys/fs/cgroup/memory.events').split('\n')) {
      const match = /^(oom|oom_kill|oom_group_kill) (\d+)$/.exec(line);
      if (match) numeric(`cgroup_${match[1]}`, match[2]);
    }
  } catch { /* Counters are cumulative, not per request. */ }
  return result;
}
