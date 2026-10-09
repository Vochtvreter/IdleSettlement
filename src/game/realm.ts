/**
 * The realm beyond the first hearth: settlements that grow from camps into cities, people moving to
 * where the work is, pioneers who blaze trails to the best land they know of and found new
 * settlements (crossing the sea by galley once the realm has a harbour), voyages that chart unknown
 * coasts, and trade routes that tie it all together. Deterministic, so it runs the same offline.
 */
import {
  BIOMES,
  BUILDING_DEFS,
  CARAVAN_COST,
  DAYS_PER_YEAR,
  ERAS,
  GALLEY_COST,
  MAP_H,
  MAP_W,
  PAVE_STONE,
  PAVE_WORK,
  PIONEER_SUPPLIES,
  PIONEERS,
  TIERS,
  TOWN_SPACING,
} from './data';
import { census, canAfford, derived, invalidate, pay, recount, SPECIALTY_NAMES, type Derived } from './derived';
import { choiceOf, fxMul } from './decisions';
import { clearTile, Heap, hearthOf, landMax, layRoad, layTrail, tilesOf, townById } from './land';
import { getMap, idx, inBounds, isSea, isWater, N4, N8, tx, ty } from './map';
import { placeName } from './names';
import { Rng } from './rng';
import { ageOf, eraOf, hasTech, isAdult } from './state';
import type { BuildingId, Cost, Expedition, FxEvent, GameState, Rates, ResourceId, Settlement, TradeRoute } from './types';
import { Biome, F, T } from './types';

export type RealmResult = { ok: true } | { ok: false; reason: string };

interface Ctx {
  fx: FxEvent[];
  rates?: Rates;
  offline?: boolean;
}

function note(state: GameState, text: string, kind: 'realm' | 'good' | 'bad' | 'info' | 'discovery' = 'realm') {
  state.log.push({ day: state.day, text, kind });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

// ------------------------------------------------------------------ tiers

/** The tier a settlement qualifies for now: by its people, its buildings and the realm's age. */
export function tierFor(state: GameState, town: Settlement, d: Derived = derived(state)): number {
  const people = census(state).residents.get(town.id) ?? 0;
  const built = d.towns.get(town.id)?.buildings ?? 0;
  const era = eraOf(state);
  let t = 0;
  for (let k = 1; k < TIERS.length; k++) {
    const def = TIERS[k];
    if (people >= def.pop && built >= def.buildings && era >= def.era) t = k;
    else break;
  }
  return t;
}

/** What the next tier still needs, for display. */
export function nextTierNeeds(state: GameState, town: Settlement): string[] {
  const k = town.tier + 1;
  if (k >= TIERS.length) return [];
  const def = TIERS[k];
  const people = census(state).residents.get(town.id) ?? 0;
  const built = derived(state).towns.get(town.id)?.buildings ?? 0;
  const out: string[] = [];
  if (people < def.pop) out.push(`${def.pop} people (now ${people})`);
  if (built < def.buildings) out.push(`${def.buildings} buildings (now ${built})`);
  if (eraOf(state) < def.era) out.push(`the ${ERAS[def.era].name}`);
  return out;
}

/** "Mining Town", "Harbour City", or just "Village" while it has no trade of its own. */
export function townTitle(state: GameState, town: Settlement): string {
  const tier = TIERS[town.tier].name;
  const spec = derived(state).towns.get(town.id)?.specialty;
  return spec ? `${SPECIALTY_NAMES[spec]} ${tier}` : tier;
}

function updateTiers(state: GameState, ctx: Ctx) {
  const d = derived(state);
  for (const t of state.towns) {
    const k = tierFor(state, t, d);
    if (k <= t.tier) continue;
    t.tier = k;
    invalidate(state);
    ctx.fx.push({ kind: 'tier', town: t.id, tier: k });
    note(state, `${t.name} has grown into a ${TIERS[k].name.toLowerCase()}!${k >= 2 ? ' Its territory widens.' : ''}`, 'realm');
  }
}

// ------------------------------------------------------------------ people on the move

/** Settlements people can move between: both joined to the capital by trail, road or trade route, or directly by a route. */
function linked(state: GameState, a: number, b: number, d: Derived) {
  if (hasRoute(state, a, b)) return true;
  const ia = d.towns.get(a);
  const ib = d.towns.get(b);
  return !!ia && !!ib && ia.link !== 'none' && ib.link !== 'none';
}

/**
 * People go where the work and the homes are: workplaces short of hands with free beds draw settlers
 * from crowded settlements, and the overcrowded move to wherever there is room.
 */
function migrate(state: GameState) {
  if (state.towns.length < 2) return;
  const d = derived(state);
  const c = census(state);
  const free = (id: number) => (d.towns.get(id)?.housing ?? 0) - (c.residents.get(id) ?? 0);
  const short = (id: number) => (d.towns.get(id)?.fullSlots ?? 0) - (c.adults.get(id) ?? 0);
  let moved = 0;
  for (const to of state.towns) {
    if (free(to.id) <= 0) continue;
    const pull = short(to.id) > 0 ? 2 : 0;
    // Pick the settlement with the most people to spare.
    let from: Settlement | null = null;
    let best = 0;
    for (const s of state.towns) {
      if (s.id === to.id || !linked(state, s.id, to.id, d)) continue;
      const crowd = -free(s.id);
      const spare = (c.adults.get(s.id) ?? 0) - (d.towns.get(s.id)?.fullSlots ?? 0) - (s.id === state.towns[0].id ? 8 : 2);
      const push = Math.max(crowd > 0 ? crowd + 2 : 0, pull && spare > 0 ? spare : 0);
      if (push > best) (best = push), (from = s);
    }
    if (!from) continue;
    const n = Math.min(free(to.id), best > 4 ? 2 : 1);
    const movers = state.settlers.filter((s) => s.town === from!.id && isAdult(state, s)).slice(-n);
    for (const m of movers) {
      m.town = to.id;
      moved++;
    }
    // Children follow a parent.
    const kids = state.settlers.filter((s) => s.town === from!.id && ageOf(state, s) < 13).slice(0, Math.min(movers.length, Math.max(0, free(to.id) - movers.length)));
    for (const k of kids) k.town = to.id;
    if (movers.length || kids.length) recount(state);
  }
  return moved;
}

/** The settlement with the most room for newcomers (the capital when there is a tie). */
export function townWithRoom(state: GameState): number {
  const d = derived(state);
  const c = census(state);
  let best = state.towns[0]?.id ?? 1;
  let room = -Infinity;
  for (const t of state.towns) {
    const r = (d.towns.get(t.id)?.housing ?? 0) - (c.residents.get(t.id) ?? 0);
    if (r > room) (room = r), (best = t.id);
  }
  return best;
}

// ------------------------------------------------------------------ the land as pioneers judge it

export interface SiteProfile {
  farming: number;
  timber: number;
  stone: number;
  ore: number;
  game: number;
  fish: number;
  water: boolean;
  coast: boolean;
}

const valueCache = new Map<number, Float32Array>();

/** Fresh water within a few tiles: rivers and lakes (not the salt sea). */
function freshWaterNear(seed: number, i: number, r = 3) {
  const map = getMap(seed);
  const x = tx(i);
  const y = ty(i);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      const t = map.terrain[j];
      if (t === T.River || (t === T.Water && !map.ocean[j])) return true;
    }
  return false;
}

/** What the land within a day's walk of a tile offers a settlement. */
export function siteProfile(seed: number, i: number): SiteProfile {
  const map = getMap(seed);
  const m = landMax(seed);
  const x = tx(i);
  const y = ty(i);
  const p: SiteProfile = { farming: 0, timber: 0, stone: 0, ore: 0, game: 0, fish: 0, water: freshWaterNear(seed, i), coast: false };
  const R = 6;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > R || !inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      const w = 1 - d / (R + 3);
      const t = map.terrain[j];
      const b = map.biome[j] as Biome;
      const f = map.feature[j];
      if (t === T.Grass || t === T.Meadow) {
        let wet = false;
        for (const [ax, ay] of N4) if (inBounds(x + dx + ax, y + dy + ay) && (map.terrain[idx(x + dx + ax, y + dy + ay)] === T.River || map.terrain[idx(x + dx + ax, y + dy + ay)] === T.Water)) wet = true;
        const climate = wet && b === Biome.Arid ? 1 : BIOMES[b].farm;
        p.farming += w * (0.5 + (wet ? 0.7 : 0)) * climate;
      }
      if (m.wood[j]) p.timber += (w * m.wood[j]) / 160;
      if (t === T.Hills) p.stone += w * 0.6;
      if (t === T.Mountain) (p.stone += w * 0.4), (p.ore += w * 0.25 * (b === Biome.Arid ? 1.5 : 1));
      if (f === F.Ore) p.ore += 5 * w;
      if (f === F.Game) p.game += 3.5 * w * BIOMES[b].hunt;
      if (f === F.Fish) p.fish += 3 * w;
      if (f === F.Berries) p.farming += 1.5 * w;
      if (isSea(map, j) && d <= 2) p.coast = true;
      if (isSea(map, j)) p.fish += 0.08 * w;
    }
  return p;
}

/** How good a place is for a new settlement's hearth, from what is around it (0 where one cannot stand). */
export function siteValues(seed: number): Float32Array {
  let v = valueCache.get(seed);
  if (v) return v;
  const map = getMap(seed);
  const n = MAP_W * MAP_H;
  v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = map.terrain[i];
    if (t !== T.Grass && t !== T.Meadow && t !== T.Sand && t !== T.Forest) continue;
    if (map.feature[i]) continue;
    const x = tx(i);
    const y = ty(i);
    if (x < 3 || y < 3 || x > MAP_W - 4 || y > MAP_H - 4) continue;
    // Room for a green: most of the ring must be walkable land.
    let ok = 0;
    for (const [dx, dy] of N8) {
      const tt = map.terrain[idx(x + dx, y + dy)];
      if (!isWater(tt) && tt !== T.Mountain && tt !== T.Peak) ok++;
    }
    if (ok < 6) continue;
    v[i] = profileValue(siteProfile(seed, i));
  }
  if (valueCache.size >= 4) valueCache.delete(valueCache.keys().next().value!);
  valueCache.set(seed, v);
  return v;
}

/** One number for a site, as pioneers would weigh it: fresh water above all, then food, then the rest. */
export function profileValue(p: SiteProfile) {
  const f = Math.min(p.farming, 30) + Math.min(p.timber, 14) * 0.8 + Math.min(p.stone, 10) * 0.8 + Math.min(p.ore, 14) + Math.min(p.game, 12) + Math.min(p.fish, 10) * 0.9;
  return Math.max(0.1, f + (p.water ? 6 : -8) + (p.coast ? 3 : 0));
}

/** What a site would most likely live by, in words. */
export function siteCalling(p: SiteProfile): string {
  const opts: [string, number][] = [
    ['farming', p.farming * 0.5],
    ['timber', p.timber * 0.9],
    ['stone', p.stone],
    ['mining', p.ore * 1.1],
    ['hunting', p.game],
    ['fishing', p.fish + (p.coast ? 2 : 0)],
  ];
  opts.sort((a, b) => b[1] - a[1]);
  return opts[0][0];
}

// ------------------------------------------------------------------ pathfinding

/** Days for a party on foot to cross a tile, or Infinity where they cannot go. */
export function footCost(state: GameState, i: number, d: Derived): number {
  const map = getMap(state.seed);
  const t = map.terrain[i];
  if (!state.explored[i]) return Infinity;
  if (d.network[i]) return d.trail[i] ? 0.7 : 0.5;
  // Round buildings, not through them, so the trail behind them stays unbroken.
  if (d.buildingAt[i]) return Infinity;
  switch (t) {
    case T.Grass:
    case T.Meadow:
    case T.Sand:
      return 1;
    case T.Forest:
      return 1.6;
    case T.Dense:
      return 2.2;
    case T.Hills:
      return 2;
    case T.Mountain:
      return 4.5;
    case T.River:
      return 4;
    default:
      return Infinity;
  }
}

/** Days for a galley to cross a sea tile. */
const SEA_COST = 0.3;
/** Getting a party and its goods ashore. */
const LANDING_COST = 3;

export interface SiteChoice {
  tile: number;
  path: number[];
  /** Travel time in days. */
  cost: number;
  value: number;
  score: number;
  sea: boolean;
}

/** Harbour tiles in a settlement, where a galley can set out. */
function harbourTiles(state: GameState, town: number): Set<number> {
  const out = new Set<number>();
  for (const b of state.buildings) if (b.type === 'harbour' && b.done && b.town === town) for (const i of tilesOf(b)) out.add(i);
  return out;
}

/**
 * Pioneers' search for prime land: spread out from a settlement over the land they know (trails and
 * roads are quicker; forest, hills, fords and mountain passes slower), and by galley across the sea
 * from a harbour; weigh every place they could settle by what it offers against how far it is.
 */
export function findSites(state: GameState, fromTown: number, opts: { sea?: boolean; maxCost?: number; limit?: number } = {}): SiteChoice[] {
  const map = getMap(state.seed);
  const d = derived(state);
  const n = MAP_W * MAP_H;
  const values = siteValues(state.seed);
  const home = townById(state, fromTown);
  if (!home) return [];
  const sea = opts.sea ?? (hasTech(state, 'seafaring') && harbourTiles(state, fromTown).size > 0);
  const harbours = sea ? harbourTiles(state, fromTown) : new Set<number>();
  const maxCost = opts.maxCost ?? 160;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const start = idx(home.x, home.y);
  dist[start] = 0;
  heap.push(start, 0);
  const spacing = (i: number) => state.towns.every((t) => Math.hypot(t.x - tx(i), t.y - ty(i)) >= TOWN_SPACING);
  // Expeditions under way have claimed their destinations.
  const claimed = state.expeditions.filter((e) => e.kind === 'settle').map((e) => e.path[e.path.length - 1]);
  const biomesHeld = new Set(state.towns.map((t) => map.biome[idx(t.x, t.y)]));
  // Pioneers are drawn to riches the realm does not have yet: ore when it has only fields, the sea when it has none.
  const callingsHeld = new Set(state.towns.map((t) => siteCalling(siteProfile(state.seed, idx(t.x, t.y)))));
  const out: SiteChoice[] = [];
  const closed = new Uint8Array(n);
  while (heap.size) {
    const i = heap.pop();
    if (closed[i]) continue;
    closed[i] = 1;
    const di = dist[i];
    if (di > maxCost) break;
    const onSea = isWater(map.terrain[i]) && map.ocean[i];
    if (!onSea && values[i] > 0 && state.explored[i] && !d.occupied[i] && !d.territory[i] && spacing(i) && claimed.every((c) => Math.hypot(tx(c) - tx(i), ty(c) - ty(i)) >= TOWN_SPACING)) {
      let v = values[i];
      if (!biomesHeld.has(map.biome[i])) v += 5;
      if (map.island[i] !== map.island[start]) v += 3;
      out.push({ tile: i, path: [], cost: di, value: v, score: v - di * 0.09, sea: false });
    }
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = idx(x + dx, y + dy);
      if (closed[j]) continue;
      let c: number;
      const jSea = map.ocean[j] === 1;
      if (jSea) {
        // Only a galley from a harbour puts to sea.
        if (!sea || (!onSea && !harbours.has(i) && !nextTo(harbours, i))) continue;
        c = SEA_COST;
      } else if (onSea) {
        c = footCost(state, j, d);
        if (!isFinite(c)) continue;
        c += LANDING_COST;
      } else {
        c = footCost(state, j, d);
        if (!isFinite(c) && !harbours.has(j)) continue;
        if (harbours.has(j)) c = 0.5;
      }
      const nd = di + c;
      if (nd < dist[j]) {
        dist[j] = nd;
        prev[j] = i;
        heap.push(j, nd);
      }
    }
  }
  out.sort((a, b) => b.score - a.score || a.tile - b.tile);
  for (const c of out.slice(0, 40))
    if (!callingsHeld.has(siteCalling(siteProfile(state.seed, c.tile)))) {
      c.value += 4;
      c.score += 4;
    }
  out.sort((a, b) => b.score - a.score || a.tile - b.tile);
  // Keep the choices apart from each other.
  const best: SiteChoice[] = [];
  for (const c of out) {
    if (best.length >= (opts.limit ?? 5)) break;
    if (best.every((o) => Math.hypot(tx(o.tile) - tx(c.tile), ty(o.tile) - ty(c.tile)) >= 6)) best.push(c);
  }
  for (const s of best) {
    const path: number[] = [];
    for (let k = s.tile; k >= 0; k = prev[k]) path.push(k);
    s.path = path.reverse();
    s.sea = s.path.some((k) => map.ocean[k] === 1);
  }
  return best;
}

function nextTo(set: Set<number>, i: number) {
  const x = tx(i);
  const y = ty(i);
  for (const [dx, dy] of N4) if (inBounds(x + dx, y + dy) && set.has(idx(x + dx, y + dy))) return true;
  return false;
}

/** Days to cross each step of a path. */
function stepDays(state: GameState, e: Expedition, k: number, d: Derived) {
  const map = getMap(state.seed);
  const i = e.path[k];
  const prevSea = k > 0 && map.ocean[e.path[k - 1]] === 1;
  if (map.ocean[i]) return SEA_COST;
  const c = footCost(state, i, d);
  return (isFinite(c) ? c : 1) * 0.6 + (prevSea ? LANDING_COST * 0.5 : 0);
}

// ------------------------------------------------------------------ pioneers

/** Pioneers wanted for a new settlement, and whether the realm can spare them. */
export function pioneerStatus(state: GameState, fromTown: number, sea = false): RealmResult {
  if (!hasTech(state, 'scouting')) return { ok: false, reason: 'Requires Pathfinding' };
  if (choiceOf(state, 'expansion') === 'consolidate') return { ok: false, reason: 'The Expansion policy forbids it' };
  if (state.expeditions.some((e) => e.kind === 'settle')) return { ok: false, reason: 'Pioneers are already on the road' };
  const adults = census(state).adults.get(fromTown) ?? 0;
  const need = pioneerCount(state);
  if (adults < need + 6) return { ok: false, reason: `Needs ${need + 6} adults living there` };
  const cost = expeditionCost(state, sea);
  if (!canAfford(state, cost)) return { ok: false, reason: 'Not enough supplies' };
  return { ok: true };
}

export function pioneerCount(state: GameState) {
  return PIONEERS + (choiceOf(state, 'expansion') === 'expand' ? 2 : 0);
}

export function expeditionCost(_state: GameState, sea: boolean): Cost {
  const c: Cost = { ...PIONEER_SUPPLIES };
  if (sea) for (const [r, v] of Object.entries(GALLEY_COST)) c[r as ResourceId] = (c[r as ResourceId] ?? 0) + (v ?? 0);
  return c;
}

/** Send pioneers along a path to found a settlement at its end. */
export function launchPioneers(state: GameState, _ctx: Ctx, fromTown: number, site: SiteChoice): RealmResult {
  const st = pioneerStatus(state, fromTown, site.sea);
  if (!st.ok) return st;
  pay(state, expeditionCost(state, site.sea));
  // The young and able go: adults in their prime, a few with their children.
  const able = state.settlers.filter((s) => s.town === fromTown && isAdult(state, s) && ageOf(state, s) < 40);
  able.sort((a, b) => ageOf(state, a) - ageOf(state, b) || a.id - b.id);
  const party = able.slice(0, pioneerCount(state));
  for (const s of party) {
    s.town = 0;
    s.job = null;
  }
  recount(state);
  const e: Expedition = { id: state.nextExpId++, kind: 'settle', from: fromTown, path: site.path, at: 0, step: 0, people: party.map((s) => s.id), started: state.day };
  state.expeditions.push(e);
  const home = townById(state, fromTown)!;
  const p = siteProfile(state.seed, site.tile);
  note(state, `${party.length} pioneers set out from ${home.name}${site.sea ? ' by galley across the sea' : ''}, blazing a trail toward promising ${siteCalling(p)} land ${Math.round(Math.hypot(tx(site.tile) - home.x, ty(site.tile) - home.y))} leagues away.`, 'realm');
  invalidate(state);
  return { ok: true };
}

/** Pick the best site the pioneers of a settlement know of and send them, if it is worth the journey. */
export function autoPioneers(state: GameState, ctx: Ctx, fromTown: number, minValue = 20): boolean {
  const sites = findSites(state, fromTown);
  const site = sites.find((s) => s.value >= minValue && pioneerStatus(state, fromTown, s.sea).ok);
  if (!site) return false;
  return launchPioneers(state, ctx, fromTown, site).ok;
}

/** Light a new hearth: the pioneers become its first people. */
function foundSettlement(state: GameState, ctx: Ctx, e: Expedition, rng: Rng) {
  const map = getMap(state.seed);
  const tile = e.path[e.path.length - 1];
  const used = new Set(state.towns.map((t) => t.name));
  let name = placeName(rng);
  for (let k = 0; k < 20 && used.has(name); k++) name = placeName(rng);
  const town: Settlement = { id: state.nextTownId++, name, x: tx(tile), y: ty(tile), founded: state.day, tier: 0, parent: e.from };
  state.towns.push(town);
  // The founders clear a green around their fire.
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = town.x + dx;
      const y = town.y + dy;
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (landMax(state.seed).wood[i]) clearTile(state, i);
    }
  state.trails = state.trails.filter((i) => Math.max(Math.abs(tx(i) - town.x), Math.abs(ty(i) - town.y)) > 1);
  state.buildings.push({ id: state.nextBuildingId++, type: 'campfire', x: town.x, y: town.y, progress: 0, done: true, town: town.id });
  for (const s of state.settlers) if (e.people.includes(s.id)) s.town = town.id;
  recount(state);
  reveal(state, ctx, town.x, town.y, 6);
  invalidate(state);
  ctx.fx.push({ kind: 'found', town: town.id });
  const biome = BIOMES[map.biome[tile] as Biome].name.toLowerCase();
  const island = map.island[tile] !== map.island[idx(state.towns[0].x, state.towns[0].y)];
  note(state, `The pioneers light a hearth and name their ${biome} home ${name}${island ? ', a colony across the sea' : ''}.`, 'realm');
}

// ------------------------------------------------------------------ voyages

/** Send a galley out from a harbour to chart unknown waters and coasts, and back. */
export function launchVoyage(state: GameState, fromTown: number): RealmResult {
  if (!hasTech(state, 'seafaring')) return { ok: false, reason: 'Requires Seafaring' };
  const harbours = harbourTiles(state, fromTown);
  if (!harbours.size) return { ok: false, reason: 'Needs a harbour' };
  if (state.expeditions.some((e) => e.kind === 'voyage')) return { ok: false, reason: 'A galley is already at sea' };
  const cost: Cost = { wood: 30, food: 20 };
  if (!canAfford(state, cost)) return { ok: false, reason: 'Not enough supplies' };
  const map = getMap(state.seed);
  // Flood the open sea from the harbour and make for the most promising unknown water.
  const n = MAP_W * MAP_H;
  const prev = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const q: number[] = [];
  for (const h of harbours)
    for (const [dx, dy] of N4) {
      const x = tx(h) + dx;
      const y = ty(h) + dy;
      if (!inBounds(x, y)) continue;
      const j = idx(x, y);
      if (map.ocean[j] && dist[j] < 0) (dist[j] = 0), q.push(j);
    }
  if (!q.length) return { ok: false, reason: 'The harbour has no way to the open sea' };
  let best = -1;
  let bestScore = -Infinity;
  const rng = new Rng(state.rng ^ (state.day * 2654435761));
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    if (dist[i] > 90) break;
    if (!state.explored[i] && dist[i] >= 12) {
      // Unknown water near unknown land is worth the most.
      let landNear = 0;
      for (const [dx, dy] of N8) if (inBounds(tx(i) + dx * 3, ty(i) + dy * 3) && !state.explored[idx(tx(i) + dx * 3, ty(i) + dy * 3)] && map.island[idx(tx(i) + dx * 3, ty(i) + dy * 3)] >= 0) landNear++;
      const sc = landNear * 4 + Math.min(dist[i], 50) * 0.3 + rng.next() * 6;
      if (sc > bestScore) (bestScore = sc), (best = i);
    }
    for (const [dx, dy] of N4) {
      const x = tx(i) + dx;
      const y = ty(i) + dy;
      if (!inBounds(x, y)) continue;
      const j = idx(x, y);
      if (!map.ocean[j] || dist[j] >= 0) continue;
      dist[j] = dist[i] + 1;
      prev[j] = i;
      q.push(j);
    }
  }
  if (best < 0) return { ok: false, reason: 'No unknown waters within reach' };
  const out: number[] = [];
  for (let k = best; k >= 0; k = prev[k]) out.push(k);
  out.reverse();
  pay(state, cost);
  // There and back again.
  const path = [...out, ...out.slice(0, -1).reverse()];
  state.expeditions.push({ id: state.nextExpId++, kind: 'voyage', from: fromTown, path, at: 0, step: 0, people: [], started: state.day });
  note(state, `A galley sails from ${townById(state, fromTown)!.name} to chart unknown waters.`, 'realm');
  return { ok: true };
}

// ------------------------------------------------------------------ moving expeditions

function reveal(state: GameState, ctx: Ctx, x: number, y: number, r: number) {
  for (let yy = y - r; yy <= y + r; yy++)
    for (let xx = x - r; xx <= x + r; xx++) {
      if (!inBounds(xx, yy) || Math.hypot(xx - x, yy - y) > r + 0.3) continue;
      const i = idx(xx, yy);
      if (!state.explored[i]) revealHook(state, ctx, i);
    }
}

/** Set by the simulation so expeditions reveal tiles (and their discoveries) the same way scouts do. */
let revealHook: (state: GameState, ctx: Ctx, i: number) => void = (state, _ctx, i) => {
  state.explored[i] = 1;
  state.stats.tilesExplored++;
};
export function setRevealHook(f: typeof revealHook) {
  revealHook = f;
}

function stepExpeditions(state: GameState, ctx: Ctx, rng: Rng) {
  if (!state.expeditions.length) return;
  const d = derived(state);
  const map = getMap(state.seed);
  const done: Expedition[] = [];
  for (const e of state.expeditions) {
    e.step += e.kind === 'voyage' ? 1.3 : 1;
    const trail: number[] = [];
    while (e.at < e.path.length - 1) {
      const need = stepDays(state, e, e.at + 1, d);
      if (e.step < need) break;
      e.step -= need;
      e.at++;
      const i = e.path[e.at];
      const sea = map.ocean[i] === 1;
      reveal(state, ctx, tx(i), ty(i), sea ? 3 : 2);
      if (!sea && e.kind === 'settle') trail.push(i);
    }
    if (trail.length) layTrail(state, trail);
    if (e.at >= e.path.length - 1) done.push(e);
  }
  for (const e of done) {
    state.expeditions.splice(state.expeditions.indexOf(e), 1);
    if (e.kind === 'settle') {
      if (e.people.length && state.settlers.some((s) => e.people.includes(s.id))) foundSettlement(state, ctx, e, rng);
    } else note(state, `The galley returns to ${townById(state, e.from)?.name ?? 'harbour'} with charts of new waters.`, 'realm');
  }
  if (done.length) invalidate(state);
}

/** A pioneer died on the road. If none are left, the expedition is lost. */
export function loseTraveller(state: GameState, id: number) {
  for (const e of state.expeditions) {
    const k = e.people.indexOf(id);
    if (k < 0) continue;
    e.people.splice(k, 1);
    if (!e.people.length) {
      state.expeditions.splice(state.expeditions.indexOf(e), 1);
      note(state, 'The last of the pioneers has died on the road. Their trail fades into the wilds.', 'bad');
    }
    return;
  }
}

// ------------------------------------------------------------------ trade routes

export interface RouteOption {
  a: number;
  b: number;
  kind: 'land' | 'sea';
  path: number[];
  cost: Cost;
  ok: boolean;
  reason?: string;
}

function hasRoute(state: GameState, a: number, b: number) {
  return state.routes.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
}

/** The way between two hearths along roads and trails, or null if they are not joined by land. */
function networkPath(a: Settlement, b: Settlement, d: Derived): number[] | null {
  const n = MAP_W * MAP_H;
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const s = idx(a.x, a.y);
  const goal = idx(b.x, b.y);
  const q = [s];
  seen[s] = 1;
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    if (i === goal) {
      const path: number[] = [];
      for (let p = goal; p >= 0; p = prev[p]) path.push(p);
      return path.reverse();
    }
    for (const [dx, dy] of N4) {
      const x = tx(i) + dx;
      const y = ty(i) + dy;
      if (!inBounds(x, y)) continue;
      const j = idx(x, y);
      if (seen[j] || !d.network[j]) continue;
      seen[j] = 1;
      prev[j] = i;
      q.push(j);
    }
  }
  return null;
}

/** The sea lane between two settlements' harbours, or null. */
function seaPath(state: GameState, a: number, b: number): number[] | null {
  const map = getMap(state.seed);
  const ha = harbourTiles(state, a);
  const hb = harbourTiles(state, b);
  if (!ha.size || !hb.size) return null;
  const n = MAP_W * MAP_H;
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const q: number[] = [];
  const goal = new Set<number>();
  const shore = (set: Set<number>, f: (j: number) => void) => {
    for (const h of set)
      for (const [dx, dy] of N4) {
        const x = tx(h) + dx;
        const y = ty(h) + dy;
        if (inBounds(x, y) && map.ocean[idx(x, y)]) f(idx(x, y));
      }
  };
  shore(ha, (j) => {
    if (!seen[j]) (seen[j] = 1), q.push(j);
  });
  shore(hb, (j) => goal.add(j));
  for (let k = 0; k < q.length; k++) {
    const i = q[k];
    if (goal.has(i)) {
      const path: number[] = [];
      for (let p = i; p >= 0; p = prev[p]) path.push(p);
      return path.reverse();
    }
    for (const [dx, dy] of N4) {
      const x = tx(i) + dx;
      const y = ty(i) + dy;
      if (!inBounds(x, y)) continue;
      const j = idx(x, y);
      if (seen[j] || !map.ocean[j]) continue;
      seen[j] = 1;
      prev[j] = i;
      q.push(j);
    }
  }
  return null;
}

/** Every pair of settlements a trade route could join, and whether it can be opened now. */
export function routeOptions(state: GameState): RouteOption[] {
  const d = derived(state);
  const out: RouteOption[] = [];
  for (let i = 0; i < state.towns.length; i++)
    for (let j = i + 1; j < state.towns.length; j++) {
      const a = state.towns[i];
      const b = state.towns[j];
      if (hasRoute(state, a.id, b.id)) continue;
      const land = networkPath(a, b, d);
      const kind: 'land' | 'sea' = land ? 'land' : 'sea';
      const path = land ?? seaPath(state, a.id, b.id);
      const cost = kind === 'land' ? CARAVAN_COST : GALLEY_COST;
      let reason: string | undefined;
      if (!path) reason = 'Not joined by trail, road or sea lane (sea routes need a harbour at both ends)';
      else if (kind === 'land' && !hasTech(state, 'the_wheel')) reason = 'Requires The Wheel';
      else if (kind === 'sea' && !hasTech(state, 'seafaring')) reason = 'Requires Seafaring';
      else if (a.tier < 1 || b.tier < 1) reason = 'Both must be at least villages';
      else if (!canAfford(state, cost)) reason = 'Not enough resources';
      out.push({ a: a.id, b: b.id, kind, path: path ?? [], cost, ok: !reason, reason });
    }
  return out;
}

export function openRoute(state: GameState, ctx: Ctx, a: number, b: number): RealmResult {
  const opt = routeOptions(state).find((o) => (o.a === a && o.b === b) || (o.a === b && o.b === a));
  if (!opt) return { ok: false, reason: 'No route possible' };
  if (!opt.ok) return { ok: false, reason: opt.reason ?? 'Not possible' };
  pay(state, opt.cost);
  const r: TradeRoute = { id: state.nextRouteId++, a: opt.a, b: opt.b, kind: opt.kind, path: opt.path, opened: state.day, paved: 0 };
  state.routes.push(r);
  invalidate(state);
  ctx.fx.push({ kind: 'route', route: r.id });
  const A = townById(state, opt.a)!;
  const B = townById(state, opt.b)!;
  note(state, opt.kind === 'land' ? `Carts begin to run between ${A.name} and ${B.name}. Builders will pave the trail into a road.` : `A galley now sails the sea lane between ${A.name} and ${B.name}.`, 'realm');
  return { ok: true };
}

/** Knowledge a trade route brings each day: more between bigger places, different climates and trades, and across the sea. */
export function routeIncome(state: GameState, r: TradeRoute): number {
  const A = townById(state, r.a);
  const B = townById(state, r.b);
  if (!A || !B) return 0;
  const map = getMap(state.seed);
  const d = derived(state);
  let div = 1;
  if (map.biome[idx(A.x, A.y)] !== map.biome[idx(B.x, B.y)]) div += 0.5;
  if (r.kind === 'sea') div += 0.5;
  const sa = d.towns.get(A.id)?.specialty;
  const sb = d.towns.get(B.id)?.specialty;
  if (sa && sb && sa !== sb) div += 0.25;
  return 0.08 * (A.tier + B.tier + 2) * div * fxMul(state, 'trade');
}

/** Morale from the goods and news that trade brings. */
export function tradeMorale(state: GameState) {
  return Math.min(8, state.routes.length * 2);
}

/** Builders pave land routes once the sites are seen to: trail tile by trail tile, one stone each. Returns work used. */
export function paveRoutes(state: GameState, work: number, rates?: Rates): number {
  let left = work;
  for (const r of state.routes) {
    if (r.kind !== 'land' || left <= 0) continue;
    const trails = new Set(state.trails);
    while (left > 0 && r.paved < r.path.length) {
      const i = r.path[r.paved];
      if (!trails.has(i)) {
        r.paved++;
        continue;
      }
      if (state.res.stone < PAVE_STONE) return work - left;
      const use = Math.min(left, PAVE_WORK - (r.work ?? 0));
      r.work = (r.work ?? 0) + use;
      left -= use;
      if (r.work < PAVE_WORK - 1e-9) break;
      r.work = 0;
      state.res.stone -= PAVE_STONE;
      if (rates) rates.cons.stone['Paving'] = (rates.cons.stone['Paving'] ?? 0) + PAVE_STONE;
      layRoad(state, [i]);
      r.paved++;
    }
  }
  return work - left;
}

/** Trail tiles of land routes still waiting to be paved. */
export function unpaved(state: GameState) {
  const trails = new Set(state.trails);
  let n = 0;
  for (const r of state.routes) if (r.kind === 'land') for (let k = r.paved; k < r.path.length; k++) if (trails.has(r.path[k])) n++;
  return n;
}

// ------------------------------------------------------------------ the council's realm

/** What a settlement's land is best for, as the buildings that would make the most of it. */
export function townCalling(state: GameState, town: Settlement): BuildingId[] {
  const p = siteProfile(state.seed, idx(town.x, town.y));
  const want: [BuildingId, number][] = [
    ['farm', p.farming * 0.45],
    ['lumber', p.timber * 0.8],
    ['quarry', p.stone * 0.9],
    ['mine', p.ore * 1.1],
    ['lodge', p.game],
    ['harbour', p.coast ? 3 + p.fish : 0],
    ['pasture', p.farming * 0.25],
  ];
  const ok = (t: BuildingId) => !BUILDING_DEFS[t].tech || hasTech(state, BUILDING_DEFS[t].tech!);
  return want.filter(([t, v]) => v > 2.5 && ok(t)).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/** Most settlements the realm will aim for in each age, before the Expansion policy. */
const TOWN_CAP = [1, 2, 4, 6, 8];

/** The council's work beyond the capital: pioneers, voyages and trade routes. */
function councilRealm(state: GameState, ctx: Ctx) {
  if (!state.council.build || state.day % 5 !== 0) return;
  const policy = choiceOf(state, 'expansion');
  const pop = state.settlers.length;
  const era = eraOf(state);
  // Pioneers, when the realm is big enough to spare them.
  const cap = TOWN_CAP[Math.min(era, TOWN_CAP.length - 1)] + (policy === 'expand' ? 2 : 0);
  if (policy !== 'consolidate' && state.towns.length < cap && pop >= (policy === 'expand' ? 18 : 24) && state.day % 10 === 0 && state.hunger < 0.02) {
    const c = census(state);
    const from = [...state.towns].sort((a, b) => (c.adults.get(b.id) ?? 0) - (c.adults.get(a.id) ?? 0))[0];
    if (from && state.res.food > 80 + pop * 2) autoPioneers(state, ctx, from.id);
  }
  // Galleys chart the seas now and then.
  if (hasTech(state, 'seafaring') && state.day % 60 === 0 && state.res.wood > 80) {
    const port = state.buildings.find((b) => b.type === 'harbour' && b.done);
    if (port?.town) launchVoyage(state, port.town);
  }
  // Trade routes, cheapest first, when the stores are comfortable.
  if (state.day % 15 === 0) {
    const opt = routeOptions(state).find((o) => o.ok && Object.entries(o.cost).every(([r, v]) => state.res[r as ResourceId] >= (v ?? 0) * 2.5));
    if (opt) openRoute(state, ctx, opt.a, opt.b);
  }
}

// ------------------------------------------------------------------ the day

/** Everything the realm does in a day: expeditions move, people resettle, settlements grow, trade flows. */
export function realmDay(state: GameState, ctx: Ctx, rng: Rng) {
  councilRealm(state, ctx);
  stepExpeditions(state, ctx, rng);
  if (state.day % 5 === 0) migrate(state);
  if (state.day % 2 === 0) updateTiers(state, ctx);
}

/** Daily knowledge from trade. */
export function tradeKnowledge(state: GameState) {
  let k = 0;
  for (const r of state.routes) k += routeIncome(state, r);
  return k;
}

/** Years since a settlement was founded. */
export function townAge(state: GameState, t: Settlement) {
  return Math.floor((state.day - t.founded) / DAYS_PER_YEAR);
}

export { hearthOf };
