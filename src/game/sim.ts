import {
  ADULT_AGE,
  BUILDING_DEFS,
  DAYS_PER_YEAR,
  ELDER_AGE,
  JOB_DEFS,
  PARTY_SIZE,
} from './data';
import { census, derived, invalidate, jobUnlocked, type SlotGroup } from './derived';
import { worksQueue } from './actions';
import { centerOf, drawFrom, fellLeft, growLand, landFrac, landMax, prepareSite } from './land';
import { inParty, loseTraveller, paveRoutes, realmDay, setRevealHook, townWithRoom, tradeKnowledge, tradeMorale } from './realm';
import { scoutDay } from './scouting';
import { runCouncil } from './council';
import { fxAdd, fxMul } from './decisions';
import { resolveChoice, rollEvent } from './events';
import { getMap, idx, inBounds } from './map';
import { checkObjectives } from './objectives';
import { Rng } from './rng';
import { ageOf, eraOf, hasTech, makeSettler, seasonIndex } from './state';
import type { BuildingId, FxEvent, GameState, JobId, LandLayer, LogEntry, Rates, ResourceId, Settler } from './types';
import { F, JOBS, RESOURCES } from './types';

export interface TickContext {
  fx: FxEvent[];
  rates?: Rates;
  /** Offline catch-up: no disasters or choices, gentler starvation. */
  offline?: boolean;
}

const SEASON_MULT: Partial<Record<JobId, number[]>> = {
  gatherer: [1.0, 1.2, 1.1, 0.35],
  hunter: [1.0, 1.0, 1.1, 0.75],
  farmer: [0.9, 1.2, 1.3, 0.15],
};

export function log(state: GameState, text: string, kind: LogEntry['kind'] = 'info') {
  state.log.push({ day: state.day, text, kind });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

export function emptyRates(): Rates {
  const mk = () => Object.fromEntries(RESOURCES.map((r) => [r, {}])) as Rates['prod'];
  return { prod: mk(), cons: mk() };
}

function modMult(state: GameState, key: string): number {
  let m = 1;
  for (const mod of state.modifiers) if (mod.effects[key] !== undefined && key !== 'morale') m *= mod.effects[key];
  return m;
}

function modAdd(state: GameState, key: string): number {
  let m = 0;
  for (const mod of state.modifiers) if (mod.effects[key] !== undefined) m += mod.effects[key];
  return m;
}

export function legacyMult(state: GameState) {
  return 1 + 0.1 * state.legacy;
}

export function productivity(state: GameState) {
  return 0.8 + 0.4 * (state.morale / 100);
}

/** Jobs whose work goes better with a good tool to hand. */
export const TOOL_JOBS: readonly JobId[] = JOBS.filter((j) => JOB_DEFS[j].usesTools);

/** Days a tool lasts in use, on average. */
export const TOOL_LIFE = 1 / 0.006;

/** Workers at jobs that use tools: as many as the council (or you) has asked for. */
export function toolUsers(state: GameState): number {
  let n = 0;
  for (const j of TOOL_JOBS) n += state.jobTargets[j] ?? 0;
  return n;
}

/** Share of them with a tool to hand: each one in use takes one from the stores. */
export function toolShare(state: GameState): number {
  const users = toolUsers(state);
  if (users <= 0) return state.res.tools >= 1 ? 1 : 0;
  return Math.min(1, state.res.tools / users);
}

/** Output multiplier from tools, for the share of labourers who have them (iron tools are better). */
export function toolBonus(state: GameState) {
  return 1 + (hasTech(state, 'iron') ? 0.4 : 0.2) * toolShare(state);
}

/** Multiplier from techs for a job. */
export function techMult(state: GameState, j: JobId): number {
  let m = 1;
  const h = (t: Parameters<typeof hasTech>[1]) => hasTech(state, t);
  switch (j) {
    case 'gatherer':
      break;
    case 'woodcutter':
      if (h('stone_tools')) m += 0.2;
      break;
    case 'hunter':
      if (h('hunting_traps')) m += 0.15;
      if (h('husbandry')) m += 0.15;
      break;
    case 'farmer':
      if (h('the_wheel')) m += 0.1;
      if (h('plough')) m += 0.4;
      break;
    case 'quarrier':
      if (h('masonry')) m += 0.25;
      break;
    case 'smith':
      if (h('iron')) m += 0.6;
      break;
    case 'scholar':
      if (h('oral_tradition')) m += 0.25;
      if (h('writing')) m += 0.25;
      if (h('mathematics')) m += 0.15;
      break;
    case 'builder':
      if (h('the_wheel')) m += 0.5;
      if (h('mathematics')) m += 0.3;
      break;
    case 'scout':
      if (h('scouting')) m += 0.5;
      break;
    case 'healer':
      if (h('medicine')) m += 0.5;
      break;
  }
  return m * fxMul(state, j);
}

/** Total output units for n workers of a job (before the job's base rate). season -1 = yearly average. */
export function jobOutput(state: GameState, j: JobId, n: number, season: number): number {
  if (n <= 0) return 0;
  const sm = season < 0 ? (SEASON_MULT[j] ? SEASON_MULT[j]!.reduce((a, b) => a + b, 0) / 4 : 1) : (SEASON_MULT[j]?.[season] ?? 1);
  const prodMult = productivity(state) * legacyMult(state);
  return n * sm * techMult(state, j) * slotMult(state, j, n) * prodMult * (JOB_DEFS[j].usesTools ? toolBonus(state) : 1) * modMult(state, j);
}

/** Base daily rate of a job's main product. */
export function baseRate(j: JobId): number {
  const o = JOB_DEFS[j].output;
  const v = Object.values(o)[0];
  return v ?? 1;
}

/** Work needed to finish a building, after decision effects. */
export function buildWork(state: GameState, type: BuildingId): number {
  const w = BUILDING_DEFS[type].work;
  return type === 'monument' ? Math.round(w * fxMul(state, 'monumentWork')) : w;
}

export function buildMaterials(state: GameState, type: BuildingId): Partial<Record<ResourceId, number>> | undefined {
  const m = BUILDING_DEFS[type].materials;
  if (!m) return undefined;
  const f = type === 'monument' ? fxMul(state, 'monumentMat') : 1;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round((v ?? 0) * f)]));
}

/** Running totals over a job's slot groups: workers, and their summed multipliers, before each group. */
const slotTotals = new WeakMap<SlotGroup[], { count: Float64Array; sum: Float64Array }>();

function totalsOf(groups: SlotGroup[]) {
  let t = slotTotals.get(groups);
  if (t) return t;
  const count = new Float64Array(groups.length + 1);
  const sum = new Float64Array(groups.length + 1);
  for (let k = 0; k < groups.length; k++) {
    count[k + 1] = count[k] + groups[k].count;
    sum[k + 1] = sum[k] + groups[k].count * groups[k].mult;
  }
  slotTotals.set(groups, (t = { count, sum }));
  return t;
}

/** Average building multiplier for the first n workers of a job (best buildings fill first). */
export function slotMult(state: GameState, j: JobId, n: number): number {
  if (n <= 0) return 1;
  const groups = derived(state).slotGroups[j];
  if (!groups.length) return 1;
  const { count, sum } = totalsOf(groups);
  // The last group that fills completely.
  let lo = 0;
  let hi = groups.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (count[mid] <= n) lo = mid;
    else hi = mid - 1;
  }
  const left = n - count[lo];
  // Overflow past every slot (should not happen with slot caps) counts as plain work.
  const total = lo < groups.length ? sum[lo] + left * groups[lo].mult : sum[lo] + left;
  return total / n;
}

/**
 * Foraging: the open land feeds about ten gatherers; each berry thicket and fishing water in your
 * territory feeds two more while it is full, less as it is picked or fished out.
 */
export function forage(state: GameState) {
  const map = getMap(state.seed);
  const terr = derived(state).territory;
  const fx = fxMul(state, 'forage');
  const tiles: number[] = [];
  let feat = 0;
  for (const i of landMax(state.seed).lifeTiles) {
    const f = map.feature[i];
    if ((f !== F.Berries && f !== F.Fish) || !terr[i] || !state.explored[i]) continue;
    tiles.push(i);
    feat += 2 * landFrac(state, 'life', i);
  }
  return { base: 10 * fx, feat: feat * fx, tiles };
}

export function gathererCapacity(state: GameState) {
  const f = forage(state);
  return Math.round(f.base + f.feat);
}

/** Workers of a job per building, best buildings first (as slotMult assumes). */
export function allocation(state: GameState, j: JobId, n: number) {
  const out: { building: number | null; count: number; mult: number }[] = [];
  let left = n;
  for (const g of derived(state).slotGroups[j]) {
    if (left <= 0) break;
    const k = Math.min(left, g.count);
    out.push({ building: g.building, count: k, mult: g.mult });
    left -= k;
  }
  return out;
}

/** Share of a job's full output the land currently supports (1 = plenty). */
export function yieldEff(state: GameState, j: JobId) {
  return state.eff?.[j] ?? 1;
}

/**
 * Output of an extracting job, taken from the land around each workplace. What the land cannot
 * supply is replaced by `fallback` of it (deadwood, small game). Nothing is taken once the stores are full.
 */
function extract(state: GameState, j: JobId, n: number, season: number, layer: LandLayer, perUnit: number, room: number, fallback: number, minShare = 0) {
  if (n <= 0) return { got: 0, full: 0 };
  const full = jobOutput(state, j, n, season) * baseRate(j);
  const want = Math.min(full, Math.max(0, room, full * minShare));
  if (want <= 0.0001) return { got: 0, full };
  const d = derived(state);
  const groups = allocation(state, j, n);
  const weight = groups.reduce((s, g) => s + g.count * g.mult, 0) || 1;
  let got = 0;
  for (const g of groups) {
    const share = (want * g.count * g.mult) / weight;
    const tiles = g.building !== null ? (d.catchments[layer].get(g.building) ?? []) : [];
    const taken = drawFrom(state, layer, tiles, share * perUnit) / perUnit;
    got += taken + (share - taken) * fallback;
  }
  state.eff[j] = yieldEff(state, j) * 0.9 + (got / want) * 0.1;
  return { got, full };
}

/** Food and hides from the herds bred on pastures. */
export function pastureYield(state: GameState, season: number) {
  let herd = 0;
  for (const b of state.buildings) if (b.type === 'pasture' && b.done) herd += (b.stock ?? 4) / PASTURE_HERD;
  const pm = legacyMult(state) * fxMul(state, 'pasture');
  return { food: herd * 1.8 * (season === 3 ? 0.6 : 1) * pm, hides: herd * 0.15 * pm };
}

export const PASTURE_HERD = 12;

/** Assign adults to jobs according to targets and available slots. Keeps existing assignments stable. */
export function assignJobs(state: GameState) {
  const d = derived(state);
  const counts = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  const idle: Settler[] = [];
  const away = inParty(state);
  for (const s of state.settlers) {
    const age = ageOf(state, s);
    if (age < ADULT_AGE || age >= ELDER_AGE || !s.town) {
      s.job = null;
      continue;
    }
    if (away.has(s.id)) {
      // Out in the wilds: still a scout until they are home.
      s.job = 'scout';
      counts.scout++;
      continue;
    }
    if (s.job) {
      const limit = Math.min(state.jobTargets[s.job], d.slots[s.job]);
      if (counts[s.job] < limit && jobUnlocked(state, s.job)) {
        counts[s.job]++;
        continue;
      }
      s.job = null;
    }
    idle.push(s);
  }
  for (const j of JOBS) {
    const limit = Math.min(state.jobTargets[j], d.slots[j]);
    while (counts[j] < limit && idle.length) {
      (j === 'scout' ? nextScout(state, idle) : idle.pop()!).job = j;
      counts[j]++;
    }
  }
  return counts;
}

/** Scouts go out together: fill up a party in one settlement before starting another. */
function nextScout(state: GameState, idle: Settler[]): Settler {
  const per = new Map<number, number>();
  for (const s of state.settlers) if (s.job === 'scout') per.set(s.town, (per.get(s.town) ?? 0) + 1);
  let k = idle.findIndex((s) => (per.get(s.town) ?? 0) % PARTY_SIZE !== 0);
  if (k < 0) k = idle.length - 1;
  return idle.splice(k, 1)[0];
}

export interface PopSummary {
  total: number;
  children: number;
  adults: number;
  elders: number;
  idle: number;
  /** Pioneers on the road. */
  away: number;
  jobs: Record<JobId, number>;
}

export function foodDemand(state: GameState, pop: { adults: number; children: number; elders: number; away?: number }) {
  return (pop.adults * 0.9 + pop.children * 0.5 + pop.elders * 0.7 + (pop.away ?? 0) * 0.9) * fxMul(state, 'foodUse');
}

export function popSummary(state: GameState): PopSummary {
  const jobs = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  let children = 0;
  let adults = 0;
  let elders = 0;
  let idle = 0;
  let away = 0;
  for (const s of state.settlers) {
    const a = ageOf(state, s);
    if (!s.town) away++;
    else if (a < ADULT_AGE) children++;
    else if (a >= ELDER_AGE) elders++;
    else {
      adults++;
      if (s.job) jobs[s.job]++;
      else idle++;
    }
  }
  return { total: state.settlers.length, children, adults, elders, idle, away, jobs };
}

function add(rates: Rates | undefined, kind: 'prod' | 'cons', r: ResourceId, src: string, amt: number) {
  if (!rates || amt === 0) return;
  rates[kind][r][src] = (rates[kind][r][src] ?? 0) + amt;
}

export function lifeShift(state: GameState) {
  return (hasTech(state, 'medicine') ? 9 : 0) + fxAdd(state, 'life');
}

/** Annual mortality hazard for a given age. */
export function hazard(state: GameState, age: number, care: number): number {
  let h: number;
  if (age < 1) h = 0.05;
  else if (age < ADULT_AGE) h = 0.006;
  else h = 0.004;
  h += 0.012 * Math.exp((age - (48 + lifeShift(state))) / 7.5);
  return h * (1 - 0.45 * care);
}

/** Healer coverage 0..1 (one healer cares for ~12 people). */
export function careLevel(state: GameState, healers: number) {
  const pop = Math.max(1, state.settlers.length);
  return Math.min(1, (healers * 12 * techMult(state, 'healer')) / pop);
}

export function moraleTarget(state: GameState, hungerNow: number, coldNow: number) {
  const d = derived(state);
  const pop = state.settlers.length;
  const homeless = Math.max(0, pop - d.housing);
  let m = 52 + 3 * eraOf(state);
  m += Math.min(3, d.counts.shrine ?? 0) * 8;
  m += 4 * state.claimed.filter((i) => getMap(state.seed).feature[i] === F.Grove).length;
  if (hasTech(state, 'faith')) m += 5;
  m += 2 * state.legacy;
  m -= 40 * hungerNow;
  m -= 25 * coldNow;
  m -= Math.min(25, (homeless / Math.max(1, pop)) * 60);
  m += tradeMorale(state);
  m += modAdd(state, 'morale');
  m += fxAdd(state, 'morale');
  return Math.max(0, Math.min(100, m));
}

/** Advance the simulation by one day. */
export function tick(state: GameState, ctx: TickContext) {
  if (state.defeat) return;
  const rng = new Rng(state.rng);
  const rates = ctx.rates;
  state.day++;
  const season = seasonIndex(state.day);
  state.modifiers = state.modifiers.filter((m) => m.until > state.day);

  runCouncil(state, ctx);
  realmDay(state, ctx, rng);
  const d = derived(state);
  const jobs = assignJobs(state);
  const pop = popSummary(state);

  const prodMult = productivity(state) * legacyMult(state);
  const out = (j: JobId, n: number) => jobOutput(state, j, n, season);

  const gain: Partial<Record<ResourceId, number>> = {};
  const produce = (r: ResourceId, src: string, amt: number) => {
    gain[r] = (gain[r] ?? 0) + amt;
    add(rates, 'prod', r, src, amt);
  };

  // --- needs (computed first so workers stop taking from the land once the stores are full)
  const foodNeed = foodDemand(state, pop);
  let heatNeed = 0;
  if (season === 3) {
    const stoneFrac = Math.min(1, d.stoneHousing / Math.max(1, pop.total));
    heatNeed = pop.total * 0.13 * (hasTech(state, 'furs') ? 0.6 : 1) * (1 - 0.5 * stoneFrac) * modMult(state, 'heating');
  }
  const room = (r: ResourceId, use = 0) => d.caps[r] - state.res[r] - (gain[r] ?? 0) + use + 1;

  // --- production
  {
    // Gatherers: the open land feeds a few; berry thickets and fishing waters feed more until picked out.
    const n = jobs.gatherer;
    const fo = forage(state);
    const onBase = Math.min(n, fo.base);
    let onFeat = Math.min(n - onBase, fo.feat);
    const over = n - onBase - onFeat;
    if (onFeat > 0) onFeat = drawFrom(state, 'life', fo.tiles, onFeat * 0.8) / 0.8;
    const eff = onBase + onFeat + Math.max(0, over) * 0.4;
    produce('food', 'Gatherers', out('gatherer', 1) * eff * 1.8);
  }
  produce('food', 'Idle foragers', pop.idle * 0.45 * (SEASON_MULT.gatherer![season]) * prodMult);
  produce('food', 'Farmers', out('farmer', jobs.farmer) * 4.2);
  // Pastures: the herd grows through the warm seasons and its surplus is eaten.
  for (const b of state.buildings) {
    if (b.type !== 'pasture' || !b.done) continue;
    b.stock ??= 4;
    if (season < 3) b.stock = Math.min(PASTURE_HERD, b.stock + 0.06 * b.stock * (1 - b.stock / PASTURE_HERD));
  }
  const py = pastureYield(state, season);
  if (py.food) {
    produce('food', 'Pastures', py.food);
    produce('hides', 'Pastures', py.hides);
  }
  {
    // Hunters take from the wild herds near their lodge; small game makes up a little when herds are thin.
    const h = extract(state, 'hunter', jobs.hunter, season, 'life', 0.1, room('food', foodNeed), 0.4, 0.25);
    produce('food', 'Hunters', h.got);
    if (h.full > 0) produce('hides', 'Hunters', (h.got / 1.7) * 0.14 * (1 / Math.max(0.3, SEASON_MULT.hunter![season])));
  }
  produce('wood', 'Woodcutters', extract(state, 'woodcutter', jobs.woodcutter, season, 'wood', 1, room('wood', heatNeed + jobs.smith * 0.25), 0.2).got);
  produce('stone', 'Quarriers', extract(state, 'quarrier', jobs.quarrier, season, 'stone', 1, room('stone'), 0).got);
  produce('ore', 'Miners', extract(state, 'miner', jobs.miner, season, 'ore', 1, room('ore', jobs.smith * 0.4), 0).got);
  {
    // Smiths are limited by ore and wood on hand.
    const want = out('smith', jobs.smith);
    const oreNeed = jobs.smith * 0.4;
    const woodNeed = jobs.smith * 0.25;
    const frac = jobs.smith ? Math.min(1, state.res.ore / Math.max(0.001, oreNeed), state.res.wood / Math.max(0.001, woodNeed)) : 0;
    if (frac > 0) {
      produce('tools', 'Smiths', want * 0.22 * frac);
      gain.ore = (gain.ore ?? 0) - oreNeed * frac;
      gain.wood = (gain.wood ?? 0) - woodNeed * frac;
      add(rates, 'cons', 'ore', 'Smiths', oreNeed * frac);
      add(rates, 'cons', 'wood', 'Smiths', woodNeed * frac);
    }
  }
  {
    const libs = d.counts.library ?? 0;
    const kf = fxMul(state, 'knowledge');
    const k = out('scholar', jobs.scholar) * 0.26 * (1 + 0.1 * libs) * kf;
    produce('knowledge', 'Scholars', k);
    const elderK = pop.elders * (hasTech(state, 'oral_tradition') ? 0.08 : 0.03) * legacyMult(state) * kf;
    produce('knowledge', 'Elders', elderK);
    if (state.routes.length) produce('knowledge', 'Trade', tradeKnowledge(state) * kf);
  }

  // --- the land: worked-out quarries and mines, and regrowth
  {
    const dd = derived(state);
    for (const b of state.buildings) {
      if (b.spent || !dd.spent.has(b.id)) continue;
      b.spent = true;
      log(state, `The ${BUILDING_DEFS[b.type].name.toLowerCase()} at ${b.x},${b.y} has been worked out. Its workers must dig elsewhere.`, 'bad');
    }
    growLand(state, season, { replant: dd.replant, occupied: dd.occupied, sites: dd.siteMask, trail: dd.trail, regrow: fxMul(state, 'regrow'), replanting: fxMul(state, 'replant') > 0 });
  }

  // --- consumption
  add(rates, 'cons', 'food', 'Eating', foodNeed);
  if (heatNeed) add(rates, 'cons', 'wood', 'Firewood', heatNeed);
  // Tools wear out as they are used: the ones in workers' hands, not those still on the shelves.
  const inHand = Math.min(state.res.tools, TOOL_JOBS.reduce((s, j) => s + jobs[j], 0));
  const toolWear = (inHand / TOOL_LIFE) * fxMul(state, 'toolWear');
  if (toolWear) add(rates, 'cons', 'tools', 'Wear', toolWear);

  // --- apply
  for (const r of RESOURCES) state.res[r] += gain[r] ?? 0;
  state.res.tools -= toolWear;
  state.res.food -= foodNeed;
  let hungerNow = 0;
  if (state.res.food < 0) {
    hungerNow = Math.min(1, -state.res.food / Math.max(0.1, foodNeed));
    state.res.food = 0;
  }
  state.res.wood -= heatNeed;
  let coldNow = 0;
  if (state.res.wood < 0) {
    coldNow = Math.min(1, -state.res.wood / Math.max(0.1, heatNeed));
    state.res.wood = 0;
  }
  state.hunger = state.hunger * 0.6 + hungerNow * 0.4;
  state.cold = season === 3 ? state.cold * 0.6 + coldNow * 0.4 : state.cold * 0.5;
  for (const r of RESOURCES) {
    state.res[r] = Math.max(0, Math.min(d.caps[r], state.res[r]));
  }

  // --- construction: the works queue, one site after another. A site's trees are felled and its rock
  // levelled before the building itself goes up; hands only move on when a site waits for materials.
  {
    const work = out('builder', jobs.builder) * 1 + pop.idle * 0.3 * prodMult;
    let left = work;
    for (const b of worksQueue(state)) {
      if (left <= 0) break;
      if (fellLeft(state, b) > 1e-6 || (b.prep ?? 0) > 1e-6) {
        const r = prepareSite(state, b, left);
        left -= r.used;
        if (r.wood) add(rates, 'prod', 'wood', 'Clearing sites', r.wood);
        if (r.stone) add(rates, 'prod', 'stone', 'Levelling', r.stone);
        if (fellLeft(state, b) > 1e-6 || (b.prep ?? 0) > 1e-6) continue;
      }
      const def = BUILDING_DEFS[b.type];
      const total = buildWork(state, b.type);
      const mats = buildMaterials(state, b.type);
      const need = total - b.progress;
      const used = Math.max(0, Math.min(need, left, materialLimit(state, b.type)));
      if (mats) {
        for (const [r, amt] of Object.entries(mats)) {
          const k = r as ResourceId;
          const take = ((amt ?? 0) / total) * used;
          state.res[k] = Math.max(0, state.res[k] - take);
          add(rates, 'cons', k, def.name, take);
        }
      }
      b.progress += used;
      left -= used;
      if (used < need && mats && left > 0) continue; // stalled for materials: let other sites use the hands
      if (b.progress >= total - 1e-9) {
        b.done = true;
        b.progress = total;
        delete b.order;
        state.stats.buildingsBuilt++;
        invalidate(state);
        ctx.fx.push({ kind: 'built', building: b.id });
        if (b.type === 'monument') {
          log(state, `The Sunspire is complete! Its light can be seen for a hundred leagues. ${state.name} will be remembered forever.`, 'era');
          if (!state.victory) {
            state.victory = true;
            state.stats.victoryDay = state.day;
          }
        } else {
          const town = state.towns.length > 1 ? state.towns.find((t) => t.id === b.town) : null;
          log(state, `A ${def.name} has been completed${town ? ` in ${town.name}` : ''}.`, 'build');
        }
        if (b.type === 'watchtower') {
          const [cx, cy] = centerOf(b);
          revealAround(state, ctx, rng, Math.round(cx), Math.round(cy), 5);
        }
      }
    }
    // Spare hands pave the trade routes' trails into roads.
    if (left > 0 && state.routes.length) paveRoutes(state, left, rates);
  }

  // --- exploration: scouting parties set out, march, camp and come home with their charts
  scoutDay(state, ctx, rng, (s, cause) => killSettler(state, ctx, s, cause));

  // --- population: births, where there is a free home in the mother's settlement
  {
    const c = census(state);
    const free = new Map<number, number>();
    for (const t of state.towns) free.set(t.id, (d.towns.get(t.id)?.housing ?? 0) - (c.residents.get(t.id) ?? 0));
    const foodF = state.hunger > 0.05 ? 0.1 : state.res.food < state.settlers.length * 3 ? 0.5 : 1;
    const moraleF = Math.max(0.25, Math.min(1.4, state.morale / 55));
    const rate = (0.3 / DAYS_PER_YEAR) * foodF * moraleF * modMult(state, 'births') * fxMul(state, 'births');
    const mothers = state.settlers.filter((s) => s.f && s.town && ageOf(state, s) >= 16 && ageOf(state, s) < 42);
    for (const mother of mothers) {
      const room = free.get(mother.town) ?? 0;
      const housingF = room <= 0 ? 0 : Math.min(1, room / 3);
      if (!rng.chance(rate * housingF)) continue;
      free.set(mother.town, room - 1);
      const child = makeSettler(state, rng, state.day, mother.gen + 1, mother.town);
      state.settlers.push(child);
      state.stats.births++;
      state.stats.maxGen = Math.max(state.stats.maxGen, child.gen);
      ctx.fx.push({ kind: 'birth', settler: child.id });
      log(state, `${child.name} was born to ${mother.name}.`, 'birth');
    }
  }

  // --- population: deaths
  {
    const care = careLevel(state, jobs.healer);
    const homelessFrac = Math.max(0, state.settlers.length - d.housing) / Math.max(1, state.settlers.length);
    const starve = state.hunger * (ctx.offline ? 0.4 : 1);
    const dead: { s: Settler; cause: string }[] = [];
    for (const s of state.settlers) {
      const age = ageOf(state, s);
      let p = (hazard(state, age, care) * (1 + homelessFrac)) / DAYS_PER_YEAR;
      let cause = age >= 45 ? 'old age' : 'illness';
      const frail = age < ADULT_AGE || age >= ELDER_AGE ? 1.5 : 1;
      const ps = 0.012 * starve * frail;
      const pc = season === 3 ? 0.004 * state.cold * frail * (hasTech(state, 'furs') ? 0.5 : 1) : 0;
      if (ps > p) cause = 'starvation';
      if (pc > Math.max(p, ps)) cause = 'the cold';
      p += ps + pc;
      if (rng.chance(p)) dead.push({ s, cause });
    }
    for (const { s, cause } of dead) killSettler(state, ctx, s, cause);
  }

  // --- morale
  {
    const target = moraleTarget(state, state.hunger, state.cold);
    state.morale += (target - state.morale) * 0.1;
  }

  // --- events
  if (!ctx.offline || rng.chance(0.5)) rollEvent(state, ctx, rng);
  if (state.choice && state.day >= state.choice.expires) {
    // Auto-resolve with the final (cautious) option.
    resolveChoice(state, ctx, state.choice.options.length - 1);
  }

  state.rng = rng.state;
  state.stats.peakPop = Math.max(state.stats.peakPop, state.settlers.length);
  checkObjectives(state);
  if (state.settlers.length === 0 && !state.defeat) {
    state.defeat = true;
    log(state, `The last fire of ${state.name} has gone cold.`, 'bad');
  }
}

/** How much work the stockpile can currently support for a site that consumes materials as it rises. */
export function materialLimit(state: GameState, type: BuildingId): number {
  const mats = buildMaterials(state, type);
  if (!mats) return Infinity;
  const work = buildWork(state, type);
  let lim = Infinity;
  for (const [r, amt] of Object.entries(mats)) {
    const per = (amt ?? 0) / work;
    if (per > 0) lim = Math.min(lim, state.res[r as ResourceId] / per);
  }
  return lim;
}

export function killSettler(state: GameState, ctx: TickContext, s: Settler, cause: string) {
  const i = state.settlers.indexOf(s);
  if (i < 0) return;
  state.settlers.splice(i, 1);
  loseTraveller(state, s.id);
  state.stats.deaths++;
  ctx.fx.push({ kind: 'death', settler: s.id });
  const age = Math.floor(ageOf(state, s));
  const role = s.job ? ` the ${JOB_DEFS[s.job].name}` : age < ADULT_AGE ? ', a child,' : age >= ELDER_AGE ? ' the Elder' : '';
  log(state, `${s.name}${role} died of ${cause} at age ${age}.`, 'death');
}

export function addSettlers(state: GameState, ctx: TickContext, rng: Rng, n: number, minAge = 16, maxAge = 34, town = townWithRoom(state)) {
  for (let k = 0; k < n; k++) {
    const age = rng.int(minAge, maxAge);
    const s = makeSettler(state, rng, state.day - age * DAYS_PER_YEAR - rng.int(0, DAYS_PER_YEAR - 1), Math.max(1, state.stats.maxGen - 1), town);
    state.settlers.push(s);
    ctx.fx.push({ kind: 'birth', settler: s.id });
  }
  state.stats.immigrants += n;
  ctx.fx.push({ kind: 'arrive', count: n });
}

// ---------------------------------------------------------------- exploration

export function revealAround(state: GameState, ctx: TickContext, rng: Rng, x: number, y: number, r: number) {
  for (let yy = y - r; yy <= y + r; yy++)
    for (let xx = x - r; xx <= x + r; xx++) {
      if (!inBounds(xx, yy) || Math.hypot(xx - x, yy - y) > r + 0.3) continue;
      const i = idx(xx, yy);
      if (!state.explored[i]) revealTile(state, ctx, rng, i);
    }
}

export function revealTile(state: GameState, ctx: TickContext, rng: Rng, i: number) {
  state.explored[i] = 1;
  state.stats.tilesExplored++;
  const map = getMap(state.seed);
  const f = map.feature[i] as F;
  if (f === F.None || state.claimed.includes(i)) return;
  discover(state, ctx, rng, i, f);
}

function discover(state: GameState, ctx: TickContext, rng: Rng, i: number, f: F) {
  const era = eraOf(state);
  const claim = () => state.claimed.push(i);
  switch (f) {
    case F.Ruins: {
      const k = Math.round((15 + era * 35 + rng.int(0, 10)) * fxMul(state, 'discovery'));
      state.res.knowledge += k;
      claim();
      log(state, `Scouts uncovered ancient ruins covered in strange carvings. (+${k} knowledge)`, 'discovery');
      break;
    }
    case F.Tribe: {
      const n = Math.round(rng.int(2, 4) * fxMul(state, 'discovery'));
      addSettlers(state, ctx, rng, n, 14, 36);
      claim();
      log(state, `Scouts met a band of ${n} wanderers who agreed to join ${state.name}!`, 'discovery');
      break;
    }
    case F.Cache: {
      const caps = derived(state).caps;
      const r = rng.pick(['wood', 'stone', 'food', 'hides'] as const);
      const amt = Math.round((r === 'hides' ? 15 : 40) * (1 + era * 0.8) * fxMul(state, 'discovery'));
      state.res[r] = Math.min(caps[r], state.res[r] + amt);
      claim();
      log(state, `Scouts found a forgotten cache of supplies. (+${amt} ${r})`, 'discovery');
      break;
    }
    case F.Grove: {
      claim();
      log(state, 'Scouts found a Sacred Grove. Its tranquillity lifts everyone’s spirits. (+4 morale)', 'discovery');
      break;
    }
    case F.Ore:
      claim();
      log(state, 'Scouts spotted a rich ore vein glinting in the rock. A mine built on it would yield double.', 'discovery');
      break;
    case F.Game:
      claim();
      log(state, 'Scouts found the trails of a large game herd. Hunting lodges nearby will prosper.', 'discovery');
      break;
    default:
      return;
  }
  ctx.fx.push({ kind: 'discover', tile: i });
}

// Pioneers, galleys and the charts scouts bring home reveal the land, discoveries and all.
setRevealHook((state, ctx, i) => revealTile(state, ctx, new Rng((state.rng ^ (i * 2654435761)) | 0), i));
