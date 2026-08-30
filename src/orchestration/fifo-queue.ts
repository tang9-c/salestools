export class AssessmentQueue {
  private readonly waiting: string[] = [];
  private readonly known = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private started = false;
  private accepting = true;

  constructor(
    private readonly runAssessment: (assessmentId: string) => Promise<void>,
    private readonly concurrency = 1,
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
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  private pump(): void {
    if (!this.started) return;
    while (this.active < this.concurrency) {
      const assessmentId = this.waiting.shift();
      if (assessmentId === undefined) break;
      this.active += 1;
      void this.runAssessment(assessmentId)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.known.delete(assessmentId);
          this.pump();
          this.resolveIdle();
        });
    }
  }

  private resolveIdle(): void {
    if (this.active !== 0 || this.waiting.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
