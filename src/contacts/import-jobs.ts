interface Job {
  fileId: string;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<unknown>;
  persistReady: (value: unknown) => Promise<void>;
  persistFailed?: (code: string, error?: unknown) => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  active: boolean;
  done: boolean;
  completed: Promise<void>;
  complete: () => void;
}

export class ImportJobs {
  private readonly queue: Job[] = [];
  private readonly jobs = new Map<string, Job>();
  private active = 0;
  private stopped = false;

  constructor(private readonly options: {
    concurrency: number;
    timeoutMs: number;
    release: (fileId: string) => Promise<void>;
    reserve?: (actor: string) => Promise<string>;
    submit?: (fileId: string) => void;
    onCleanup?: (fileId: string, error?: unknown) => void;
  }) {}

  reserve(actor: string): Promise<string> {
    if (!this.options.reserve) throw new Error('UPLOAD_RESERVATION_UNAVAILABLE');
    return this.options.reserve(actor);
  }

  release(fileId: string): Promise<void> { return this.options.release(fileId); }

  private recordCleanup(fileId: string, error?: unknown): void {
    try { this.options.onCleanup?.(fileId, error); }
    catch { /* A broken log sink must not strand the queue or skip completion. */ }
  }

  start<T>(fileId: string, run: (signal: AbortSignal) => Promise<T>,
    persistReady: (value: T) => Promise<void>, persistFailed?: (code: string, error?: unknown) => Promise<void>): Promise<void> {
    if (this.stopped || this.jobs.has(fileId)) return Promise.reject(new Error('IMPORT_UNAVAILABLE'));
    try { this.options.submit?.(fileId); }
    catch (error) { return Promise.reject(error); }
    return new Promise<void>((resolve, reject) => {
      let complete!: () => void;
      const completed = new Promise<void>(done => { complete = done; });
      const job: Job = { fileId, controller: new AbortController(),
        run: run as Job['run'], persistReady: persistReady as Job['persistReady'],
        persistFailed, resolve, reject, active: false, done: false, completed, complete };
      this.jobs.set(fileId, job);
      this.queue.push(job);
      this.pump();
    });
  }

  async cancel(fileId: string): Promise<void> {
    const job = this.jobs.get(fileId);
    if (!job) return;
    if (job.done) { await job.completed; return; }
    job.controller.abort();
    if (job.active) { await job.completed; return; }
    if (!job.active) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.done = true;
      this.jobs.delete(fileId);
      try { await this.options.release(fileId); }
      finally { job.reject(new Error('IMPORT_CANCELLED')); job.complete(); }
    }
  }

  async recover(): Promise<void> {
    this.stopped = true;
    const completed = [...this.jobs.values()].map(job => job.completed);
    await Promise.all([...this.jobs.keys()].map(id => this.cancel(id)));
    await Promise.all(completed);
  }

  private pump(): void {
    while (!this.stopped && this.active < this.options.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      job.active = true;
      this.active += 1;
      void this.execute(job);
    }
  }

  private async execute(job: Job): Promise<void> {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; job.controller.abort(); }, this.options.timeoutMs);
    timeout.unref();
    const aborted = new Promise<never>((_resolve, reject) => {
      job.controller.signal.addEventListener('abort', () => reject(new Error('IMPORT_CANCELLED')), { once: true });
    });
    let failure: Error | null = null;
    try {
      const value = await Promise.race([job.run(job.controller.signal), aborted]);
      if (job.controller.signal.aborted) throw new Error('IMPORT_CANCELLED');
      await job.persistReady(value);
    } catch (error) {
      const code = timedOut ? 'IMPORT_TIMEOUT' : job.controller.signal.aborted ? 'IMPORT_CANCELLED' : 'IMPORT_FAILED';
      failure = new Error(code, { cause: error });
      try { await job.persistFailed?.(code, error); }
      catch (persistenceError) {
        // Preserve both failures: callers must not mistake a failed durable write
        // for a successfully recorded parser failure.
        Object.assign(failure, { persistenceError });
      }
    } finally {
      clearTimeout(timeout);
      job.done = true;
      this.jobs.delete(job.fileId);
      try { await this.options.release(job.fileId); this.recordCleanup(job.fileId); }
      catch (error) {
        this.recordCleanup(job.fileId, error);
        failure ??= new Error('IMPORT_CLEANUP_FAILED', { cause: error });
      }
      this.active -= 1;
      this.pump();
      if (failure) job.reject(failure); else job.resolve();
      job.complete();
    }
  }
}
