import { BUILDABLE, BUILDING_DEFS, JOB_DEFS, MAP_H, MAP_W, OPEN_LAND, RESOURCE_DEFS } from './data';
import { getMap, idx, inBounds, tx, ty } from './map';
import { fxMul } from './decisions';
import { eraOf, hasTech } from './state';
import type { Building, BuildingId, GameState, JobId, ResourceId, Resources } from './types';
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
}

const memo = new WeakMap<GameState, { key: string; d: Derived }>();

function keyOf(state: GameState) {
  let done = 0;
  for (const b of state.buildings) if (b.done) done++;
  return `${state.buildings.length}:${done}:${state.techs.length}:${state.claimed.length}:${state.nextBuildingId}:${Object.values(state.decisions).join()}`;
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

  for (const b of state.buildings) {
    if (!b.done) {
      sites.push(b);
      continue;
    }
    const def = BUILDING_DEFS[b.type];
    counts[b.type] = (counts[b.type] ?? 0) + 1;
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
    for (const [job, n] of Object.entries(def.slots ?? {})) {
      slotGroups[job as JobId].push({ mult: buildingMult(state, b), count: n!, building: b.id });
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

  return { territory, housing, stoneHousing, caps, slots, slotGroups, counts, sites };
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

/** Output multiplier a building gives its workers, from terrain adjacency. */
export function buildingMult(state: GameState, b: { type: BuildingId; x: number; y: number }): number {
  const map = getMap(state.seed);
  const here = idx(b.x, b.y);
  switch (b.type) {
    case 'lumber': {
      const n = countAround(state, b.x, b.y, (t) => t === T.Forest || t === T.Dense);
      return 1 + 0.15 * n;
    }
    case 'lodge': {
      const forest = countAround(state, b.x, b.y, (t) => t === T.Forest || t === T.Dense);
      const game = countAround(state, b.x, b.y, (_t, f, i) => f === F.Game && state.explored[i] === 1, 3);
      return Math.min(2, 1 + 0.06 * forest + 0.3 * game);
    }
    case 'quarry': {
      const n = countAround(state, b.x, b.y, (t) => t === T.Hills || t === T.Mountain || t === T.Peak);
      return 1 + 0.1 * n + (map.terrain[here] === T.Hills ? 0.2 : 0);
    }
    case 'farm': {
      const water = countAround(state, b.x, b.y, (t) => t === T.River || t === T.Water) > 0;
      return 1 + (water ? 0.3 : 0) + (map.terrain[here] === T.Meadow ? 0.1 : 0);
    }
    case 'mine': {
      const onOre = map.feature[here] === F.Ore;
      const nearOre = countAround(state, b.x, b.y, (_t, f) => f === F.Ore) > 0;
      return onOre ? 2 : nearOre ? 1.4 : 1;
    }
    default:
      return 1;
  }
}

export type PlaceCheck = { ok: true; mult: number } | { ok: false; reason: string };

export function canPlace(state: GameState, type: BuildingId, tile: number): PlaceCheck {
  const map = getMap(state.seed);
  const def = BUILDING_DEFS[type];
  const d = derived(state);
  if (!state.explored[tile]) return { ok: false, reason: 'Unexplored' };
  if (!d.territory[tile]) return { ok: false, reason: 'Outside your territory' };
  if (state.buildings.some((b) => idx(b.x, b.y) === tile)) return { ok: false, reason: 'Occupied' };
  const t = map.terrain[tile] as T;
  const f = map.feature[tile] as F;
  if (f === F.Ruins || f === F.Grove) return { ok: false, reason: 'Sacred ground' };
  const x = tx(tile);
  const y = ty(tile);
  const nearMountain = countAround(state, x, y, (tt) => tt === T.Mountain || tt === T.Peak) > 0;
  let ok: boolean;
  switch (def.rule) {
    case 'open':
      ok = OPEN_LAND.has(t) && t !== T.Sand;
      if (!ok) return { ok: false, reason: 'Needs open grassland' };
      break;
    case 'quarry':
      ok = t === T.Hills || (BUILDABLE.has(t) && t !== T.Dense && nearMountain);
      if (!ok) return { ok: false, reason: 'Needs hills or a mountainside' };
      break;
    case 'mine':
      ok = t === T.Hills || (t === T.Mountain && countAround(state, x, y, (tt) => BUILDABLE.has(tt)) > 0) || (BUILDABLE.has(t) && t !== T.Dense && nearMountain);
      if (!ok) return { ok: false, reason: 'Needs hills or a mountainside' };
      break;
    case 'any-land-forest':
      ok = BUILDABLE.has(t);
      if (!ok) return { ok: false, reason: 'Needs land' };
      break;
    default:
      ok = BUILDABLE.has(t) && t !== T.Dense;
      if (!ok) return { ok: false, reason: t === T.Dense ? 'Old forest is too thick' : 'Needs dry land' };
  }
  return { ok: true, mult: buildingMult(state, { type, x, y }) };
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
