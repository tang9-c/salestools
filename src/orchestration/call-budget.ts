export type UpstreamSource = 'qcc' | 'doubao_search' | 'ark';

export interface CallBudgetLimits {
  qcc: number;
  doubaoSearch: number;
  ark: number;
  total: number;
}

export interface CallBudgetUsage {
  qcc: number;
  doubaoSearch: number;
  ark: number;
  total: number;
}

export interface CallBudgetOptions {
  reserveArkCalls?: number;
}

const sourceKey = {
  qcc: 'qcc',
  doubao_search: 'doubaoSearch',
  ark: 'ark',
} as const;

export class CallBudget {
  private readonly used: CallBudgetUsage = { qcc: 0, doubaoSearch: 0, ark: 0, total: 0 };
  private readonly reserveArkCalls: number;

  constructor(
    private readonly limits: CallBudgetLimits,
    options: CallBudgetOptions = {},
  ) {
    this.reserveArkCalls = options.reserveArkCalls ?? 0;
    if (!Number.isInteger(this.reserveArkCalls)
      || this.reserveArkCalls < 0
      || this.reserveArkCalls > limits.ark
      || this.reserveArkCalls > limits.total) {
      throw new RangeError('reserveArkCalls must fit both Ark and total call limits');
    }
  }

  canConsume(source: UpstreamSource, count = 1): boolean {
    const key = sourceKey[source];
    const reservedArkRemaining = source === 'ark'
      ? 0
      : Math.max(0, this.reserveArkCalls - this.used.ark);
    return count >= 0
      && this.used[key] + count <= this.limits[key]
      && this.used.total + count <= this.limits.total - reservedArkRemaining;
  }

  tryConsume(source: UpstreamSource): boolean {
    if (!this.canConsume(source)) return false;
    const key = sourceKey[source];
    this.used[key] += 1;
    this.used.total += 1;
    return true;
  }

  remaining(source: UpstreamSource): number {
    const key = sourceKey[source];
    const reservedArkRemaining = source === 'ark'
      ? 0
      : Math.max(0, this.reserveArkCalls - this.used.ark);
    return Math.max(0, Math.min(
      this.limits[key] - this.used[key],
      this.limits.total - reservedArkRemaining - this.used.total,
    ));
  }

  usage(): CallBudgetUsage {
    return { ...this.used };
  }
}
