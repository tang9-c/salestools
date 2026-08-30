export type QueueWorkerErrorEvent = Readonly<{
  assessmentId: string;
  code: 'WORKER_FAILED';
  message: 'Assessment worker failed';
}>;

export interface AssessmentQueueOptions {
  onWorkerError?: (event: QueueWorkerErrorEvent) => void;
}

export class AssessmentQueue {
  private readonly waiting: string[] = [];
  private readonly known = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly activeWaiters = new Set<() => void>();
  private active = 0;
  private started = false;
  private accepting = true;

  constructor(
    private readonly runAssessment: (assessmentId: string) => Promise<void>,
    private readonly concurrency = 1,
    private readonly options: AssessmentQueueOptions = {},
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
  }

  enqueue(assessmentId: string): boolean {
    if (!this.accepting) throw new Error('Assessment queue is not accepting new work');
    if (this.known.has(assessmentId)) return false;
    this.known.add(assessmentId);
    this.waiting.push(assessmentId);
    this.pump();
    return true;
  }

  start(): void {
    this.started = true;
    this.pump();
  }

  stopAccepting(): void {
    this.accepting = false;
    this.resolveIdle();
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && (!this.accepting || this.waiting.length === 0)) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  waitForActive(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise(resolve => this.activeWaiters.add(resolve));
  }

  private pump(): void {
    if (!this.started || !this.accepting) return;
    while (this.active < this.concurrency) {
      const assessmentId = this.waiting.shift();
      if (assessmentId === undefined) break;
      this.active += 1;
      void this.runAssessment(assessmentId)
        .catch(() => this.reportWorkerError(assessmentId))
        .finally(() => {
          this.active -= 1;
          this.known.delete(assessmentId);
          this.pump();
          this.resolveActive();
          this.resolveIdle();
        });
    }
  }

  private resolveActive(): void {
    if (this.active !== 0) return;
    for (const resolve of this.activeWaiters) resolve();
    this.activeWaiters.clear();
  }

  private reportWorkerError(assessmentId: string): void {
    const event: QueueWorkerErrorEvent = {
      assessmentId,
      code: 'WORKER_FAILED',
      message: 'Assessment worker failed',
    };
    if (this.options.onWorkerError !== undefined) {
      try {
        this.options.onWorkerError(event);
        return;
      } catch {
        // Fall through to the safe default sink.
      }
    }
    process.stderr.write(`${JSON.stringify(event)}\n`);
  }

  private resolveIdle(): void {
    if (this.active !== 0 || (this.accepting && this.waiting.length !== 0)) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
