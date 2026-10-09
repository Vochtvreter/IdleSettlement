/**
 * The living land: what each tile still holds (timber, stone, ore and wildlife), how it is used up
 * and how it grows back, the ground buildings stand on and how a site is prepared, plus the roads,
 * trails and bridges that tie the settlements together.
 * Everything here is deterministic so it runs the same offline.
 */
import { BUILDABLE, BUILDING_DEFS, FELL_WORK, LEVEL_STONE, LEVEL_WORK, MAP_H, MAP_W } from './data';
import { derived } from './derived';
import { getMap, idx, inBounds, isWater, N4, tx, ty, type WorldMap } from './map';
import type { Building, BuildingId, GameState, Land, LandLayer, Settlement } from './types';
import { Biome, F, T } from './types';

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

/** Timber in a stand of forest and old forest, by climate. */
const TIMBER: Record<Biome, [number, number]> = {
  [Biome.Temperate]: [60, 100],
  [Biome.Boreal]: [55, 90],
  [Biome.Arid]: [40, 70],
  [Biome.Tropical]: [80, 130],
};

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
    const b = map.biome[i] as Biome;
    if (t === T.Forest) m.wood[i] = TIMBER[b][0];
    if (t === T.Dense) m.wood[i] = TIMBER[b][1];
    if (m.wood[i]) m.forestTiles.push(i);
    if (t === T.Hills) m.stone[i] = 240;
    if (t === T.Mountain) m.stone[i] = 480;
    if (t === T.Peak) m.stone[i] = 300;
    // The dry hills of the south are rich in ore.
    const rich = b === Biome.Arid ? 1.5 : 1;
    if (t === T.Hills) m.ore[i] = 60 * rich;
    if (t === T.Mountain) m.ore[i] = 250 * rich;
    if (t === T.Peak) m.ore[i] = 150 * rich;
    if (f === F.Ore) m.ore[i] = 1000;
    if (f === F.Game) m.life[i] = b === Biome.Boreal ? 130 : b === Biome.Arid ? 70 : 100;
    if (f === F.Fish) m.life[i] = b === Biome.Arid ? 50 : 70;
    if (f === F.Berries) m.life[i] = b === Biome.Tropical ? 60 : 40;
    if (m.life[i]) m.lifeTiles.push(i);
  }
  if (maxCache.size >= 6) maxCache.delete(maxCache.keys().next().value!);
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

// ------------------------------------------------------------------ settlements

/** Every settlement's hearth. */
export function hearths(state: GameState): Building[] {
  return state.buildings.filter((b) => b.type === 'campfire');
}

/** The capital, where the realm began. */
export function capital(state: GameState): Settlement {
  return state.towns[0];
}

export function townById(state: GameState, id: number | undefined): Settlement | undefined {
  return state.towns.find((t) => t.id === id);
}

/** A settlement's hearth (the capital's when none is given). */
export function hearthOf(state: GameState, town?: number): Building {
  const id = town ?? state.towns[0]?.id;
  for (const b of state.buildings) if (b.type === 'campfire' && (b.town ?? state.towns[0]?.id) === id) return b;
  return state.buildings.find((b) => b.type === 'campfire') ?? state.buildings[0];
}

/** The open village green around a hearth: never built on, always part of the road network. */
export function isGreen(state: GameState, i: number) {
  const x = tx(i);
  const y = ty(i);
  for (const h of state.buildings) {
    if (h.type !== 'campfire') continue;
    if (Math.max(Math.abs(x - h.x), Math.abs(y - h.y)) <= 1) return !blocked(getMap(state.seed), i);
  }
  return false;
}

/**
 * Four ways lead out of each green, straight along the compass lines from the hearth. They are kept
 * clear of buildings so homes can never wall a hearth in, and roads like to follow them.
 */
export function isStreet(state: GameState, i: number) {
  const x = tx(i);
  const y = ty(i);
  for (const h of state.buildings) {
    if (h.type !== 'campfire') continue;
    const dx = Math.abs(x - h.x);
    const dy = Math.abs(y - h.y);
    if ((dx === 0 || dy === 0) && dx + dy >= 2 && dx + dy <= 6) return !blocked(getMap(state.seed), i);
  }
  return false;
}

// ------------------------------------------------------------------ footprints

/** A building type's footprint in tiles, [width, height]. */
export function sizeOf(type: BuildingId): [number, number] {
  return BUILDING_DEFS[type].size ?? [1, 1];
}

/** The tiles a building of this type would cover with its top-left corner at x, y (null if off the map). */
export function footprint(type: BuildingId, x: number, y: number): number[] | null {
  const [w, h] = sizeOf(type);
  if (!inBounds(x, y) || !inBounds(x + w - 1, y + h - 1)) return null;
  const out: number[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) out.push(idx(x + dx, y + dy));
  return out;
}

export function tilesOf(b: { type: BuildingId; x: number; y: number }): number[] {
  return footprint(b.type, b.x, b.y) ?? [idx(b.x, b.y)];
}

/** Centre of a building in tile coordinates (a tile's own centre is its x, y). */
export function centerOf(b: { type: BuildingId; x: number; y: number }): [number, number] {
  const [w, h] = sizeOf(b.type);
  return [b.x + (w - 1) / 2, b.y + (h - 1) / 2];
}

/** The ring of tiles around a footprint, clockwise from the top-left corner (may run off the map). */
export function ringOf(x: number, y: number, w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = -1; k < w; k++) out.push([x + k, y - 1]);
  for (let k = -1; k < h; k++) out.push([x + w, y + k]);
  for (let k = w; k > -1; k--) out.push([x + k, y + h]);
  for (let k = h; k > -1; k--) out.push([x - 1, y + k]);
  return out;
}

/** Whether a ring cell is a corner (touches the footprint only diagonally). */
export function ringCorner(x: number, y: number, w: number, h: number, cx: number, cy: number) {
  return (cx === x - 1 || cx === x + w) && (cy === y - 1 || cy === y + h);
}

// ------------------------------------------------------------------ ground

/** Terrain nobody can walk across: water, mountains and peaks. */
export function blocked(map: WorldMap, i: number) {
  const t = map.terrain[i];
  return isWater(t) || t === T.Mountain || t === T.Peak;
}

/** Land a building could stand on, ignoring what else is there. */
export function dryLand(map: WorldMap, i: number) {
  return BUILDABLE.has(map.terrain[i] as T);
}

const gradedMemo = new WeakMap<GameState, { n: number; set: Set<number> }>();

/** Rocky tiles that have been levelled for building. */
export function gradedSet(state: GameState): Set<number> {
  let m = gradedMemo.get(state);
  if (!m || m.n !== state.graded.length) {
    m = { n: state.graded.length, set: new Set(state.graded) };
    gradedMemo.set(state, m);
  }
  return m.set;
}

/** Terrain as it stands now: levelled rock counts as open ground. */
export function terrainAt(state: GameState, i: number): T {
  const t = getMap(state.seed).terrain[i] as T;
  if ((t === T.Mountain || t === T.Hills) && gradedSet(state).has(i)) return T.Grass;
  return t;
}

// ------------------------------------------------------------------ site preparation

export interface PrepNeed {
  /** Work to fell the standing timber. */
  fell: number;
  /** Work to level the rock. */
  level: number;
  /** Stone the levelling turns up. */
  stone: number;
  /** Timber that felling brings in. */
  wood: number;
}

/** What it would take to clear and level a footprint before building can begin. */
export function prepNeeded(state: GameState, type: BuildingId, x: number, y: number): PrepNeed {
  const out: PrepNeed = { fell: 0, level: 0, stone: 0, wood: 0 };
  if (type === 'bridge' || type === 'campfire') return out;
  for (const i of footprint(type, x, y) ?? []) {
    const w = state.land.wood[i];
    out.wood += w;
    out.fell += w * FELL_WORK;
    const t = terrainAt(state, i);
    out.level += LEVEL_WORK[t] ?? 0;
    out.stone += LEVEL_STONE[t] ?? 0;
  }
  return out;
}

/** Felling still to do on a site: whatever timber stands on it. */
export function fellLeft(state: GameState, b: Building) {
  if (b.done) return 0;
  let w = 0;
  for (const i of tilesOf(b)) w += state.land.wood[i];
  return w * FELL_WORK;
}

/** What a site is waiting for: its trees felled, its rock levelled, or the building itself. */
export function siteStage(state: GameState, b: Building): 'felling' | 'levelling' | 'building' | 'done' {
  if (b.done) return 'done';
  if (fellLeft(state, b) > 1e-6) return 'felling';
  if ((b.prep ?? 0) > 1e-6) return 'levelling';
  return 'building';
}

/**
 * Put work into preparing a site: the trees come down first (their timber goes to the stores), then
 * the rock is levelled (turning up stone). Returns the work used and what it brought in.
 */
export function prepareSite(state: GameState, b: Building, work: number): { used: number; wood: number; stone: number } {
  let left = work;
  let wood = 0;
  let stone = 0;
  const tiles = tilesOf(b);
  for (const i of tiles) {
    if (left <= 1e-9) break;
    const w = state.land.wood[i];
    if (w <= 0) continue;
    const take = Math.min(w, left / FELL_WORK);
    setStock(state, 'wood', i, w - take);
    wood += take;
    left -= take * FELL_WORK;
  }
  if (left > 1e-9 && (b.prep ?? 0) > 0 && fellLeft(state, b) <= 1e-6) {
    let total = 0;
    let rock = 0;
    for (const i of tiles) {
      const t = terrainAt(state, i);
      total += LEVEL_WORK[t] ?? 0;
      rock += LEVEL_STONE[t] ?? 0;
    }
    const use = Math.min(left, b.prep!);
    b.prep! -= use;
    left -= use;
    stone += total > 0 ? (use / total) * rock : 0;
    if (b.prep! <= 1e-6) {
      b.prep = 0;
      for (const i of tiles) {
        const t = getMap(state.seed).terrain[i];
        if ((t === T.Mountain || t === T.Hills) && !gradedSet(state).has(i)) state.graded.push(i);
      }
      state.landEpoch++;
    }
  }
  if (wood || stone) {
    const caps = derived(state).caps;
    state.res.wood = Math.max(state.res.wood, Math.min(caps.wood, state.res.wood + wood));
    state.res.stone = Math.max(state.res.stone, Math.min(caps.stone, state.res.stone + stone));
  }
  return { used: work - left, wood, stone };
}

// ------------------------------------------------------------------ catchments

/** Where a building's workers take their resource from, nearest (or richest) first. */
export function catchmentAt(state: GameState, type: BuildingId, bx: number, by: number, layer: LandLayer): number[] {
  const m = landMax(state.seed);
  const map = getMap(state.seed);
  const [w, h] = sizeOf(type);
  const x = Math.round(bx + (w - 1) / 2);
  const y = Math.round(by + (h - 1) / 2);
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
  if (square) {
    // The footprint and the ring around it, richest (ore) or nearest first.
    for (let yy = by - 1; yy <= by + h; yy++)
      for (let xx = bx - 1; xx <= bx + w; xx++) {
        if (!inBounds(xx, yy)) continue;
        const i = idx(xx, yy);
        if (!m[layer][i]) continue;
        const d = Math.hypot(xx - (bx + (w - 1) / 2), yy - (by + (h - 1) / 2));
        out.push([i, layer === 'ore' ? -m.ore[i] + d * 0.01 : d]);
      }
    out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return out.map((o) => o[0]);
  }
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      const d = Math.hypot(dx, dy);
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
export function growLand(
  state: GameState,
  season: number,
  opts: { replant: Uint8Array; occupied: Uint8Array; sites: Uint8Array; trail: Uint8Array; regrow: number; replanting: boolean },
) {
  const m = landMax(state.seed);
  const map = getMap(state.seed);
  const wood = state.land.wood;
  const winter = season === 3 ? 0.25 : 1;
  for (const i of m.forestTiles) {
    const max = m.wood[i];
    const v = wood[i];
    if (opts.occupied[i]) {
      // Trees on a building site stand until the builders fell them; elsewhere they are gone for good.
      if (v && !opts.sites[i]) setStock(state, 'wood', i, 0);
      continue;
    }
    // Trails are kept open: the woods along them never close in again.
    const cap = opts.trail[i] ? max * TRAIL_WOOD : max;
    if (v >= cap) continue;
    let rate = 0;
    if (opts.replanting && opts.replant[i]) rate = 0.3;
    else if (v > 0 || seedsNearby(state, i)) rate = 0.05;
    if (!rate) continue;
    const b = map.biome[i];
    const climate = b === Biome.Tropical ? 1.5 : b === Biome.Boreal ? 0.7 : 1;
    setStock(state, 'wood', i, Math.min(cap, v + rate * max * 0.025 * winter * opts.regrow * climate));
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

/**
 * Where people can walk: dry land, rivers where a bridge stands or a trail fords them, mountain
 * passes where a trail climbs over, and levelled rock.
 */
export function passableMask(state: GameState): Uint8Array {
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  const pass = new Uint8Array(n);
  for (let i = 0; i < n; i++) pass[i] = blocked(map, i) ? 0 : 1;
  for (const b of state.buildings) if (b.type === 'bridge' && b.done) pass[idx(b.x, b.y)] = 1;
  for (const i of state.trails) pass[i] = 1;
  for (const i of state.graded) pass[i] = 1;
  return pass;
}

/** Tiles people can walk to from any of the realm's hearths. */
export function computeReach(state: GameState, pass = passableMask(state)): Uint8Array {
  const n = MAP_W * MAP_H;
  const reach = new Uint8Array(n);
  const queue: number[] = [];
  for (const h of hearths(state)) {
    const start = idx(h.x, h.y);
    if (!reach[start]) (reach[start] = 1), queue.push(start);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (reach[j] || !pass[j]) continue;
      reach[j] = 1;
      queue.push(j);
    }
  }
  return reach;
}

// ------------------------------------------------------------------ roads and trails

/** Share of its timber a forest tile keeps where a trail runs through it. */
export const TRAIL_WOOD = 0.45;

/** Tiles that already carry the network: the greens, roads, trails and bridges. */
export function networkMask(state: GameState): Uint8Array {
  const n = MAP_W * MAP_H;
  const map = getMap(state.seed);
  const net = new Uint8Array(n);
  for (const i of state.roads) net[i] = 1;
  for (const i of state.trails) net[i] = 1;
  for (const h of hearths(state))
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!inBounds(h.x + dx, h.y + dy)) continue;
        const i = idx(h.x + dx, h.y + dy);
        if (!blocked(map, i)) net[i] = 1;
      }
  for (const b of state.buildings) if (b.type === 'bridge' || b.type === 'campfire') net[idx(b.x, b.y)] = 1;
  return net;
}

/** Tiles covered by buildings other than bridges and hearths. */
export function takenMask(state: GameState): Uint8Array {
  const taken = new Uint8Array(MAP_W * MAP_H);
  for (const b of state.buildings) if (b.type !== 'bridge' && b.type !== 'campfire') for (const i of tilesOf(b)) taken[i] = 1;
  return taken;
}

export class Heap {
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
 * The cheapest way from a building's tiles to the network, avoiding buildings, water and rock and
 * preferring open ground to forest. Returns the new road tiles (not including the start), or null if cut off.
 */
export function roadPath(state: GameState, fromTiles: number | number[]): number[] | null {
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  const net = networkMask(state);
  const taken = takenMask(state);
  const froms = Array.isArray(fromTiles) ? fromTiles : [fromTiles];
  const own = new Set(froms);
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  for (const f of froms) {
    dist[f] = 0;
    heap.push(f, 0);
  }
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
    if (!own.has(i) && net[i]) {
      const path: number[] = [];
      for (let k = prev[i]; k >= 0 && !own.has(k); k = prev[k]) path.push(k);
      return path.reverse();
    }
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (taken[j] || own.has(j)) continue;
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

/** Lay a road: the trees along it are felled and the ground is kept clear for good. A trail it follows becomes road. */
export function layRoad(state: GameState, tiles: number[]) {
  if (!tiles.length) return;
  const have = new Set(state.roads);
  const paved = new Set<number>();
  for (const i of tiles) {
    if (have.has(i)) continue;
    have.add(i);
    paved.add(i);
    state.roads.push(i);
    clearTile(state, i);
  }
  if (paved.size) state.trails = state.trails.filter((i) => !paved.has(i));
  state.landEpoch++;
}

/**
 * Blaze a trail: a rough path trodden through the woods, over hills and mountain passes and across
 * fords. The trees along it are thinned (not felled for timber) and it is never built on.
 */
export function layTrail(state: GameState, tiles: number[]) {
  const map = getMap(state.seed);
  const have = new Set(state.trails);
  const roads = new Set(state.roads);
  const taken = takenMask(state);
  let added = 0;
  for (const i of tiles) {
    const t = map.terrain[i];
    if (have.has(i) || roads.has(i) || taken[i] || t === T.Water || t === T.Deep || t === T.Peak || isGreen(state, i)) continue;
    have.add(i);
    state.trails.push(i);
    added++;
    const max = landMax(state.seed).wood[i];
    if (max && state.land.wood[i] > max * TRAIL_WOOD) setStock(state, 'wood', i, max * TRAIL_WOOD);
  }
  if (added) state.landEpoch++;
  return added;
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
