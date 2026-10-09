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
let cost = new Float32Array(MAP_W * MAP_H);

function prepare(state: GameState) {
  const key = `${state.seed}:${state.roads.length}:${state.trails.length}:${state.graded.length}:${state.buildings.length}:${state.buildings.filter((b) => b.done).length}:${state.landEpoch >> 3}`;
  if (key === cacheKey) return;
  cacheKey = key;
  cache.clear();
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  cost = new Float32Array(n);
  const wood = landMax(state.seed).wood;
  for (let i = 0; i < n; i++) {
    const t = map.terrain[i];
    if (isWater(t) || t === T.Mountain || t === T.Peak) cost[i] = Infinity;
    else if (t === T.Hills) cost[i] = 1.4;
    else cost[i] = wood[i] && wooded(state, i) ? 1.6 : 1;
  }
  for (const i of state.graded) cost[i] = 1;
  // Trails cross fords and mountain passes, slower than a road.
  for (const i of state.trails) cost[i] = 0.7;
  for (const i of state.roads) cost[i] = 0.4;
  for (const h of state.buildings) {
    if (h.type !== 'campfire') continue;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (inBounds(h.x + dx, h.y + dy) && isFinite(cost[idx(h.x + dx, h.y + dy)])) cost[idx(h.x + dx, h.y + dy)] = 0.4;
  }
  for (const b of state.buildings) {
    if (b.type === 'bridge') cost[idx(b.x, b.y)] = b.done ? 0.4 : Infinity;
    else if (b.type !== 'campfire') for (const i of tilesOf(b)) cost[i] = 3;
  }
}

/** Tiles to walk through from one tile to another (excluding the start), or null to go straight. */
export function findPath(state: GameState, from: number, to: number): number[] | null {
  prepare(state);
  if (from === to) return [];
  const key = from * MAP_W * MAP_H + to;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 4000) cache.clear();
  const n = MAP_W * MAP_H;
  const g = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  const gx = tx(to);
  const gy = ty(to);
  const hcost = (i: number) => Math.hypot(tx(i) - gx, ty(i) - gy) * 0.4;
  g[from] = 0;
  heap.push(from, hcost(from));
  const closed = new Uint8Array(n);
  let found = false;
  for (let iter = 0; heap.size && iter < 6000; iter++) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
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
      const c = j === to ? Math.min(cost[j], 1) : cost[j];
      if (!isFinite(c)) continue;
      // No cutting corners past water or rock.
      if (dx && dy && (!isFinite(cost[idx(x + dx, y)]) || !isFinite(cost[idx(x, y + dy)]))) continue;
      const ng = g[i] + ((dx && dy ? 1.42 : 1) * (c + Math.min(cost[i], 3))) / 2;
      if (ng < g[j]) {
        g[j] = ng;
        prev[j] = i;
        heap.push(j, ng + hcost(j));
      }
    }
  }
  let path: number[] | null = null;
  if (found) {
    path = [];
    for (let k = to; k !== from && k >= 0; k = prev[k]) path.push(k);
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
