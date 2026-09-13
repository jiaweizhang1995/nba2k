// Deterministic seeded PRNG.
// Every random draw in the engine goes through a PRNG whose initial state is
// derived from (seed, salt). Same save seed + same salt + same input sequence
// => identical results, regardless of when ops are executed.

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function hashSeed(input: string | number): number {
  const fn = xmur3(String(input));
  return fn();
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PRNG {
  private gen: () => number;
  private draws = 0;

  constructor(seed: string | number, salt: string | number = "") {
    const s = hashSeed(`${seed}|${salt}`);
    this.gen = mulberry32(s);
  }

  next(): number {
    this.draws++;
    return this.gen();
  }

  /** uniform integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** approximate normal distribution via sum of uniforms (mean 0, sd ~0.29) */
  gauss(mean = 0, sd = 1): number {
    const u = this.next() + this.next() + this.next() + this.next() - 2; // mean 0, sd ~0.577
    return mean + u * sd * 1.732;
  }

  /** weighted pick; weights must be non-negative */
  weighted<T>(items: readonly T[], weightOf: (t: T) => number): T {
    const weights = items.map((it) => Math.max(0, weightOf(it)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return items[Math.floor(this.next() * items.length)];
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}

/** Convenience: create a PRNG for a given save context. */
export function rngFor(seed: number | string, ...salt: (string | number)[]): PRNG {
  return new PRNG(seed, salt.join(":"));
}
