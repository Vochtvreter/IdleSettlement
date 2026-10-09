import { MAP_H, MAP_W } from '../game/data';
import { landMax, tilesOf, wooded } from '../game/land';
import { getMap, idx, inBounds, isWater, N8, tx, ty } from '../game/map';
import type { GameState } from '../game/types';
import { T } from '../game/types';

/**
 * Walking routes for the settlers on screen (visual only). People keep to roads and the green where
 * they can, cross rivers only by bridge, and go round mountains and buildings.
 */
const cache = new Map<number, number[] | null>();
let cacheKey = '';
/** Costs that differ from the bare land: roads, trails, greens, levelled rock and buildings. */
let overrides = new Map<number, number>();
let current: GameState | null = null;

/** The bare land's cost per tile (Infinity for water and rock), worked out once per world; -1 marks woodland. */
const baseCost = new Map<number, Float32Array>();
function bare(seed: number): Float32Array {
  let c = baseCost.get(seed);
  if (c) return c;
  const map = getMap(seed);
  const wood = landMax(seed).wood;
  c = new Float32Array(MAP_W * MAP_H);
  for (let i = 0; i < c.length; i++) {
    const t = map.terrain[i];
    c[i] = isWater(t) || t === T.Mountain || t === T.Peak ? Infinity : t === T.Hills ? 1.4 : wood[i] ? -1 : 1;
  }
  if (baseCost.size >= 2) baseCost.delete(baseCost.keys().next().value!);
  baseCost.set(seed, c);
  return c;
}

function costAt(i: number): number {
  const o = overrides.get(i);
  if (o !== undefined) return o;
  const c = bare(current!.seed)[i];
  return c === -1 ? (wooded(current!, i) ? 1.6 : 1) : c;
}

function prepare(state: GameState) {
  current = state;
  const key = `${state.seed}:${state.roads.length}:${state.trails.length}:${state.graded.length}:${state.buildings.length}:${state.buildings.filter((b) => b.done).length}:${state.landEpoch >> 3}`;
  if (key === cacheKey) return;
  cacheKey = key;
  cache.clear();
  overrides = new Map();
  const base = bare(state.seed);
  for (const i of state.graded) overrides.set(i, 1);
  // Trails cross fords and mountain passes, slower than a road.
  for (const i of state.trails) overrides.set(i, 0.7);
  for (const i of state.roads) overrides.set(i, 0.4);
  for (const h of state.buildings) {
    if (h.type !== 'campfire') continue;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!inBounds(h.x + dx, h.y + dy)) continue;
        const i = idx(h.x + dx, h.y + dy);
        if (isFinite(overrides.get(i) ?? base[i])) overrides.set(i, 0.4);
      }
  }
  for (const b of state.buildings) {
    if (b.type === 'bridge') overrides.set(idx(b.x, b.y), b.done ? 0.4 : Infinity);
    else if (b.type !== 'campfire') for (const i of tilesOf(b)) overrides.set(i, 3);
  }
}

// Search buffers, reused: an entry only counts when its stamp is the current search's.
const N = MAP_W * MAP_H;
const gBuf = new Float32Array(N);
const prevBuf = new Int32Array(N);
const seenAt = new Uint32Array(N);
const closedAt = new Uint32Array(N);
let search = 0;

/** Tiles to walk through from one tile to another (excluding the start), or null to go straight. */
export function findPath(state: GameState, from: number, to: number): number[] | null {
  prepare(state);
  if (from === to) return [];
  const key = from * MAP_W * MAP_H + to;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 4000) cache.clear();
  const s = ++search;
  const g = (i: number) => (seenAt[i] === s ? gBuf[i] : Infinity);
  const heap = new MinHeap();
  const gx = tx(to);
  const gy = ty(to);
  const hcost = (i: number) => Math.hypot(tx(i) - gx, ty(i) - gy) * 0.4;
  seenAt[from] = s;
  gBuf[from] = 0;
  prevBuf[from] = -1;
  heap.push(from, hcost(from));
  let found = false;
  for (let iter = 0; heap.size && iter < 6000; iter++) {
    const i = heap.pop();
    if (closedAt[i] === s) continue;
    closedAt[i] = s;
    if (i === to) {
      found = true;
      break;
    }
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      const c = j === to ? Math.min(costAt(j), 1) : costAt(j);
      if (!isFinite(c)) continue;
      // No cutting corners past water or rock.
      if (dx && dy && (!isFinite(costAt(idx(x + dx, y))) || !isFinite(costAt(idx(x, y + dy))))) continue;
      const ng = g(i) + ((dx && dy ? 1.42 : 1) * (c + Math.min(costAt(i), 3))) / 2;
      if (ng < g(j)) {
        seenAt[j] = s;
        gBuf[j] = ng;
        prevBuf[j] = i;
        heap.push(j, ng + hcost(j));
      }
    }
  }
  let path: number[] | null = null;
  if (found) {
    path = [];
    for (let k = to; k !== from && k >= 0; k = prevBuf[k]) path.push(k);
    path.reverse();
  }
  cache.set(key, path);
  return path;
}

class MinHeap {
  private v: number[] = [];
  private p: number[] = [];
  get size() {
    return this.v.length;
  }
  push(x: number, pri: number) {
    const v = this.v;
    const p = this.p;
    let k = v.length;
    v.push(x);
    p.push(pri);
    while (k > 0) {
      const u = (k - 1) >> 1;
      if (p[u] <= pri) break;
      v[k] = v[u];
      p[k] = p[u];
      k = u;
    }
    v[k] = x;
    p[k] = pri;
  }
  pop(): number {
    const v = this.v;
    const p = this.p;
    const top = v[0];
    const lx = v.pop()!;
    const lp = p.pop()!;
    const n = v.length;
    if (n) {
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        if (l >= n) break;
        const c = l + 1 < n && p[l + 1] < p[l] ? l + 1 : l;
        if (p[c] >= lp) break;
        v[k] = v[c];
        p[k] = p[c];
        k = c;
      }
      v[k] = lx;
      p[k] = lp;
    }
    return top;
  }
}
