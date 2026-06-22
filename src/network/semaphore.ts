/** Counting semaphore for concurrency control. */

export class Semaphore {
  private current = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.current--;
    const next = this.waiters.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  get inFlight(): number {
    return this.current;
  }
  get waiting(): number {
    return this.waiters.length;
  }
  get available(): number {
    return Math.max(0, this.max - this.current);
  }
}
