import { sleep } from './util';

export interface RateLimiterOptions {
  perMinute: number;
  minIntervalMs: number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;

  constructor(private options: RateLimiterOptions) {}

  configure(options: RateLimiterOptions): void {
    this.options = options;
  }

  acquire(): Promise<void> {
    const run = this.chain.then(() => this.waitTurn());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 收到 429 后让所有排队请求一起等待 */
  noteCooldown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.max(0, ms));
  }

  private async waitTurn(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((stamp) => now - stamp < 60_000);

      if (now < this.cooldownUntil) {
        await sleep(Math.min(this.cooldownUntil - now, 30_000));
        continue;
      }

      const tooMany = this.timestamps.length >= this.options.perMinute;
      const last = this.timestamps[this.timestamps.length - 1] ?? 0;
      const tooSoon = now - last < this.options.minIntervalMs;

      if (!tooMany && !tooSoon) break;

      const wait = tooMany
        ? Math.max(250, this.options.minIntervalMs)
        : Math.max(50, this.options.minIntervalMs - (now - last));
      await sleep(wait);
    }
    this.timestamps.push(Date.now());
  }
}
