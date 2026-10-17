import { ResearchError, type ResearchRepository } from './repository.js';
/** The database owns acceptance, FIFO order and claims; memory owns only one live connection lifecycle. */
export class ResearchQueue {
  private started = false;
  private accepting = true;
  private active: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
  constructor(
    private readonly repository: ResearchRepository,
    private readonly run: (id: string, signal: AbortSignal) => Promise<void>,
  ) {}
  start(): void {
    if (!this.accepting) return;
    this.started = true;
    this.pump();
  }
  assertAccepting(): void {
    if (!this.accepting) throw new ResearchError('RESEARCH_SHUTTING_DOWN');
  }
  enqueue(): void {
    this.assertAccepting();
    this.pump();
  }
  private pump(): void {
    if (!this.started || !this.accepting || this.active) return;
    const run = this.repository.claim();
    if (!run) return;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => this.run(run.run_id, controller.signal))
      .catch(() => {
        this.repository.fail(run.run_id, 'RESEARCH_FAILED');
      })
      .finally(() => {
        // A custom/injected runner must not strand a database claim.
        if (this.repository.getRun(run.run_id)?.status === 'running')
          this.repository.fail(run.run_id, 'RESEARCH_FAILED');
        this.active = null;
        this.pump();
      });
    this.active = { id: run.run_id, controller, done };
  }
  stopAccepting(): void {
    this.accepting = false;
    this.started = false;
    for (const run of this.repository.queued())
      this.repository.fail(run.run_id, 'SERVICE_SHUTDOWN');
  }
  cancel(id: string, actor: string) {
    const result = this.repository.cancel(id, actor);
    if (this.active?.id === id && result.status === 'cancelled')
      this.active.controller.abort();
    return result;
  }
  abortActive(): void {
    if (!this.active) return;
    this.repository.fail(this.active.id, 'SERVICE_SHUTDOWN');
    this.active.controller.abort();
  }
  async waitForActive(): Promise<void> {
    while (this.active) await this.active.done;
  }
}
