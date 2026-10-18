import {
  CallBudget,
  type UpstreamSource,
} from '../orchestration/call-budget.js';

export interface ResearchLimits {
  timeoutMs: number;
  qcc: number;
  search: number;
  ark: number;
  total: number;
}
export function researchLimits(
  input: Partial<ResearchLimits> = {},
): ResearchLimits {
  const limits = {
    timeoutMs: 600000,
    qcc: 4,
    search: 16,
    ark: 8,
    total: 28,
    ...input,
  };
  if (
    Object.values(limits).some((n) => !Number.isInteger(n) || n < 1) ||
    limits.timeoutMs < 60000 ||
    limits.timeoutMs > 1800000 ||
    limits.ark < 2 ||
    limits.total < 3 ||
    limits.total > limits.qcc + limits.search + limits.ark
  )
    throw new Error('RESEARCH_CONFIG_INVALID');
  return limits;
}
export interface ResearchClock {
  monotonic(): number;
  wall(): Date;
  /** Returns a disposer; implementations must fire at the requested monotonic delay. */
  timer(fn: () => void, delayMs: number): () => void;
}
export const systemResearchClock: ResearchClock = {
  monotonic: () => performance.now(),
  wall: () => new Date(),
  timer(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
export type ResearchStage = 'collect' | 'final';
export class ResearchPolicy {
  readonly limits: ResearchLimits;
  readonly reserveMs: number;
  readonly collectUntil: number;
  readonly upstreamUntil: number;
  private readonly budget: CallBudget;
  private graphUsed = 0;
  private finalArkUsed = 0;
  private readonly collection = new AbortController();
  private readonly upstream = new AbortController();
  private readonly disposers: (() => void)[];
  constructor(
    input: Partial<ResearchLimits> = {},
    readonly clock = systemResearchClock,
    private readonly lifecycle?: AbortSignal,
    private readonly finalArkLimit?: number,
  ) {
    this.limits = researchLimits(input);
    const start = clock.monotonic();
    this.reserveMs = Math.min(60000, Math.floor(this.limits.timeoutMs / 5));
    this.upstreamUntil = start + this.limits.timeoutMs;
    this.collectUntil = this.upstreamUntil - this.reserveMs;
    this.budget = new CallBudget({
      qcc: this.limits.qcc,
      doubaoSearch: this.limits.search,
      ark: this.limits.ark,
      total: this.limits.total,
    });
    this.disposers = [
      clock.timer(
        () => this.collection.abort(new Error('COLLECTION_DEADLINE')),
        this.collectUntil - start,
      ),
      clock.timer(
        () => this.upstream.abort(new Error('TIME_BUDGET_EXHAUSTED')),
        this.upstreamUntil - start,
      ),
    ];
  }
  signal(stage: ResearchStage): AbortSignal {
    const signals = [
      this.upstream.signal,
      ...(stage === 'collect' ? [this.collection.signal] : []),
      ...(this.lifecycle ? [this.lifecycle] : []),
    ];
    return AbortSignal.any(signals);
  }
  isOpen(stage: ResearchStage): boolean {
    return (
      !this.lifecycle?.aborted &&
      !this.signal(stage).aborted &&
      this.clock.monotonic() <
        (stage === 'collect' ? this.collectUntil : this.upstreamUntil)
    );
  }
  assertOpen(stage: ResearchStage): void {
    if (this.lifecycle?.aborted) throw new Error('RESEARCH_ABORTED');
    if (!this.isOpen(stage))
      throw new Error(
        stage === 'collect' && this.clock.monotonic() < this.upstreamUntil
          ? 'COLLECTION_DEADLINE'
          : 'TIME_BUDGET_EXHAUSTED',
      );
  }
  remainingModel() {
    return this.limits.ark - this.budget.usage().ark;
  }
  canStart(source: UpstreamSource, stage: ResearchStage): boolean {
    const used = this.budget.usage();
    return (
      this.isOpen(stage) &&
      !(
        source === 'ark' &&
        stage === 'final' &&
        this.finalArkLimit !== undefined &&
        this.finalArkUsed >= this.finalArkLimit
      ) &&
      this.budget.canConsume(source) &&
      (stage === 'final' ||
        (used.total + 1 <= this.limits.total - 2 &&
          (source !== 'ark' || used.ark + 1 <= this.limits.ark - 2)))
    );
  }
  /** Call only after synchronous preflight; one callback invocation equals one real dispatch. */
  async call<T>(
    source: UpstreamSource,
    stage: ResearchStage,
    dispatch:
      | ((signal: AbortSignal) => Promise<T>)
      | { prepare: () => Promise<(signal: AbortSignal) => Promise<T>> },
    requestSignal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertOpen(stage);
      requestSignal?.throwIfAborted();
      if (!this.canStart(source, stage)) throw new Error('BUDGET_EXHAUSTED');
      const businessDispatch =
        typeof dispatch === 'function' ? dispatch : await dispatch.prepare();
      // Negotiation may consume time or observe cancellation, but never business budget.
      this.assertOpen(stage);
      requestSignal?.throwIfAborted();
      if (!this.canStart(source, stage) || !this.budget.tryConsume(source))
        throw new Error('BUDGET_EXHAUSTED');
      if (source === 'ark' && stage === 'final') this.finalArkUsed++;
      const signal = requestSignal
        ? AbortSignal.any([this.signal(stage), requestSignal])
        : this.signal(stage);
      try {
        const value = await businessDispatch(signal);
        this.assertOpen(stage);
        signal.throwIfAborted();
        return value;
      } catch (error) {
        this.assertOpen(stage);
        signal.throwIfAborted();
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : '';
        const status =
          error && typeof error === 'object' && 'status' in error
            ? Number(error.status)
            : 0;
        const transientHttp =
          code === 'REMOTE_HTTP_ERROR' && (status === 429 || status >= 500);
        if (
          attempt ||
          (!transientHttp &&
            ![
              'NETWORK_ERROR',
              'TIMEOUT',
              'TRANSPORT',
              'RATE_LIMITED',
              'REMOTE_SERVER_ERROR',
            ].includes(code))
        )
          throw error;
      }
    }
    throw new Error('UNREACHABLE');
  }
  async graph<T>(dispatch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen('collect');
    if (this.graphUsed >= 40) throw new Error('GRAPH_IPC_BUDGET_EXHAUSTED');
    this.graphUsed++;
    const result = await dispatch(this.signal('collect'));
    this.assertOpen('collect');
    return result;
  }
  usage() {
    const u = this.budget.usage();
    return {
      qcc: u.qcc,
      search: u.doubaoSearch,
      ark: u.ark,
      total: u.total,
      graph: this.graphUsed,
    };
  }
  close() {
    for (const dispose of this.disposers) dispose();
    this.collection.abort();
    this.upstream.abort();
  }
}
