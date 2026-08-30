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

const sourceKey = {
  qcc: 'qcc',
  doubao_search: 'doubaoSearch',
  ark: 'ark',
} as const;

export class CallBudget {
  private readonly used: CallBudgetUsage = { qcc: 0, doubaoSearch: 0, ark: 0, total: 0 };

  constructor(private readonly limits: CallBudgetLimits) {}

  canConsume(source: UpstreamSource, count = 1): boolean {
    const key = sourceKey[source];
    return count >= 0
      && this.used[key] + count <= this.limits[key]
      && this.used.total + count <= this.limits.total;
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
    return Math.max(0, Math.min(this.limits[key] - this.used[key], this.limits.total - this.used.total));
  }

  usage(): CallBudgetUsage {
    return { ...this.used };
  }
}
