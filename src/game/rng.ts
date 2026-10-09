/** Small, fast, seedable PRNG (mulberry32). State is a plain number so it serialises with the save. */
export class Rng {
  constructor(public state: number) {}

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  weighted<T>(items: readonly { w: number; v: T }[]): T | null {
    const total = items.reduce((s, i) => s + Math.max(0, i.w), 0);
    if (total <= 0) return null;
    let r = this.next() * total;
    for (const i of items) {
      r -= Math.max(0, i.w);
      if (r <= 0) return i.v;
    }
    return items[items.length - 1].v;
  }

  /** Poisson-ish draw for small expected values. */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L && k < 50);
    return k - 1;
  }
}

/** Stateless hash for deterministic per-tile / per-pixel variation. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
