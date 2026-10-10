import { expect, it } from 'vitest';
import { memorySnapshot, parserPhase } from '../src/contacts/worker-telemetry.js';

it('reads bounded numeric memory counters without forwarding raw file contents', () => {
  const files: Record<string, string> = {
    '/proc/42/status': 'Name:\tprivate.pdf\nVmRSS:\t2048 kB\nVmHWM:\t4096 kB\n',
    '/sys/fs/cgroup/memory.current': '12345\n',
    '/sys/fs/cgroup/memory.max': 'max\n',
    '/sys/fs/cgroup/memory.events': 'oom 2\noom_kill 1\nsecret 9\n',
  };
  const result = memorySnapshot(42, path => { if (!(path in files)) throw new Error('secret'); return files[path]; });
  expect(result).toMatchObject({ parser_rss_bytes: 2097152, parser_peak_rss_bytes: 4194304,
    cgroup_memory_current_bytes: 12345, cgroup_oom: 2, cgroup_oom_kill: 1 });
  expect(JSON.stringify(result)).not.toMatch(/private|secret/);
  expect(memorySnapshot(42, () => { throw new Error('missing'); })).toEqual({});
});
it('only accepts exact known parser phase markers', () => {
  expect(parserPhase('CONTACT_PHASE conversion_started')).toBe('conversion_started');
  expect(parserPhase('CONTACT_PHASE private_document')).toBeUndefined();
  expect(parserPhase('CONTACT_PHASE conversion_started secret')).toBeUndefined();
});
