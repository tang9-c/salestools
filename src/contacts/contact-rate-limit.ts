export class ContactRateLimitError extends Error {
  readonly code = 'CONTACT_RATE_LIMITED';
  constructor(readonly retryAfterSeconds: number) { super('CONTACT_RATE_LIMITED'); }
}

/** ponytail: single-instance, restart clears counters; shared storage only if replicas are added. */
export class ContactRateLimit {
  private readonly windows = new Map<string, { expires: number; count: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  consume(actor: string): void {
    const now = this.now();
    for (const [key, window] of this.windows) if (window.expires <= now) this.windows.delete(key);
    const window = this.windows.get(actor) ?? { expires: now + 60_000, count: 0 };
    if (window.count >= 5) throw new ContactRateLimitError(Math.max(1, Math.ceil((window.expires - now) / 1000)));
    window.count += 1;
    this.windows.set(actor, window);
  }
}
