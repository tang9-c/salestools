type Awaitable<T> = T | Promise<T>;

export class ActivityTracker {
  private active = 0;
  private readonly idleWaiters = new Set<() => void>();

  begin(): () => void {
    this.active += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.active -= 1;
      if (this.active !== 0) return;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    };
  }

  async track<T>(work: Promise<T> | (() => Awaitable<T>)): Promise<T> {
    const end = this.begin();
    try {
      return await (typeof work === 'function' ? work() : work);
    } finally {
      end();
    }
  }

  whenIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }
}
