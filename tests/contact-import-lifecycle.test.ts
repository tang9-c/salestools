import { expect, it, vi } from 'vitest';
import { ImportJobs } from '../src/contacts/import-jobs.js';

it('runs one job at a time and releases only after ready persistence', async () => {
  const released: string[] = [];
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 1000,
    release: async id => { released.push(id); } });
  let finishFirst!: () => void;
  const firstWork = vi.fn(() => new Promise<string>(resolve => { finishFirst = () => resolve('first'); }));
  const secondWork = vi.fn(async () => 'second');
  const persisted: string[] = [];
  const first = jobs.start('f1', firstWork, async value => { persisted.push(value); });
  const second = jobs.start('f2', secondWork, async value => { persisted.push(value); });
  await Promise.resolve();
  expect(firstWork).toHaveBeenCalledOnce();
  expect(secondWork).not.toHaveBeenCalled();
  expect(released).toEqual([]);
  finishFirst();
  await Promise.all([first, second]);
  expect(persisted).toEqual(['first', 'second']);
  expect(released).toEqual(['f1', 'f2']);
});

it('cancels a queued job once and releases its file once', async () => {
  const released: string[] = [];
  const jobs = new ImportJobs({ concurrency: 1, timeoutMs: 1000,
    release: async id => { released.push(id); } });
  let finish!: () => void;
  const first = jobs.start('f1', () => new Promise<void>(resolve => { finish = resolve; }), async () => undefined);
  const secondWork = vi.fn(async () => undefined);
  const second = jobs.start('f2', secondWork, async () => undefined);
  await jobs.cancel('f2');
  await expect(second).rejects.toThrow('IMPORT_CANCELLED');
  finish();
  await first;
  expect(secondWork).not.toHaveBeenCalled();
  expect(released).toEqual(['f2', 'f1']);
});

it('uses configured concurrency and timeout to bound processing', async () => {
  const released: string[] = [];
  const jobs = new ImportJobs({ concurrency: 2, timeoutMs: 10,
    release: async id => { released.push(id); } });
  const started: string[] = [];
  const work = (id: string) => async (signal: AbortSignal) => {
    started.push(id);
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort',
      () => reject(new Error('aborted')), { once: true }));
  };
  const first = jobs.start('f1', work('f1'), async () => undefined);
  const second = jobs.start('f2', work('f2'), async () => undefined);
  await expect(first).rejects.toThrow('IMPORT_TIMEOUT');
  await expect(second).rejects.toThrow('IMPORT_TIMEOUT');
  expect(started).toEqual(['f1', 'f2']);
  expect(released).toEqual(['f1', 'f2']);
});
