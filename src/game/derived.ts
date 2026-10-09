import { BIOMES, BUILDING_DEFS, JOB_DEFS, MAP_H, MAP_W, RESOURCE_DEFS, TIERS } from './data';
import { getMap, idx, inBounds, isSea, N4, tx, ty } from './map';
import { fxMul } from './decisions';
import {
  blocked,
  catchmentAt,
  centerOf,
  computeReach,
  footprint,
  hearths,
  isStreet,
  landMax,
  layerSum,
  networkMask,
  passableMask,
  ringOffsets,
  sizeOf,
  takenMask,
  terrainAt,
  tilesOf,
  wooded,
  workArea,
} from './land';
import { ADULT_AGE, DAYS_PER_YEAR, ELDER_AGE } from './data';
import { eraOf, hasTech } from './state';
import type { Building, BuildingId, GameState, JobId, LandLayer, ResourceId, Resources } from './types';
import { Biome, F, JOBS, RESOURCES, T } from './types';

export interface SlotGroup {
  mult: number;
  count: number;
  building: number | null;
  town: number;
}

/** How a settlement's goods reach the rest of the realm. */
export type Link = 'capital' | 'road' | 'route' | 'trail' | 'none';

/** Share of a settlement's output that reaches the realm's stores, by how it is linked to the capital. */
export const HAUL: Record<Link, number> = { capital: 1, road: 1, route: 1, trail: 0.85, none: 0.5 };

/** What a settlement lives by, judged from its workplaces. */
export type Specialty = 'farming' | 'herding' | 'timber' | 'hunting' | 'mining' | 'quarrying' | 'port' | 'crafts' | 'learning' | 'temple';

export const SPECIALTY_NAMES: Record<Specialty, string> = {
  farming: 'Farming',
  herding: 'Herding',
  timber: 'Timber',
  hunting: 'Hunting',
  mining: 'Mining',
  quarrying: 'Quarry',
  port: 'Harbour',
  crafts: 'Craft',
  learning: 'Scholars’',
  temple: 'Temple',
};

/** What each workplace says about a settlement's trade. Fields are everywhere, so they count for less. */
const SPECIALTY_OF: Partial<Record<BuildingId, [Specialty, number]>> = {
  farm: ['farming', 0.55],
  granary: ['farming', 0.25],
  pasture: ['herding', 1.3],
  lumber: ['timber', 1.2],
  lodge: ['hunting', 1.3],
  mine: ['mining', 1.8],
  quarry: ['quarrying', 1.2],
  harbour: ['port', 2.5],
  smithy: ['crafts', 1.3],
  library: ['learning', 1.2],
  shrine: ['temple', 1],
};

export interface TownInfo {
  housing: number;
  /** Finished buildings belonging to it (not counting its hearth). */
  buildings: number;
  counts: Partial<Record<BuildingId, number>>;
  /** Job slots in its workplaces, after staffing by its own people (colonies only). */
  slots: number;
  /** Slots its workplaces would offer if fully staffed. */
  fullSlots: number;
  link: Link;
  haul: number;
  specialty: Specialty | null;
  biome: Biome;
  /** Landmass its hearth stands on. */
  island: number;
}

export interface Derived {
  territory: Uint8Array;
  /** Settlement each territory tile belongs to (the nearest hearth), 0 outside. */
  townAt: Int32Array;
  /** Territory tiles, for quick scans. */
  terrTiles: number[];
  housing: number;
  stoneHousing: number;
  caps: Resources;
  slots: Record<JobId, number>;
  slotGroups: Record<JobId, SlotGroup[]>;
  counts: Partial<Record<BuildingId, number>>;
  sites: Building[];
  towns: Map<number, TownInfo>;
  /** Tiles people can walk to from a hearth. */
  reach: Uint8Array;
  /** Tiles taken by buildings, roads, trails and the village greens. */
  occupied: Uint8Array;
  /** Tiles of buildings still under construction (trees there stand until felled). */
  siteMask: Uint8Array;
  /** Id of the building on each tile (0 for none). */
  buildingAt: Int32Array;
  /** Tiles covered by buildings other than bridges and hearths: roads go round them. */
  taken: Uint8Array;
  /** Network tiles: roads, trails, the greens and bridges. */
  network: Uint8Array;
  /** Trails blazed by pioneers. */
  trail: Uint8Array;
  /** Open ground a new road could be laid across to reach the network. */
  roadable: Uint8Array;
  /** Forest that a lumber camp replants. */
  replant: Uint8Array;
  /** Where each building's workers draw a resource from, keyed by building id. */
  catchments: Record<LandLayer, Map<number, number[]>>;
  /** Quarries and mines with nothing left to dig. */
  spent: Set<number>;
}

// ------------------------------------------------------------------ census

export interface Census {
  residents: Map<number, number>;
  adults: Map<number, number>;
  /** People on the road with pioneers. */
  away: number;
}

interface CensusMemo {
  day: number;
  people: number;
  bump: number;
  towns: number;
  c: Census;
}
const censusMemo = new WeakMap<GameState, CensusMemo>();
const censusBump = new WeakMap<GameState, number>();

/** Call after moving people between settlements. */
export function recount(state: GameState) {
  censusBump.set(state, (censusBump.get(state) ?? 0) + 1);
}

/** Who lives where. */
export function census(state: GameState): Census {
  const bump = censusBump.get(state) ?? 0;
  const m = censusMemo.get(state);
  if (m && m.day === state.day && m.people === state.settlers.length && m.bump === bump && m.towns === state.towns.length) return m.c;
  const c: Census = { residents: new Map(), adults: new Map(), away: 0 };
  for (const t of state.towns) {
    c.residents.set(t.id, 0);
    c.adults.set(t.id, 0);
  }
  for (const s of state.settlers) {
    if (!s.town) {
      c.away++;
      continue;
    }
    c.residents.set(s.town, (c.residents.get(s.town) ?? 0) + 1);
    const age = (state.day - s.born) / DAYS_PER_YEAR;
    if (age >= ADULT_AGE && age < ELDER_AGE) c.adults.set(s.town, (c.adults.get(s.town) ?? 0) + 1);
  }
  censusMemo.set(state, { day: state.day, people: state.settlers.length, bump, towns: state.towns.length, c });
  return c;
}

// ------------------------------------------------------------------ memo

function structureKey(state: GameState) {
  let done = 0;
  for (const b of state.buildings) if (b.done) done++;
  return `${state.buildings.length}:${done}:${state.nextBuildingId}:${state.roads.length}:${state.trails.length}:${state.graded.length}:${state.towns.length}`;
}

/**
 * What `derived` was worked out from, in three layers: the buildings, ways, techs and settlements; the
 * land's stocks (only whether pits are worked out, and the land around workplaces, depend on them);
 * and the colonies' headcounts, which staff their workplaces.
 */
interface Memo {
  buildings: Building[];
  nb: number;
  nextB: number;
  roads: number;
  trails: number;
  graded: number;
  towns: number;
  tiers: number;
  techs: number;
  routes: number;
  base: Derived;
  landEpoch: number;
  land: Derived | null;
  /** Adults in each settlement after the capital, as staffed for `d`. */
  staffed: number[];
  d: Derived | null;
  /** Bumped whenever `d` is worked out afresh. */
  gen: number;
}

let generation = 0;

const memo = new WeakMap<GameState, Memo>();

function tierSum(state: GameState) {
  let t = 0;
  for (const town of state.towns) t += town.tier;
  return t;
}

/**
 * Whether the memo still matches the buildings, ways, techs and settlements. Buildings finishing and
 * decisions changing always go through `invalidate`, so they are not compared here.
 */
function sameBase(m: Memo, state: GameState) {
  return (
    m.buildings === state.buildings &&
    m.nb === state.buildings.length &&
    m.nextB === state.nextBuildingId &&
    m.roads === state.roads.length &&
    m.trails === state.trails.length &&
    m.graded === state.graded.length &&
    m.towns === state.towns.length &&
    m.techs === state.techs.length &&
    m.routes === state.routes.length &&
    m.tiers === tierSum(state)
  );
}

/** Colonies staff their workplaces with their own people, so their headcount matters to the job slots. */
function sameStaff(m: Memo, state: GameState) {
  if (state.towns.length < 2) return m.staffed.length === 0;
  if (m.staffed.length !== state.towns.length - 1) return false;
  const c = census(state);
  for (let k = 1; k < state.towns.length; k++) if (m.staffed[k - 1] !== (c.adults.get(state.towns[k].id) ?? 0)) return false;
  return true;
}

function staffedNow(state: GameState): number[] {
  if (state.towns.length < 2) return [];
  const c = census(state);
  return state.towns.slice(1).map((t) => c.adults.get(t.id) ?? 0);
}

/** Values that only change when buildings, techs, discoveries, the land or the settlements change. Memoised per state. */
export function derived(state: GameState): Derived {
  let m = memo.get(state);
  if (!m || !sameBase(m, state)) {
    m = {
      buildings: state.buildings,
      nb: state.buildings.length,
      nextB: state.nextBuildingId,
      roads: state.roads.length,
      trails: state.trails.length,
      graded: state.graded.length,
      towns: state.towns.length,
      tiers: tierSum(state),
      techs: state.techs.length,
      routes: state.routes.length,
      base: compute(state),
      landEpoch: NaN,
      land: null,
      staffed: [],
      d: null,
      gen: 0,
    };
    memo.set(state, m);
  }
  if (!m.land || m.landEpoch !== state.landEpoch) {
    m.land = withLand(state, m.base);
    m.landEpoch = state.landEpoch;
    m.d = null;
  }
  if (!m.d || !sameStaff(m, state)) {
    m.staffed = staffedNow(state);
    m.d = staff(state, m.land);
    m.gen = ++generation;
  }
  return m.d;
}

/** A number that changes whenever `derived` is worked out afresh: a cheap way to key what depends on it. */
export function derivedGen(state: GameState): number {
  derived(state);
  return memo.get(state)!.gen;
}

/** Forget what was worked out (the flood fills, keyed by exactly what they depend on, are kept). */
export function invalidate(state: GameState) {
  memo.delete(state);
}

/** Quarries and mines with nothing left to dig. */
function withLand(state: GameState, base: Derived): Derived {
  const spent = new Set<number>();
  for (const b of state.buildings) {
    if (!b.done) continue;
    if (b.type === 'quarry' && layerSum(state, 'stone', base.catchments.stone.get(b.id) ?? []) < 0.5) spent.add(b.id);
    else if (b.type === 'mine' && layerSum(state, 'ore', base.catchments.ore.get(b.id) ?? []) < 0.5) spent.add(b.id);
  }
  return { ...base, spent };
}

export function jobUnlocked(state: GameState, j: JobId) {
  const t = JOB_DEFS[j].tech;
  return !t || hasTech(state, t);
}

interface Structure {
  reach: Uint8Array;
  network: Uint8Array;
  /** The network's tiles, in order. */
  netTiles: number[];
  roadable: Uint8Array;
  trail: Uint8Array;
  /** Network component of each tile, over roads only and over roads and trails. */
  roadComp: Int32Array;
  fullComp: Int32Array;
}

const structMemo = new WeakMap<GameState, { key: string; s: Structure }>();

/** Every tile of the network (roads, trails, greens, bridges and hearths), in order. */
function networkTiles(state: GameState, network: Uint8Array): number[] {
  const seen = new Set<number>();
  const add = (i: number) => {
    if (network[i]) seen.add(i);
  };
  for (const i of state.roads) add(i);
  for (const i of state.trails) add(i);
  for (const b of state.buildings) if (b.type === 'bridge' || b.type === 'campfire') add(idx(b.x, b.y));
  for (const h of hearths(state))
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inBounds(h.x + dx, h.y + dy)) add(idx(h.x + dx, h.y + dy));
  return [...seen].sort((a, b) => a - b);
}

/** The expensive flood fills: they only change when something is built or a road or trail is laid. */
function structure(state: GameState): Structure {
  const key = structureKey(state);
  const m = structMemo.get(state);
  if (m && m.key === key) return m.s;
  const n = MAP_W * MAP_H;
  const pass = passableMask(state);
  const reach = computeReach(state, pass);
  const network = networkMask(state);
  const netTiles = networkTiles(state, network);
  const trail = new Uint8Array(n);
  for (const i of state.trails) trail[i] = 1;
  const roadable = roadableFrom(state, netTiles);
  const roadNet = new Uint8Array(n);
  for (const i of netTiles) if (!trail[i]) roadNet[i] = 1;
  const s: Structure = { reach, network, netTiles, roadable, trail, roadComp: components(roadNet, netTiles), fullComp: components(network, netTiles) };
  structMemo.set(state, { key, s });
  return s;
}

/** Label the connected patches of a mask (N4); -1 outside it. `tiles` lists every tile of the mask, in order. */
function components(mask: Uint8Array, tiles: number[]): Int32Array {
  const comp = new Int32Array(mask.length).fill(-1);
  let id = 0;
  const q: number[] = [];
  for (const i0 of tiles) {
    if (!mask[i0] || comp[i0] >= 0) continue;
    q.length = 0;
    q.push(i0);
    comp[i0] = id;
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      const x = i % MAP_W;
      // East, west, south, north.
      if (x + 1 < MAP_W && mask[i + 1] && comp[i + 1] < 0) (comp[i + 1] = id), q.push(i + 1);
      if (x > 0 && mask[i - 1] && comp[i - 1] < 0) (comp[i - 1] = id), q.push(i - 1);
      if (i + MAP_W < mask.length && mask[i + MAP_W] && comp[i + MAP_W] < 0) (comp[i + MAP_W] = id), q.push(i + MAP_W);
      if (i >= MAP_W && mask[i - MAP_W] && comp[i - MAP_W] < 0) (comp[i - MAP_W] = id), q.push(i - MAP_W);
    }
    id++;
  }
  return comp;
}

/** Territory radius of a hearth: it grows with the settlement, and the capital's also with every age. */
export function hearthRadius(state: GameState, townId: number | undefined) {
  const t = state.towns.find((x) => x.id === townId) ?? state.towns[0];
  const reach = TIERS[t?.tier ?? 0].reach;
  if (!t || t === state.towns[0]) return BUILDING_DEFS.campfire.territory + Math.max(2 * eraOf(state), reach);
  return 4 + reach + (eraOf(state) >= 2 ? 1 : 0);
}

/** Housing a building gives: a new settlement's hearth shelters fewer than the capital's. */
export function housingOf(state: GameState, b: Building) {
  if (b.type === 'campfire' && (b.town ?? state.towns[0]?.id) !== state.towns[0]?.id) return 6;
  return BUILDING_DEFS[b.type].housing ?? 0;
}

/**
 * Job slots: workplaces in a colony are staffed by its own people. Worked out apart from the rest, as
 * it changes with every colony's headcount while the rest only changes with the land and buildings.
 */
function staff(state: GameState, base: Derived): Derived {
  const capitalId = state.towns[0]?.id ?? 1;
  const towns = new Map<number, TownInfo>();
  for (const [id, info] of base.towns) towns.set(id, { ...info, slots: 0, fullSlots: 0 });
  const townOf = (b: Building) => (towns.has(b.town ?? capitalId) ? (b.town ?? capitalId) : capitalId);
  const spent = base.spent;
  const slotGroups = Object.fromEntries(JOBS.map((j) => [j, [] as SlotGroup[]])) as Record<JobId, SlotGroup[]>;
  const c = state.towns.length > 1 ? census(state) : null;
  const raw: Map<number, { j: JobId; g: SlotGroup }[]> = new Map();
  for (const b of state.buildings) {
    if (!b.done || spent.has(b.id)) continue;
    const def = BUILDING_DEFS[b.type];
    const tid = townOf(b);
    const info = towns.get(tid)!;
    for (const [job, k] of Object.entries(def.slots ?? {})) {
      const g: SlotGroup = { mult: buildingMult(state, b) * info.haul, count: k!, building: b.id, town: tid };
      if (!raw.has(tid)) raw.set(tid, []);
      raw.get(tid)!.push({ j: job as JobId, g });
    }
  }
  for (const [tid, list] of raw) {
    const info = towns.get(tid)!;
    const full = list.reduce((s, e) => s + e.g.count, 0);
    info.fullSlots = full;
    const staff = tid === capitalId || !c ? full : c.adults.get(tid) ?? 0;
    if (staff < full) {
      // Too few hands for every workplace: the kinds of work found nowhere else in the realm are
      // staffed first (a lone smithy before the sixth quarry), then the most productive.
      const elsewhere = (j: JobId) => {
        let k = 0;
        for (const [t2, l2] of raw) if (t2 !== tid) for (const e of l2) if (e.j === j) k += e.g.count;
        return k;
      };
      const scarce = new Map<JobId, number>();
      for (const e of list) if (!scarce.has(e.j)) scarce.set(e.j, elsewhere(e.j));
      const order = [...list].sort((a, b) => scarce.get(a.j)! - scarce.get(b.j)! || b.g.mult - a.g.mult || (a.g.building ?? 0) - (b.g.building ?? 0));
      let left = staff;
      const given = new Map<SlotGroup, number>();
      // First one hand per kind of work, then fill up in order.
      const seen = new Set<JobId>();
      for (const e of order) {
        if (left <= 0) break;
        if (seen.has(e.j)) continue;
        seen.add(e.j);
        given.set(e.g, 1);
        left--;
      }
      for (const e of order) {
        if (left <= 0) break;
        const k = Math.min(left, e.g.count - (given.get(e.g) ?? 0));
        given.set(e.g, (given.get(e.g) ?? 0) + k);
        left -= k;
      }
      for (const e of list) e.g.count = given.get(e.g) ?? 0;
    }
    info.slots = list.reduce((s, e) => s + e.g.count, 0);
    for (const e of list) if (e.g.count > 0) slotGroups[e.j].push({ mult: e.g.mult, count: e.g.count, building: e.g.building, town: e.g.town });
  }

  const slots = {} as Record<JobId, number>;
  for (const j of JOBS) {
    slotGroups[j].sort((a, b) => b.mult - a.mult);
    slots[j] = slotGroups[j].reduce((s, g) => s + g.count, 0);
  }
  slots.gatherer = Infinity;
  slots.builder = Infinity;
  for (const j of JOBS) if (!jobUnlocked(state, j)) slots[j] = 0;
  return { ...base, towns, slotGroups, slots };
}

const shapes = new Map<string, [number, number][]>();

/** The tiles a building of this footprint holds as territory, as offsets from its top-left corner. */
function territoryShape(w: number, h: number, r: number): [number, number][] {
  const key = `${w},${h},${r}`;
  let out = shapes.get(key);
  if (out) return out;
  out = [];
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = Math.ceil(r + Math.max(w, h));
  for (let y = Math.floor(cy) - R; y <= Math.ceil(cy) + R; y++)
    for (let x = Math.floor(cx) - R; x <= Math.ceil(cx) + R; x++) if (Math.hypot(x - cx, y - cy) <= r + 0.5 + (Math.max(w, h) - 1) / 2) out.push([x, y]);
  shapes.set(key, out);
  return out;
}

function compute(state: GameState): Derived {
  const n = MAP_W * MAP_H;
  const capitalId = state.towns[0]?.id ?? 1;
  const territory = new Uint8Array(n);
  const townAt = new Int32Array(n);
  let housing = 0;
  let stoneHousing = 0;
  const caps = Object.fromEntries(RESOURCES.map((r) => [r, RESOURCE_DEFS[r].baseCap])) as Resources;
  const slotGroups = Object.fromEntries(JOBS.map((j) => [j, [] as SlotGroup[]])) as Record<JobId, SlotGroup[]>;
  const counts: Partial<Record<BuildingId, number>> = {};
  const sites: Building[] = [];
  const occupied = new Uint8Array(n);
  const siteMask = new Uint8Array(n);
  const buildingAt = new Int32Array(n);
  const taken = new Uint8Array(n);
  const replant = new Uint8Array(n);
  let terrTiles: number[] = [];
  const catchments = { wood: new Map(), stone: new Map(), ore: new Map(), life: new Map() } as Derived['catchments'];
  // Filled in with what the land still holds (see `withLand`).
  const spent = new Set<number>();
  const map = getMap(state.seed);
  const st = structure(state);
  const { trail } = st;
  for (const i of st.netTiles) occupied[i] = 1;

  const towns = new Map<number, TownInfo>();
  for (const t of state.towns) {
    const hi = idx(t.x, t.y);
    towns.set(t.id, { housing: 0, buildings: 0, counts: {}, slots: 0, fullSlots: 0, link: 'none', haul: HAUL.none, specialty: null, biome: map.biome[hi] as Biome, island: map.island[hi] });
  }
  const townOf = (b: Building) => (towns.has(b.town ?? capitalId) ? (b.town ?? capitalId) : capitalId);

  for (const b of state.buildings) {
    const tiles = tilesOf(b);
    const covers = b.type !== 'bridge' && b.type !== 'campfire';
    for (const at of tiles) {
      occupied[at] = 1;
      buildingAt[at] = b.id;
      if (covers) taken[at] = 1;
      if (!b.done) siteMask[at] = 1;
    }
    if (!b.done) {
      sites.push(b);
      continue;
    }
    const def = BUILDING_DEFS[b.type];
    counts[b.type] = (counts[b.type] ?? 0) + 1;
    const town = towns.get(townOf(b))!;
    if (b.type !== 'campfire' && b.type !== 'bridge') {
      town.buildings++;
      town.counts[b.type] = (town.counts[b.type] ?? 0) + 1;
    }
    for (const layer of ['wood', 'stone', 'ore', 'life'] as LandLayer[]) {
      const ct = catchmentAt(state, b.type, b.x, b.y, layer);
      if (ct.length) catchments[layer].set(b.id, ct);
    }

    if (b.type === 'lumber') for (const i of catchments.wood.get(b.id) ?? []) replant[i] = 1;
    const r = b.type === 'campfire' ? hearthRadius(state, b.town) : def.territory;
    const [w, h] = sizeOf(b.type);
    for (const [dx, dy] of territoryShape(w, h, r)) {
      const x = b.x + dx;
      const y = b.y + dy;
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
      const i = y * MAP_W + x;
      if (territory[i]) continue;
      territory[i] = 1;
      terrTiles.push(i);
    }
    const hs = housingOf(state, b);
    housing += hs;
    town.housing += hs;
    if (b.type === 'house' || b.type === 'manor') stoneHousing += hs;
    for (const [res, amt] of Object.entries(def.storage ?? {})) caps[res as ResourceId] += amt!;
  }

  // --- how each settlement is linked to the capital
  const ids = state.towns.map((t) => t.id);
  const parent = new Map<number, number>(ids.map((i) => [i, i]));
  const find = (a: number): number => {
    while (parent.get(a) !== a) a = parent.get(a)!;
    return a;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));
  const hcomp = (comp: Int32Array, t: { x: number; y: number }) => comp[idx(t.x, t.y)];
  for (const a of state.towns)
    for (const b of state.towns) if (a.id < b.id && hcomp(st.roadComp, a) >= 0 && hcomp(st.roadComp, a) === hcomp(st.roadComp, b)) union(a.id, b.id);
  const roadRoot = new Map(ids.map((i) => [i, find(i)]));
  for (const r of state.routes) if (towns.has(r.a) && towns.has(r.b)) union(r.a, r.b);
  const routeRoot = new Map(ids.map((i) => [i, find(i)]));
  for (const a of state.towns)
    for (const b of state.towns) if (a.id < b.id && hcomp(st.fullComp, a) >= 0 && hcomp(st.fullComp, a) === hcomp(st.fullComp, b)) union(a.id, b.id);
  for (const t of state.towns) {
    const info = towns.get(t.id)!;
    info.link =
      t.id === capitalId ? 'capital' : roadRoot.get(t.id) === roadRoot.get(capitalId) ? 'road' : routeRoot.get(t.id) === routeRoot.get(capitalId) ? 'route' : find(t.id) === find(capitalId) ? 'trail' : 'none';
    info.haul = HAUL[info.link];
    let best: Specialty | null = null;
    let bestV = 1.5;
    const tally: Partial<Record<Specialty, number>> = {};
    for (const [type, k] of Object.entries(info.counts)) {
      const sp = SPECIALTY_OF[type as BuildingId];
      if (!sp) continue;
      tally[sp[0]] = (tally[sp[0]] ?? 0) + k! * sp[1];
    }
    for (const [sp, v] of Object.entries(tally)) if (v! > bestV) (bestV = v!), (best = sp as Specialty);
    info.specialty = best;
  }

  // Decision effects on storage.
  const store = fxMul(state, 'storage');
  for (const r of RESOURCES) if (isFinite(caps[r])) caps[r] = Math.round(caps[r] * store);
  caps.food = Math.round(caps.food * fxMul(state, 'foodStore'));

  const slots = {} as Record<JobId, number>;

  // Each territory tile belongs to the nearest hearth.
  const hs = hearths(state);
  terrTiles = Array.from(Int32Array.from(terrTiles).sort());
  const hx = Int32Array.from(hs, (h) => h.x);
  const hy = Int32Array.from(hs, (h) => h.y);
  const ht = Int32Array.from(hs, (h) => h.town ?? capitalId);
  for (const i of terrTiles) {
    const x = i % MAP_W;
    const y = (i - x) / MAP_W;
    let best = capitalId;
    let bd = Infinity;
    for (let k = 0; k < hx.length; k++) {
      const dx = x - hx[k];
      const dy = y - hy[k];
      const dd = dx * dx + dy * dy;
      if (dd < bd) (bd = dd), (best = ht[k]);
    }
    townAt[i] = best;
  }

  return {
    territory,
    townAt,
    terrTiles,
    housing,
    stoneHousing,
    caps,
    slots,
    slotGroups,
    counts,
    sites,
    towns,
    reach: st.reach,
    occupied,
    siteMask,
    buildingAt,
    taken,
    network: st.network,
    trail,
    roadable: st.roadable,
    replant,
    catchments,
    spent,
  };
}

/** Flood out from the network over ground a road may cross (not buildings, water, rock or sacred sites). */
function roadableFrom(state: GameState, netTiles: number[]): Uint8Array {
  const map = getMap(state.seed);
  const n = MAP_W * MAP_H;
  const taken = takenMask(state);
  const area = workArea(state);
  const out = new Uint8Array(n);
  const queue: number[] = [];
  for (const i of netTiles) if (!taken[i]) (out[i] = 1), queue.push(i);
  const visit = (j: number) => {
    if (out[j] || taken[j] || !area[j] || blocked(map, j) || map.feature[j] === F.Ruins || map.feature[j] === F.Grove) return;
    out[j] = 1;
    queue.push(j);
  };
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % MAP_W;
    if (x + 1 < MAP_W) visit(i + 1);
    if (x > 0) visit(i - 1);
    if (i + MAP_W < n) visit(i + MAP_W);
    if (i >= MAP_W) visit(i - MAP_W);
  }
  return out;
}

/** Count the tiles in the ring around a footprint that match. */
function countRing(state: GameState, type: BuildingId, x: number, y: number, pred: (t: number, f: number, i: number) => boolean) {
  const map = getMap(state.seed);
  const [w, h] = sizeOf(type);
  const r = ringOffsets(w, h);
  let n = 0;
  for (let k = 0; k < r.dx.length; k++) {
    const xx = x + r.dx[k];
    const yy = y + r.dy[k];
    if (!inBounds(xx, yy)) continue;
    const i = idx(xx, yy);
    if (pred(map.terrain[i], map.feature[i], i)) n++;
  }
  return n;
}

/** The biome a building stands in (that of its centre). */
export function biomeOf(state: GameState, b: { type: BuildingId; x: number; y: number }): Biome {
  const [cx, cy] = centerOf(b);
  return getMap(state.seed).biome[idx(Math.round(cx), Math.round(cy))] as Biome;
}

/** Output multiplier a building gives its workers, from what the land around it still holds and its climate. */
export function buildingMult(state: GameState, b: { type: BuildingId; x: number; y: number }): number {
  const map = getMap(state.seed);
  const tiles = footprint(b.type, b.x, b.y) ?? [idx(b.x, b.y)];
  const biome = biomeOf(state, b);
  switch (b.type) {
    case 'lumber': {
      const n = countRing(state, b.type, b.x, b.y, (_t, _f, i) => wooded(state, i));
      return 1 + 0.12 * Math.min(n, 8);
    }
    case 'lodge': {
      const forest = countRing(state, b.type, b.x, b.y, (_t, _f, i) => wooded(state, i));
      let game = 0;
      for (let y = b.y - 3; y <= b.y + 3; y++)
        for (let x = b.x - 3; x <= b.x + 3; x++) {
          if (!inBounds(x, y)) continue;
          const i = idx(x, y);
          if (map.feature[i] === F.Game && state.explored[i] === 1 && state.land.life[i] >= 5) game++;
        }
      return Math.min(2, 1 + 0.06 * forest + 0.3 * game) * BIOMES[biome].hunt;
    }
    case 'quarry': {
      const n = countRing(state, b.type, b.x, b.y, (t, _f, i) => (t === T.Hills || t === T.Mountain || t === T.Peak) && state.land.stone[i] > 0);
      const on = tiles.some((i) => (map.terrain[i] === T.Hills || map.terrain[i] === T.Mountain) && state.land.stone[i] > 0);
      return 1 + 0.07 * Math.min(n, 8) + (on ? 0.2 : 0);
    }
    case 'farm': {
      const water = countRing(state, b.type, b.x, b.y, (t) => t === T.River || t === T.Water) > 0;
      const meadow = tiles.filter((i) => map.terrain[i] === T.Meadow).length / tiles.length;
      // A river turns even the desert green: an oasis farms as well as the mild lands.
      const climate = water && biome === Biome.Arid ? 1 : BIOMES[biome].farm;
      return (1 + (water ? 0.3 : 0) + 0.1 * meadow) * climate;
    }
    case 'mine': {
      const vein = (i: number) => map.feature[i] === F.Ore && state.land.ore[i] > 0;
      return tiles.some(vein) || countRing(state, b.type, b.x, b.y, (_t, _f, i) => vein(i)) > 0 ? 2 : 1;
    }
    default:
      return 1;
  }
}

export type PlaceCheck = { ok: true; mult: number } | { ok: false; reason: string };

/**
 * Whether a building can go here (tile = top-left of its footprint): explored land in the territory,
 * not water, a peak, sacred ground, a road or another building, and reachable on foot. Standing trees and
 * rock are fine: the site is cleared and levelled before building starts.
 */
export function canPlace(state: GameState, type: BuildingId, tile: number, d: Derived = derived(state)): PlaceCheck {
  const map = getMap(state.seed);
  const def = BUILDING_DEFS[type];
  const x = tx(tile);
  const y = ty(tile);
  const [w, h] = sizeOf(type);
  const tiles = footprint(type, x, y);
  if (!tiles) return { ok: false, reason: 'Off the edge of the world' };
  if (type === 'campfire') return { ok: false, reason: 'Hearths are lit by pioneers' };
  for (const i of tiles) {
    if (!state.explored[i]) return { ok: false, reason: 'Unexplored' };
    if (!d.territory[i]) return { ok: false, reason: 'Outside your territory' };
    if (d.buildingAt[i]) return { ok: false, reason: 'Occupied' };
    if (d.occupied[i]) return { ok: false, reason: d.trail[i] ? 'A trail runs here' : d.network[i] && !state.roads.includes(i) ? 'The village green is kept open' : 'A road runs here' };
  }
  if (def.tier) {
    const town = state.towns.find((t) => t.id === d.townAt[tile]);
    if (!town || town.tier < def.tier) return { ok: false, reason: `Only in a town or city` };
  }
  if (def.rule === 'bridge') {
    const t = map.terrain[tile];
    if (t !== T.River) return { ok: false, reason: 'Bridges span rivers' };
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy) || !inBounds(x - dx, y - dy)) continue;
      const near = idx(x + dx, y + dy);
      const far = idx(x - dx, y - dy);
      const nearOk = (d.reach[near] && d.roadable[near] && !d.occupied[near]) || (d.network[near] && (d.reach[near] || state.buildings.some((b) => b.id === d.buildingAt[near] && b.type === 'bridge')));
      const farT = map.terrain[far];
      if (nearOk && (BUILDABLE_LAND(farT) || farT === T.River)) return { ok: true, mult: 1 };
    }
    return { ok: false, reason: 'Needs land you can reach on one bank' };
  }
  let reached = false;
  let rock = false;
  for (const i of tiles) {
    const t = terrainAt(state, i);
    const f = map.feature[i] as F;
    if (t === T.Water || t === T.Deep || t === T.River) return { ok: false, reason: 'Water' };
    if (t === T.Peak) return { ok: false, reason: 'Too steep even to level' };
    if (f === F.Ruins || f === F.Grove) return { ok: false, reason: 'Sacred ground' };
    if (f === F.Berries && state.land.life[i] > 0) return { ok: false, reason: 'A berry thicket grows here' };
    if (f === F.Ore && type !== 'mine') return { ok: false, reason: 'An ore vein: keep it for a mine' };
    if (isStreet(state, i)) return { ok: false, reason: 'Kept clear as a way out of the green' };
    if (t === T.Mountain) rock = true;
    else if (d.reach[i]) reached = true;
    else return { ok: false, reason: 'Across the river: build a bridge' };
  }
  // A mountainside site must lean on ground people can reach.
  let access = false;
  const ring = ringOffsets(w, h);
  for (let k = 0; k < ring.dx.length; k++) {
    const xx = x + ring.dx[k];
    const yy = y + ring.dy[k];
    if (!inBounds(xx, yy) || ring.corner[k]) continue;
    const j = idx(xx, yy);
    if (d.roadable[j] && !(d.occupied[j] && !d.network[j])) access = true;
    if (rock && d.reach[j]) reached = true;
  }
  if (!reached) return { ok: false, reason: 'Nobody can reach it' };
  if (!access) return { ok: false, reason: 'Boxed in: no road can reach it' };
  if (cutsThrough(state, d, x, y, w, h)) return { ok: false, reason: 'It would block the way through' };
  const steepNear = countRing(state, type, x, y, (tt) => tt === T.Mountain || tt === T.Peak) > 0 || tiles.some((i) => map.terrain[i] === T.Mountain);
  const hillsAt = tiles.some((i) => map.terrain[i] === T.Hills);
  switch (def.rule) {
    case 'open':
      for (const i of tiles) {
        const t = map.terrain[i];
        if (!(t === T.Grass || t === T.Meadow || landMax(state.seed).wood[i] > 0)) return { ok: false, reason: 'Needs open grassland' };
      }
      break;
    case 'quarry':
      if (!(hillsAt || steepNear || countRing(state, type, x, y, (tt) => tt === T.Hills) > 0)) return { ok: false, reason: 'Needs hills or a mountainside' };
      break;
    case 'mine':
      if (!(hillsAt || steepNear)) return { ok: false, reason: 'Needs hills or a mountainside' };
      break;
    case 'forest-edge':
      if (!countRing(state, type, x, y, (_tt, _f, i) => wooded(state, i))) return { ok: false, reason: 'Needs standing forest beside it' };
      break;
    case 'coast':
      if (!countRing(state, type, x, y, (_tt, _f, i) => isSea(map, i))) return { ok: false, reason: 'Needs the shore of the open sea' };
      if (rock) return { ok: false, reason: 'Needs a low shore' };
      break;
    default:
      break;
  }
  return { ok: true, mult: buildingMult(state, { type, x, y }) };
}

function BUILDABLE_LAND(t: number) {
  return t !== T.Water && t !== T.Deep && t !== T.River && t !== T.Peak;
}

/**
 * Whether a building here would split the open ground around it in two, closing off a lane or a pass.
 * Walks the ring of tiles around the footprint: the open stretches that touch its sides must all be one.
 */
const ringOpen = new Uint8Array(64);

function cutsThrough(state: GameState, d: Derived, x: number, y: number, w: number, h: number) {
  const map = getMap(state.seed);
  const ring = ringOffsets(w, h);
  const L = ring.dx.length;
  const open = ringOpen;
  let startK = -1;
  for (let k = 0; k < L; k++) {
    const xx = x + ring.dx[k];
    const yy = y + ring.dy[k];
    let o = 0;
    if (inBounds(xx, yy)) {
      const j = idx(xx, yy);
      o = !blocked(map, j) && !(d.occupied[j] && !d.network[j]) ? 1 : 0;
    }
    open[k] = o;
    if (!o && startK < 0) startK = k;
  }
  if (startK < 0) return false;
  // Count circular runs of open cells that include at least one side cell.
  let runs = 0;
  let inRun = false;
  let hasSide = false;
  for (let s = 1; s <= L; s++) {
    const k = (startK + s) % L;
    if (open[k]) {
      if (!inRun) (inRun = true), (hasSide = false);
      if (!ring.corner[k]) hasSide = true;
    } else if (inRun) {
      inRun = false;
      if (hasSide) runs++;
    }
  }
  if (inRun && hasSide) runs++;
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

/** The building covering a tile, if any. */
export function buildingOn(state: GameState, tile: number): Building | undefined {
  const id = derived(state).buildingAt[tile];
  return id ? state.buildings.find((b) => b.id === id) : undefined;
}
