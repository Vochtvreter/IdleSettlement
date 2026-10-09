import { BUILDING_DEFS, JOB_DEFS, MAP_H, MAP_W, RESOURCE_DEFS } from './data';
import { getMap, idx, inBounds, isWater, N4, tx, ty } from './map';
import { fxMul } from './decisions';
import { blocked, catchmentAt, computeReach, dryLand, hearthOf, isStreet, landMax, layerSum, wooded } from './land';
import { eraOf, hasTech } from './state';
import type { Building, BuildingId, GameState, JobId, LandLayer, ResourceId, Resources } from './types';
import { F, JOBS, RESOURCES, T } from './types';

export interface SlotGroup {
  mult: number;
  count: number;
  building: number | null;
}

export interface Derived {
  territory: Uint8Array;
  housing: number;
  stoneHousing: number;
  caps: Resources;
  slots: Record<JobId, number>;
  slotGroups: Record<JobId, SlotGroup[]>;
  counts: Partial<Record<BuildingId, number>>;
  sites: Building[];
  /** Tiles people can walk to from the hearth. */
  reach: Uint8Array;
  /** Tiles taken by buildings, roads and the village green. */
  occupied: Uint8Array;
  /** Id of the building on each tile (0 for none). */
  buildingAt: Int32Array;
  /** Road network tiles: roads, the green and bridges. */
  network: Uint8Array;
  /** Open ground a new road could be laid across to reach the network. */
  roadable: Uint8Array;
  /** Forest that a lumber camp replants. */
  replant: Uint8Array;
  /** Where each building's workers draw a resource from, keyed by building id. */
  catchments: Record<LandLayer, Map<number, number[]>>;
  /** Quarries and mines with nothing left to dig. */
  spent: Set<number>;
}

const memo = new WeakMap<GameState, { key: string; d: Derived }>();

function keyOf(state: GameState) {
  let done = 0;
  for (const b of state.buildings) if (b.done) done++;
  return `${state.buildings.length}:${done}:${state.techs.length}:${state.claimed.length}:${state.nextBuildingId}:${state.landEpoch}:${state.roads.length}:${Object.values(state.decisions).join()}`;
}

/** Values that only change when buildings, techs or discoveries change. Memoised per state. */
export function derived(state: GameState): Derived {
  const key = keyOf(state);
  const m = memo.get(state);
  if (m && m.key === key) return m.d;
  const d = compute(state);
  memo.set(state, { key, d });
  return d;
}

export function invalidate(state: GameState) {
  memo.delete(state);
}

export function jobUnlocked(state: GameState, j: JobId) {
  const t = JOB_DEFS[j].tech;
  return !t || hasTech(state, t);
}

function compute(state: GameState): Derived {
  const territory = new Uint8Array(MAP_W * MAP_H);
  let housing = 0;
  let stoneHousing = 0;
  const caps = Object.fromEntries(RESOURCES.map((r) => [r, RESOURCE_DEFS[r].baseCap])) as Resources;
  const slotGroups = Object.fromEntries(JOBS.map((j) => [j, [] as SlotGroup[]])) as Record<JobId, SlotGroup[]>;
  const counts: Partial<Record<BuildingId, number>> = {};
  const sites: Building[] = [];
  const n = MAP_W * MAP_H;
  const occupied = new Uint8Array(n);
  const buildingAt = new Int32Array(n);
  const network = new Uint8Array(n);
  const replant = new Uint8Array(n);
  const catchments = { wood: new Map(), stone: new Map(), ore: new Map(), life: new Map() } as Derived['catchments'];
  const spent = new Set<number>();
  const map = getMap(state.seed);
  const hearth = hearthOf(state);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!inBounds(hearth.x + dx, hearth.y + dy)) continue;
      const i = idx(hearth.x + dx, hearth.y + dy);
      if (!blocked(map, i)) occupied[i] = network[i] = 1;
    }
  for (const i of state.roads) occupied[i] = network[i] = 1;

  for (const b of state.buildings) {
    const at = idx(b.x, b.y);
    occupied[at] = 1;
    buildingAt[at] = b.id;
    if (b.type === 'bridge' || b.type === 'campfire') network[at] = 1;
    if (!b.done) {
      sites.push(b);
      continue;
    }
    const def = BUILDING_DEFS[b.type];
    counts[b.type] = (counts[b.type] ?? 0) + 1;
    for (const layer of ['wood', 'stone', 'ore', 'life'] as LandLayer[]) {
      const tiles = catchmentAt(state, b.type, b.x, b.y, layer);
      if (tiles.length) catchments[layer].set(b.id, tiles);
    }
    if (b.type === 'lumber') for (const i of catchments.wood.get(b.id) ?? []) replant[i] = 1;
    if ((b.type === 'quarry' && layerSum(state, 'stone', catchments.stone.get(b.id) ?? []) < 0.5) || (b.type === 'mine' && layerSum(state, 'ore', catchments.ore.get(b.id) ?? []) < 0.5)) spent.add(b.id);
    // The hearth's reach grows with every age the settlement enters.
    const r = b.type === 'campfire' ? def.territory + 2 * eraOf(state) : def.territory;
    for (let y = b.y - r; y <= b.y + r; y++)
      for (let x = b.x - r; x <= b.x + r; x++) {
        if (!inBounds(x, y)) continue;
        if (Math.hypot(x - b.x, y - b.y) <= r + 0.5) territory[idx(x, y)] = 1;
      }
    housing += def.housing ?? 0;
    if (b.type === 'house') stoneHousing += def.housing ?? 0;
    for (const [res, amt] of Object.entries(def.storage ?? {})) caps[res as ResourceId] += amt!;
    if (!spent.has(b.id))
      for (const [job, k] of Object.entries(def.slots ?? {})) {
        slotGroups[job as JobId].push({ mult: buildingMult(state, b), count: k!, building: b.id });
      }
  }

  // Decision effects on storage.
  const store = fxMul(state, 'storage');
  for (const r of RESOURCES) if (isFinite(caps[r])) caps[r] = Math.round(caps[r] * store);
  caps.food = Math.round(caps.food * fxMul(state, 'foodStore'));

  const slots = {} as Record<JobId, number>;
  for (const j of JOBS) {
    slotGroups[j].sort((a, b) => b.mult - a.mult);
    slots[j] = slotGroups[j].reduce((s, g) => s + g.count, 0);
  }
  slots.gatherer = Infinity;
  slots.builder = Infinity;
  for (const j of JOBS) if (!jobUnlocked(state, j)) slots[j] = 0;

  const reach = computeReach(state);
  const roadable = roadableFrom(state, network);
  return { territory, housing, stoneHousing, caps, slots, slotGroups, counts, sites, reach, occupied, buildingAt, network, roadable, replant, catchments, spent };
}

/** Flood out from the road network over ground a road may cross (not buildings, water, rock or sacred sites). */
function roadableFrom(state: GameState, network: Uint8Array): Uint8Array {
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  const taken = new Uint8Array(n);
  for (const b of state.buildings) if (b.type !== 'bridge' && b.type !== 'campfire') taken[idx(b.x, b.y)] = 1;
  const out = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (network[i]) (out[i] = 1), queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (out[j] || taken[j] || blocked(map, j) || map.feature[j] === F.Ruins || map.feature[j] === F.Grove) continue;
      out[j] = 1;
      queue.push(j);
    }
  }
  return out;
}

function countAround(state: GameState, x: number, y: number, pred: (t: number, f: number, i: number) => boolean, r = 1) {
  const map = getMap(state.seed);
  let n = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy) continue;
      if (!inBounds(x + dx, y + dy)) continue;
      const i = idx(x + dx, y + dy);
      if (pred(map.terrain[i], map.feature[i], i)) n++;
    }
  return n;
}

/** Output multiplier a building gives its workers, from what the land around it still holds. */
export function buildingMult(state: GameState, b: { type: BuildingId; x: number; y: number }): number {
  const map = getMap(state.seed);
  const here = idx(b.x, b.y);
  switch (b.type) {
    case 'lumber': {
      const n = countAround(state, b.x, b.y, (_t, _f, i) => wooded(state, i));
      return 1 + 0.15 * n;
    }
    case 'lodge': {
      const forest = countAround(state, b.x, b.y, (_t, _f, i) => wooded(state, i));
      const game = countAround(state, b.x, b.y, (_t, f, i) => f === F.Game && state.explored[i] === 1 && state.land.life[i] >= 5, 3);
      return Math.min(2, 1 + 0.06 * forest + 0.3 * game);
    }
    case 'quarry': {
      const n = countAround(state, b.x, b.y, (t, _f, i) => (t === T.Hills || t === T.Mountain || t === T.Peak) && state.land.stone[i] > 0);
      return 1 + 0.1 * n + (map.terrain[here] === T.Hills && state.land.stone[here] > 0 ? 0.2 : 0);
    }
    case 'farm': {
      const water = countAround(state, b.x, b.y, (t) => t === T.River || t === T.Water) > 0;
      return 1 + (water ? 0.3 : 0) + (map.terrain[here] === T.Meadow ? 0.1 : 0);
    }
    case 'mine': {
      const vein = (i: number) => map.feature[i] === F.Ore && state.land.ore[i] > 0;
      return vein(here) || countAround(state, b.x, b.y, (_t, _f, i) => vein(i)) > 0 ? 2 : 1;
    }
    default:
      return 1;
  }
}

export type PlaceCheck = { ok: true; mult: number } | { ok: false; reason: string };

/** Whether a tile is free to build on: no trees, water, rock, road or other building, and reachable on foot. */
export function canPlace(state: GameState, type: BuildingId, tile: number, d: Derived = derived(state)): PlaceCheck {
  const map = getMap(state.seed);
  const def = BUILDING_DEFS[type];
  if (!state.explored[tile]) return { ok: false, reason: 'Unexplored' };
  if (!d.territory[tile]) return { ok: false, reason: 'Outside your territory' };
  if (d.buildingAt[tile]) return { ok: false, reason: 'Occupied' };
  if (d.occupied[tile]) return { ok: false, reason: d.network[tile] && !state.roads.includes(tile) ? 'The village green is kept open' : 'A road runs here' };
  const t = map.terrain[tile] as T;
  const f = map.feature[tile] as F;
  const x = tx(tile);
  const y = ty(tile);
  if (def.rule === 'bridge') {
    if (t !== T.River) return { ok: false, reason: 'Bridges span rivers' };
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy) || !inBounds(x - dx, y - dy)) continue;
      const near = idx(x + dx, y + dy);
      const far = idx(x - dx, y - dy);
      const nearOk = (d.reach[near] && d.roadable[near] && !d.occupied[near]) || (d.network[near] && (d.reach[near] || state.buildings.some((b) => b.id === d.buildingAt[near] && b.type === 'bridge')));
      const farT = map.terrain[far];
      if (nearOk && (dryLand(map, far) || farT === T.River)) return { ok: true, mult: 1 };
    }
    return { ok: false, reason: 'Needs land you can reach on one bank' };
  }
  if (isWater(t)) return { ok: false, reason: 'Water' };
  if (t === T.Mountain || t === T.Peak) return { ok: false, reason: 'Too steep to build on' };
  if (f === F.Ruins || f === F.Grove) return { ok: false, reason: 'Sacred ground' };
  if (f === F.Berries && state.land.life[tile] > 0) return { ok: false, reason: 'A berry thicket grows here' };
  if (f === F.Ore && type !== 'mine') return { ok: false, reason: 'An ore vein: keep it for a mine' };
  if (wooded(state, tile)) return { ok: false, reason: 'Trees stand here: fell them first' };
  if (isStreet(state, tile)) return { ok: false, reason: 'Kept clear as a way out of the green' };
  if (!d.reach[tile]) return { ok: false, reason: 'Across the river: build a bridge' };
  let access = false;
  for (const [dx, dy] of N4) {
    if (!inBounds(x + dx, y + dy)) continue;
    const j = idx(x + dx, y + dy);
    if (d.roadable[j] && !(d.occupied[j] && !d.network[j])) access = true;
  }
  if (!access) return { ok: false, reason: 'Boxed in: no road can reach it' };
  if (cutsThrough(state, d, x, y)) return { ok: false, reason: 'It would block the way through' };
  const steepNear = countAround(state, x, y, (tt) => tt === T.Mountain || tt === T.Peak) > 0;
  const forest = landMax(state.seed).wood[tile] > 0;
  switch (def.rule) {
    case 'open':
      if (!(t === T.Grass || t === T.Meadow || forest)) return { ok: false, reason: 'Needs open grassland' };
      break;
    case 'quarry':
      if (!(t === T.Hills || steepNear || countAround(state, x, y, (tt) => tt === T.Hills) > 0)) return { ok: false, reason: 'Needs hills or a mountainside' };
      break;
    case 'mine':
      if (!(t === T.Hills || steepNear)) return { ok: false, reason: 'Needs hills or a mountainside' };
      break;
    case 'forest-edge':
      if (!countAround(state, x, y, (_tt, _f, i) => wooded(state, i))) return { ok: false, reason: 'Needs standing forest beside it' };
      break;
    default:
      if (!dryLand(map, tile)) return { ok: false, reason: 'Needs dry land' };
  }
  return { ok: true, mult: buildingMult(state, { type, x, y }) };
}

/**
 * Whether a building here would split the open ground around it in two, closing off a lane or a pass.
 * Looks at the ring of eight neighbours: the open sides must all stay joined around the ring.
 */
function cutsThrough(state: GameState, d: Derived, x: number, y: number) {
  const map = getMap(state.seed);
  const open = (dx: number, dy: number) => {
    if (!inBounds(x + dx, y + dy)) return false;
    const j = idx(x + dx, y + dy);
    return !blocked(map, j) && !(d.occupied[j] && !d.network[j]);
  };
  const ring: [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const o = ring.map(([dx, dy]) => open(dx, dy));
  // Count runs of open orthogonal sides, joined around a corner only through an open diagonal.
  let sides = 0;
  let runs = 0;
  for (let k = 0; k < 8; k += 2) {
    if (!o[k]) continue;
    sides++;
    const prev = (k + 6) % 8;
    if (!(o[prev] && o[(k + 7) % 8])) runs++;
  }
  if (sides === 4 && o[1] && o[3] && o[5] && o[7]) return false;
  return runs > 1;
}

export function canAfford(state: GameState, cost: Partial<Resources>) {
  return Object.entries(cost).every(([r, n]) => state.res[r as ResourceId] >= (n ?? 0));
}

export function pay(state: GameState, cost: Partial<Resources>) {
  for (const [r, n] of Object.entries(cost)) state.res[r as ResourceId] -= n ?? 0;
}

export function refund(state: GameState, cost: Partial<Resources>, frac = 1) {
  const caps = derived(state).caps;
  for (const [r, n] of Object.entries(cost)) {
    const k = r as ResourceId;
    state.res[k] = Math.min(caps[k], state.res[k] + (n ?? 0) * frac);
  }
}

export function buildingCount(state: GameState, type: BuildingId, includeSites = true) {
  return state.buildings.filter((b) => b.type === type && (includeSites || b.done)).length;
}
