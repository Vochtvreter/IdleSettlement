import { MAP_H, MAP_W } from './data';

const N = MAP_W * MAP_H;

/**
 * Full-map working arrays for a search over the great world. A search records every tile it writes
 * to with `touch`, and only those entries are put back when it is done, so a search costs what it
 * explores rather than allocating (and later freeing) megabytes each time.
 */
export class Search {
  /** Cost so far; Infinity where the search has not been. */
  readonly dist = new Float32Array(N).fill(Infinity);
  /** The tile each was reached from; -1 where none. */
  readonly prev = new Int32Array(N).fill(-1);
  /** Anything else the search keeps per tile; 0 where unset. */
  readonly extra = new Float32Array(N);
  /** Visited / closed flags; 0 where unset. */
  readonly flag = new Uint8Array(N);
  private touched: number[] = [];

  /** Note a tile before its entries are first written. */
  touch(i: number) {
    this.touched.push(i);
  }

  reset() {
    const { dist, prev, extra, flag, touched } = this;
    for (let k = 0; k < touched.length; k++) {
      const i = touched[k];
      dist[i] = Infinity;
      prev[i] = -1;
      extra[i] = 0;
      flag[i] = 0;
    }
    touched.length = 0;
  }
}

const pool: Search[] = [];

/** Run a search with a set of working arrays, handed back clean afterwards. Searches may nest. */
export function withSearch<T>(f: (s: Search) => T): T {
  const s = pool.pop() ?? new Search();
  try {
    return f(s);
  } finally {
    s.reset();
    pool.push(s);
  }
}
