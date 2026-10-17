import type { ResearchClock } from '../src/research/policy.js';
export class TestClock implements ResearchClock {
  time = 0;
  private timers = new Map<symbol, { at: number; fn: () => void }>();
  monotonic = () => this.time;
  wall = () => new Date(Date.UTC(2026, 9, 17) + this.time);
  timer(fn: () => void, delay: number) {
    const id = Symbol();
    this.timers.set(id, { at: this.time + delay, fn });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers])
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.fn();
      }
  }
}
