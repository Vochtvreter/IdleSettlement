/**
 * The living land: what each tile still holds (timber, stone, ore and wildlife), how it is used up
 * and how it grows back, plus the roads and bridges that tie the settlement together.
 * Everything here is deterministic so it runs the same offline.
 */
import { BUILDABLE, MAP_H, MAP_W } from './data';
import { derived } from './derived';
import { getMap, idx, inBounds, isWater, N4, tx, ty, type WorldMap } from './map';
import type { Building, BuildingId, GameState, Land, LandLayer } from './types';
import { F, T } from './types';

/** A forest tile stands (and blocks building) while it holds at least this share of its timber. */
export const WOODED = 0.25;

export const LAYERS: LandLayer[] = ['wood', 'stone', 'ore', 'life'];

/** Share of a herd, shoal or thicket that is always left to breed or regrow. */
export const LIFE_FLOOR = 0.15;

interface LandMax {
  wood: Float32Array;
  stone: Float32Array;
  ore: Float32Array;
  life: Float32Array;
  forestTiles: number[];
  lifeTiles: number[];
}

const maxCache = new Map<number, LandMax>();

/** What each tile holds when untouched. */
export function landMax(seed: number): LandMax {
  let m = maxCache.get(seed);
  if (m) return m;
  const map = getMap(seed);
  const n = MAP_W * MAP_H;
  m = { wood: new Float32Array(n), stone: new Float32Array(n), ore: new Float32Array(n), life: new Float32Array(n), forestTiles: [], lifeTiles: [] };
  for (let i = 0; i < n; i++) {
    const t = map.terrain[i];
    const f = map.feature[i];
    if (t === T.Forest) m.wood[i] = 60;
    if (t === T.Dense) m.wood[i] = 100;
    if (m.wood[i]) m.forestTiles.push(i);
    if (t === T.Hills) m.stone[i] = 240;
    if (t === T.Mountain) m.stone[i] = 480;
    if (t === T.Peak) m.stone[i] = 300;
    if (t === T.Hills) m.ore[i] = 60;
    if (t === T.Mountain) m.ore[i] = 250;
    if (t === T.Peak) m.ore[i] = 150;
    if (f === F.Ore) m.ore[i] = 1000;
    if (f === F.Game) m.life[i] = 100;
    if (f === F.Fish) m.life[i] = 60;
    if (f === F.Berries) m.life[i] = 40;
    if (m.life[i]) m.lifeTiles.push(i);
  }
  maxCache.set(seed, m);
  return m;
}

export function initLand(seed: number): Land {
  const m = landMax(seed);
  return { wood: Array.from(m.wood), stone: Array.from(m.stone), ore: Array.from(m.ore), life: Array.from(m.life) };
}

/** Share of a tile's resource that is left (1 when the tile never held any). */
export function landFrac(state: GameState, layer: LandLayer, i: number) {
  const max = landMax(state.seed)[layer][i];
  return max > 0 ? state.land[layer][i] / max : 1;
}

/** A forest tile whose trees still stand. */
export function wooded(state: GameState, i: number) {
  const max = landMax(state.seed).wood[i];
  return max > 0 && state.land.wood[i] >= max * WOODED;
}

export function hearthOf(state: GameState): Building {
  return state.buildings.find((b) => b.type === 'campfire') ?? state.buildings[0];
}

/** The open village green around the hearth: never built on, always part of the road network. */
export function isGreen(state: GameState, i: number) {
  const h = hearthOf(state);
  return Math.max(Math.abs(tx(i) - h.x), Math.abs(ty(i) - h.y)) <= 1 && !blocked(getMap(state.seed), i);
}

/**
 * Four ways lead out of the green, straight along the compass lines from the hearth. They are kept
 * clear of buildings so homes can never wall the hearth in, and roads like to follow them.
 */
export function isStreet(state: GameState, i: number) {
  const h = hearthOf(state);
  const dx = Math.abs(tx(i) - h.x);
  const dy = Math.abs(ty(i) - h.y);
  return (dx === 0 || dy === 0) && dx + dy >= 2 && dx + dy <= 6 && !blocked(getMap(state.seed), i);
}

/** Terrain nobody can walk across: water, mountains and peaks. */
export function blocked(map: WorldMap, i: number) {
  const t = map.terrain[i];
  return isWater(t) || t === T.Mountain || t === T.Peak;
}

/** Land a building could stand on, ignoring what else is there. */
export function dryLand(map: WorldMap, i: number) {
  return BUILDABLE.has(map.terrain[i] as T);
}

// ------------------------------------------------------------------ catchments

/** Where a building's workers take their resource from, nearest (or richest) first. */
export function catchmentAt(state: GameState, type: BuildingId, x: number, y: number, layer: LandLayer): number[] {
  const m = landMax(state.seed);
  const map = getMap(state.seed);
  let r = 0;
  let square = false;
  let only: F | null = null;
  if (layer === 'wood') r = type === 'campfire' ? 5.5 : type === 'lumber' ? 3 : 0;
  if (layer === 'life') {
    r = type === 'campfire' ? 6.5 : type === 'lodge' ? 4.5 : 0;
    only = F.Game;
  }
  if (layer === 'stone' && type === 'quarry') (r = 1), (square = true);
  if (layer === 'ore' && type === 'mine') (r = 1), (square = true);
  if (!r) return [];
  const out: [number, number][] = [];
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      const d = square ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      if (d > r) continue;
      const i = idx(x + dx, y + dy);
      if (!m[layer][i]) continue;
      if (only !== null && map.feature[i] !== only) continue;
      out.push([i, layer === 'ore' ? -m.ore[i] + d * 0.01 : d]);
    }
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return out.map((o) => o[0]);
}

export function layerSum(state: GameState, layer: LandLayer, tiles: number[]) {
  let s = 0;
  for (const i of tiles) s += state.land[layer][i];
  return s;
}

function crossed(layer: LandLayer, before: number, after: number, max: number) {
  if (layer === 'wood') return before >= max * WOODED !== after >= max * WOODED;
  if (layer === 'life') return before >= 5 !== after >= 5;
  return before > 0 && after <= 0;
}

function setStock(state: GameState, layer: LandLayer, i: number, v: number) {
  const max = landMax(state.seed)[layer][i];
  const before = state.land[layer][i];
  const after = v < 0.01 ? 0 : Math.min(max, v);
  state.land[layer][i] = after;
  if (crossed(layer, before, after, max)) state.landEpoch++;
}

/**
 * Take up to `amount` from a set of tiles. Woodcutters clear-fell the nearest mature stand first,
 * diggers work the nearest rock first, and hunters spread over the herds by their size.
 * Returns what was actually taken.
 */
export function drawFrom(state: GameState, layer: LandLayer, tiles: number[], amount: number): number {
  if (amount <= 0 || !tiles.length) return 0;
  const stock = state.land[layer];
  const max = landMax(state.seed)[layer];
  let left = amount;
  if (layer === 'life') {
    // Hunters cannot find the last of a herd: a breeding core always survives.
    const spare = (i: number) => Math.max(0, stock[i] - max[i] * LIFE_FLOOR);
    let total = 0;
    for (const i of tiles) total += spare(i);
    if (total <= 0) return 0;
    const take = Math.min(left, total);
    for (const i of tiles) setStock(state, layer, i, stock[i] - (take * spare(i)) / total);
    return take;
  }
  const passes = layer === 'wood' ? [0.5, 0] : [0];
  for (const min of passes) {
    for (const i of tiles) {
      if (left <= 0) break;
      if (stock[i] <= 0 || stock[i] < max[i] * min) continue;
      const take = Math.min(left, stock[i]);
      setStock(state, layer, i, stock[i] - take);
      left -= take;
    }
  }
  return amount - left;
}

// ------------------------------------------------------------------ growth

/**
 * Daily regrowth. Felled forest springs back, fastest where a lumber camp replants it;
 * game herds and fish breed back toward what the land can carry; berries ripen in the warm seasons.
 */
export function growLand(state: GameState, season: number, opts: { replant: Uint8Array; occupied: Uint8Array; regrow: number; replanting: boolean }) {
  const m = landMax(state.seed);
  const map = getMap(state.seed);
  const wood = state.land.wood;
  const winter = season === 3 ? 0.25 : 1;
  for (const i of m.forestTiles) {
    const max = m.wood[i];
    const v = wood[i];
    if (v >= max) continue;
    if (opts.occupied[i]) {
      if (v) setStock(state, 'wood', i, 0);
      continue;
    }
    let rate = 0;
    if (opts.replanting && opts.replant[i]) rate = 0.3;
    else if (v > 0 || seedsNearby(state, i)) rate = 0.05;
    if (!rate) continue;
    setStock(state, 'wood', i, v + rate * max * 0.025 * winter * opts.regrow);
  }
  const life = state.land.life;
  for (const i of m.lifeTiles) {
    const max = m.life[i];
    const v = life[i];
    if (opts.occupied[i]) {
      if (v) setStock(state, 'life', i, 0);
      continue;
    }
    if (v >= max) continue;
    const f = map.feature[i];
    let g = 0;
    if (f === F.Game) g = 0.04 * v * (1 - v / max) * (season === 3 ? 0.3 : 1) + (v < 3 ? 0.01 : 0);
    else if (f === F.Fish) g = 0.05 * v * (1 - v / max) + (v < 3 ? 0.02 : 0);
    else if (f === F.Berries) g = [1, 1, 0.5, 0][season];
    if (g > 0) setStock(state, 'life', i, v + g * (f === F.Berries ? 1 : opts.regrow));
  }
}

function seedsNearby(state: GameState, i: number) {
  const x = tx(i);
  const y = ty(i);
  for (const [dx, dy] of N4) if (inBounds(x + dx, y + dy) && wooded(state, idx(x + dx, y + dy))) return true;
  return false;
}

/** Fell whatever still grows on a tile (when a building or road takes it), adding the timber to the stores. */
export function clearTile(state: GameState, i: number) {
  const w = state.land.wood[i];
  if (w > 0) {
    const cap = derived(state).caps.wood;
    state.res.wood = Math.max(state.res.wood, Math.min(cap, state.res.wood + w));
    setStock(state, 'wood', i, 0);
  }
  if (state.land.life[i] > 0 && getMap(state.seed).feature[i] === F.Berries) setStock(state, 'life', i, 0);
}

// ------------------------------------------------------------------ reach

/** Tiles people can walk to from the hearth: dry land, plus rivers where a bridge stands. */
export function computeReach(state: GameState): Uint8Array {
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  const bridges = new Uint8Array(n);
  for (const b of state.buildings) if (b.type === 'bridge' && b.done) bridges[idx(b.x, b.y)] = 1;
  const reach = new Uint8Array(n);
  const h = hearthOf(state);
  const start = idx(h.x, h.y);
  const queue = [start];
  reach[start] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (reach[j] || (blocked(map, j) && !bridges[j])) continue;
      reach[j] = 1;
      queue.push(j);
    }
  }
  return reach;
}

// ------------------------------------------------------------------ roads

/** Tiles that already carry the road network: the green, roads and bridges. */
function networkMask(state: GameState): Uint8Array {
  const n = MAP_W * MAP_H;
  const net = new Uint8Array(n);
  for (const i of state.roads) net[i] = 1;
  const h = hearthOf(state);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!inBounds(h.x + dx, h.y + dy)) continue;
      const i = idx(h.x + dx, h.y + dy);
      if (!blocked(getMap(state.seed), i)) net[i] = 1;
    }
  for (const b of state.buildings) if (b.type === 'bridge' || b.type === 'campfire') net[idx(b.x, b.y)] = 1;
  return net;
}

class Heap {
  private a: number[] = [];
  private p: number[] = [];
  get size() {
    return this.a.length;
  }
  push(v: number, pri: number) {
    const a = this.a;
    const p = this.p;
    a.push(v);
    p.push(pri);
    let k = a.length - 1;
    while (k > 0) {
      const u = (k - 1) >> 1;
      if (p[u] <= p[k]) break;
      [a[u], a[k]] = [a[k], a[u]];
      [p[u], p[k]] = [p[k], p[u]];
      k = u;
    }
  }
  pop(): number {
    const a = this.a;
    const p = this.p;
    const top = a[0];
    const lv = a.pop()!;
    const lp = p.pop()!;
    if (a.length) {
      a[0] = lv;
      p[0] = lp;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && p[l] < p[m]) m = l;
        if (r < a.length && p[r] < p[m]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]];
        [p[m], p[k]] = [p[k], p[m]];
        k = m;
      }
    }
    return top;
  }
}

/**
 * The cheapest way from a tile to the road network, avoiding buildings, water and rock and preferring
 * open ground to forest. Returns the new road tiles (not including the start), or null if cut off.
 */
export function roadPath(state: GameState, from: number): number[] | null {
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  const net = networkMask(state);
  const taken = new Uint8Array(n);
  for (const b of state.buildings) if (b.type !== 'bridge' && b.type !== 'campfire') taken[idx(b.x, b.y)] = 1;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  dist[from] = 0;
  heap.push(from, 0);
  const step = (j: number) => {
    const t = map.terrain[j];
    const f = map.feature[j];
    if (f === F.Ruins || f === F.Grove) return Infinity;
    let c = t === T.Sand ? 1.2 : t === T.Hills ? 1.7 : 1;
    if (landMax(state.seed).wood[j]) c = wooded(state, j) ? 3.5 : 1.3;
    if (isStreet(state, j)) c *= 0.5;
    if (f === F.Berries) c += 1.5;
    if (f === F.Ore) c += 4;
    return c;
  };
  while (heap.size) {
    const i = heap.pop();
    if (i !== from && net[i]) {
      const path: number[] = [];
      for (let k = prev[i]; k >= 0 && k !== from; k = prev[k]) path.push(k);
      return path.reverse();
    }
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (taken[j] || j === from) continue;
      let c: number;
      if (net[j]) c = 0.01;
      else if (blocked(map, j)) continue;
      else c = step(j);
      const nd = dist[i] + c;
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        heap.push(j, nd);
      }
    }
  }
  return null;
}

/** Lay a road: the trees along it are felled and the ground is kept clear for good. */
export function layRoad(state: GameState, tiles: number[]) {
  if (!tiles.length) return;
  const have = new Set(state.roads);
  for (const i of tiles) {
    if (have.has(i)) continue;
    have.add(i);
    state.roads.push(i);
    clearTile(state, i);
  }
  state.landEpoch++;
}

// ------------------------------------------------------------------ saving

/** Only tiles that differ from untouched land are stored, as flat [tile, value, ...] lists. */
export function packLand(state: GameState): Record<LandLayer, number[]> {
  const m = landMax(state.seed);
  const out = {} as Record<LandLayer, number[]>;
  for (const l of LAYERS) {
    const list: number[] = [];
    const a = state.land[l];
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - m[l][i]) > 1e-6) list.push(i, Math.round(a[i] * 1000) / 1000);
    out[l] = list;
  }
  return out;
}

export function unpackLand(seed: number, packed: Partial<Record<LandLayer, number[]>>): Land {
  const land = initLand(seed);
  for (const l of LAYERS) {
    const list = packed[l] ?? [];
    for (let k = 0; k + 1 < list.length; k += 2) if (list[k] >= 0 && list[k] < land[l].length) land[l][list[k]] = list[k + 1];
  }
  return land;
}
