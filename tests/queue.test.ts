import { describe, expect, it } from 'vitest';
import { AssessmentQueue } from '../src/orchestration/fifo-queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  assertion();
}

describe('AssessmentQueue', () => {
  it('runs UUIDs in FIFO order with configured concurrency one', async () => {
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const queue = new AssessmentQueue(async assessmentId => {
      started.push(assessmentId);
      await (assessmentId === '00000000-0000-4000-8000-000000000001' ? first.promise : second.promise);
    }, 1);

    expect(queue.enqueue('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(queue.enqueue('00000000-0000-4000-8000-000000000002')).toBe(true);
    queue.start();

    await eventually(() => expect(started).toEqual(['00000000-0000-4000-8000-000000000001']));
    first.resolve();
    await eventually(() => expect(started).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ]));
    second.resolve();
    await queue.whenIdle();
  });

  it('deduplicates queued/running UUIDs and rejects new work after stopAccepting', async () => {
    const work = deferred();
    const queue = new AssessmentQueue(() => work.promise, 1);
    expect(queue.enqueue('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(queue.enqueue('00000000-0000-4000-8000-000000000001')).toBe(false);
    queue.start();
    queue.stopAccepting();
    expect(() => queue.enqueue('00000000-0000-4000-8000-000000000002')).toThrow(/not accepting/i);
    work.resolve();
    await queue.whenIdle();
  });

  it('reports a fixed observable worker error without exposing the rejection text', async () => {
    const observed: unknown[] = [];
    const queue = new AssessmentQueue(
      async () => { throw new Error('raw upstream body with token'); },
      1,
      { onWorkerError: event => observed.push(event) },
    );
    queue.enqueue('00000000-0000-4000-8000-000000000001');
    queue.start();
    await queue.whenIdle();

    expect(observed).toEqual([{
      assessmentId: '00000000-0000-4000-8000-000000000001',
      code: 'WORKER_FAILED',
      message: 'Assessment worker failed',
    }]);
    expect(JSON.stringify(observed)).not.toMatch(/raw upstream|token/);
  });

  it('stopAccepting lets active work finish but never starts waiting UUIDs', async () => {
    const active = deferred();
    const started: string[] = [];
    const queue = new AssessmentQueue(async assessmentId => {
      started.push(assessmentId);
      if (started.length === 1) await active.promise;
    }, 1);
    queue.enqueue('00000000-0000-4000-8000-000000000001');
    queue.enqueue('00000000-0000-4000-8000-000000000002');
    queue.start();
    await eventually(() => expect(started).toEqual(['00000000-0000-4000-8000-000000000001']));

    queue.stopAccepting();
    active.resolve();
    await queue.waitForActive();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(started).toEqual(['00000000-0000-4000-8000-000000000001']);
  });
});
