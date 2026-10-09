import {
  ADULT_AGE,
  BUILDING_DEFS,
  DAYS_PER_YEAR,
  ELDER_AGE,
  EXPLORE_COST,
  JOB_DEFS,
  MAP_H,
  MAP_W,
} from './data';
import { derived, invalidate, jobUnlocked } from './derived';
import { resolveChoice, rollEvent } from './events';
import { getMap, idx, inBounds, N4, tx, ty } from './map';
import { checkObjectives } from './objectives';
import { Rng } from './rng';
import { ageOf, eraOf, hasTech, makeSettler, seasonIndex } from './state';
import type { BuildingId, FxEvent, GameState, JobId, LogEntry, Rates, ResourceId, Settler } from './types';
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

export function toolBonus(state: GameState) {
  if (state.res.tools < 1) return 1;
  return hasTech(state, 'iron') ? 1.4 : 1.2;
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
  return m;
}

/** Average building multiplier for the first n workers of a job (best buildings fill first). */
export function slotMult(state: GameState, j: JobId, n: number): number {
  if (n <= 0) return 1;
  const groups = derived(state).slotGroups[j];
  if (!groups.length) return 1;
  let left = n;
  let sum = 0;
  for (const g of groups) {
    const take = Math.min(left, g.count);
    sum += take * g.mult;
    left -= take;
    if (!left) break;
  }
  sum += left; // overflow (should not happen with slot caps)
  return sum / n;
}

function featuresInTerritory(state: GameState, f: F): number {
  const map = getMap(state.seed);
  const terr = derived(state).territory;
  let n = 0;
  for (let i = 0; i < map.feature.length; i++) if (map.feature[i] === f && terr[i] && state.explored[i]) n++;
  return n;
}

export function gathererCapacity(state: GameState) {
  return 10 + 2 * featuresInTerritory(state, F.Berries) + 2 * featuresInTerritory(state, F.Fish);
}

/** Assign adults to jobs according to targets and available slots. Keeps existing assignments stable. */
export function assignJobs(state: GameState) {
  const d = derived(state);
  const counts = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  const idle: Settler[] = [];
  for (const s of state.settlers) {
    const age = ageOf(state, s);
    if (age < ADULT_AGE || age >= ELDER_AGE) {
      s.job = null;
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
      idle.pop()!.job = j;
      counts[j]++;
    }
  }
  return counts;
}

export interface PopSummary {
  total: number;
  children: number;
  adults: number;
  elders: number;
  idle: number;
  jobs: Record<JobId, number>;
}

export function popSummary(state: GameState): PopSummary {
  const jobs = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  let children = 0;
  let adults = 0;
  let elders = 0;
  let idle = 0;
  for (const s of state.settlers) {
    const a = ageOf(state, s);
    if (a < ADULT_AGE) children++;
    else if (a >= ELDER_AGE) elders++;
    else {
      adults++;
      if (s.job) jobs[s.job]++;
      else idle++;
    }
  }
  return { total: state.settlers.length, children, adults, elders, idle, jobs };
}

function add(rates: Rates | undefined, kind: 'prod' | 'cons', r: ResourceId, src: string, amt: number) {
  if (!rates || amt === 0) return;
  rates[kind][r][src] = (rates[kind][r][src] ?? 0) + amt;
}

export function lifeShift(state: GameState) {
  return hasTech(state, 'medicine') ? 9 : 0;
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
  m += modAdd(state, 'morale');
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

  const d = derived(state);
  const jobs = assignJobs(state);
  const pop = popSummary(state);

  const prodMult = productivity(state) * legacyMult(state);
  const tools = toolBonus(state);
  const out = (j: JobId, n: number) => {
    const sm = SEASON_MULT[j]?.[season] ?? 1;
    return n * sm * techMult(state, j) * slotMult(state, j, n) * prodMult * (JOB_DEFS[j].usesTools ? tools : 1) * modMult(state, j);
  };

  const gain: Partial<Record<ResourceId, number>> = {};
  const produce = (r: ResourceId, src: string, amt: number) => {
    gain[r] = (gain[r] ?? 0) + amt;
    add(rates, 'prod', r, src, amt);
  };

  // --- production
  {
    const n = jobs.gatherer;
    const cap = gathererCapacity(state);
    const eff = n <= cap ? n : cap + (n - cap) * 0.4;
    produce('food', 'Gatherers', out('gatherer', 1) * eff * 1.8);
  }
  produce('food', 'Idle foragers', pop.idle * 0.45 * (SEASON_MULT.gatherer![season]) * prodMult);
  produce('food', 'Hunters', out('hunter', jobs.hunter) * 1.7);
  produce('hides', 'Hunters', out('hunter', jobs.hunter) * 0.14 * (1 / Math.max(0.3, SEASON_MULT.hunter![season])));
  produce('food', 'Farmers', out('farmer', jobs.farmer) * 4.2);
  produce('wood', 'Woodcutters', out('woodcutter', jobs.woodcutter) * 0.9);
  produce('stone', 'Quarriers', out('quarrier', jobs.quarrier) * 0.6);
  produce('ore', 'Miners', out('miner', jobs.miner) * 0.38);
  const pastures = d.counts.pasture ?? 0;
  if (pastures) {
    produce('food', 'Pastures', pastures * 1.6 * (season === 3 ? 0.6 : 1) * legacyMult(state));
    produce('hides', 'Pastures', pastures * 0.15 * legacyMult(state));
  }
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
    const k = out('scholar', jobs.scholar) * 0.26 * (1 + 0.1 * libs);
    produce('knowledge', 'Scholars', k);
    const elderK = pop.elders * (hasTech(state, 'oral_tradition') ? 0.08 : 0.03) * legacyMult(state);
    produce('knowledge', 'Elders', elderK);
  }

  // --- consumption
  const foodNeed = pop.adults * 0.9 + pop.children * 0.5 + pop.elders * 0.7;
  add(rates, 'cons', 'food', 'Eating', foodNeed);
  let heatNeed = 0;
  if (season === 3) {
    const stoneFrac = Math.min(1, d.stoneHousing / Math.max(1, pop.total));
    heatNeed = pop.total * 0.13 * (hasTech(state, 'furs') ? 0.6 : 1) * (1 - 0.5 * stoneFrac) * modMult(state, 'heating');
    add(rates, 'cons', 'wood', 'Firewood', heatNeed);
  }
  const toolUsers = JOBS.filter((j) => JOB_DEFS[j].usesTools).reduce((s, j) => s + jobs[j], 0);
  const toolWear = state.res.tools >= 1 ? toolUsers * 0.006 : 0;
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

  // --- construction
  {
    const work = out('builder', jobs.builder) * 1 + pop.idle * 0.3 * prodMult;
    let left = work;
    for (const b of state.buildings) {
      if (b.done || left <= 0) continue;
      const def = BUILDING_DEFS[b.type];
      const need = def.work - b.progress;
      const used = Math.min(need, left, materialLimit(state, b.type));
      if (def.materials) {
        for (const [r, amt] of Object.entries(def.materials)) {
          const k = r as ResourceId;
          const take = ((amt ?? 0) / def.work) * used;
          state.res[k] = Math.max(0, state.res[k] - take);
          add(rates, 'cons', k, def.name, take);
        }
      }
      b.progress += used;
      left -= used;
      if (used < need && def.materials && left > 0) break; // stalled for materials: don't skip ahead in the queue
      if (b.progress >= def.work - 1e-9) {
        b.done = true;
        b.progress = def.work;
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
          log(state, `A ${def.name} has been completed.`, 'build');
        }
        if (b.type === 'watchtower') revealAround(state, ctx, rng, b.x, b.y, 5);
      }
    }
  }

  // --- exploration
  {
    const pts = out('scout', jobs.scout) * 1;
    if (pts > 0) explore(state, ctx, rng, pts);
  }

  // --- population: births
  {
    const free = d.housing - state.settlers.length;
    const housingF = free <= 0 ? 0 : Math.min(1, free / 3);
    const foodF = state.hunger > 0.05 ? 0.1 : state.res.food < state.settlers.length * 3 ? 0.5 : 1;
    const moraleF = Math.max(0.25, Math.min(1.4, state.morale / 55));
    const rate = (0.3 / DAYS_PER_YEAR) * housingF * foodF * moraleF * modMult(state, 'births');
    const mothers = state.settlers.filter((s) => s.f && ageOf(state, s) >= 16 && ageOf(state, s) < 42);
    for (const mother of mothers) {
      if (!rng.chance(rate)) continue;
      const child = makeSettler(state, rng, state.day, mother.gen + 1);
      state.settlers.push(child);
      state.stats.births++;
      state.stats.maxGen = Math.max(state.stats.maxGen, child.gen);
      ctx.fx.push({ kind: 'birth', settler: child.id });
      log(state, `${child.name} was born to ${mother.name}.`, 'birth');
      if (state.settlers.length >= d.housing) break;
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
  const def = BUILDING_DEFS[type];
  if (!def.materials) return Infinity;
  let lim = Infinity;
  for (const [r, amt] of Object.entries(def.materials)) {
    const per = (amt ?? 0) / def.work;
    if (per > 0) lim = Math.min(lim, state.res[r as ResourceId] / per);
  }
  return lim;
}

export function killSettler(state: GameState, ctx: TickContext, s: Settler, cause: string) {
  const i = state.settlers.indexOf(s);
  if (i < 0) return;
  state.settlers.splice(i, 1);
  state.stats.deaths++;
  ctx.fx.push({ kind: 'death', settler: s.id });
  const age = Math.floor(ageOf(state, s));
  const role = s.job ? ` the ${JOB_DEFS[s.job].name}` : age < ADULT_AGE ? ', a child,' : age >= ELDER_AGE ? ' the Elder' : '';
  log(state, `${s.name}${role} died of ${cause} at age ${age}.`, 'death');
}

export function addSettlers(state: GameState, ctx: TickContext, rng: Rng, n: number, minAge = 16, maxAge = 34) {
  for (let k = 0; k < n; k++) {
    const age = rng.int(minAge, maxAge);
    const s = makeSettler(state, rng, state.day - age * DAYS_PER_YEAR - rng.int(0, DAYS_PER_YEAR - 1), Math.max(1, state.stats.maxGen - 1));
    state.settlers.push(s);
    ctx.fx.push({ kind: 'birth', settler: s.id });
  }
  state.stats.immigrants += n;
  ctx.fx.push({ kind: 'arrive', count: n });
}

// ---------------------------------------------------------------- exploration

export function frontier(state: GameState): number[] {
  const out: number[] = [];
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++) {
      const i = idx(x, y);
      if (state.explored[i]) continue;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (inBounds(nx, ny) && state.explored[idx(nx, ny)]) {
          out.push(i);
          break;
        }
      }
    }
  return out;
}

function nextExploreTile(state: GameState, rng: Rng): number | null {
  const map = getMap(state.seed);
  const f = frontier(state);
  if (!f.length) return null;
  const target = state.exploreTarget ?? map.start;
  const txx = tx(target);
  const tyy = ty(target);
  let best = -1;
  let bestScore = Infinity;
  for (const i of f) {
    const score = Math.hypot(tx(i) - txx, ty(i) - tyy) + rng.next() * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function explore(state: GameState, ctx: TickContext, rng: Rng, pts: number) {
  const map = getMap(state.seed);
  state.exploreProgress += pts;
  for (let guard = 0; guard < 20; guard++) {
    const next = nextExploreTile(state, rng);
    if (next === null) {
      state.exploreProgress = 0;
      return;
    }
    const cost = EXPLORE_COST[map.terrain[next]];
    if (state.exploreProgress < cost) return;
    state.exploreProgress -= cost;
    revealTile(state, ctx, rng, next);
    if (state.exploreTarget !== null && state.explored[state.exploreTarget]) {
      state.exploreTarget = null;
      log(state, 'Your scouts have reached the marked lands.', 'info');
    }
  }
}

export function revealAround(state: GameState, ctx: TickContext, rng: Rng, x: number, y: number, r: number) {
  for (let yy = y - r; yy <= y + r; yy++)
    for (let xx = x - r; xx <= x + r; xx++) {
      if (!inBounds(xx, yy) || Math.hypot(xx - x, yy - y) > r + 0.3) continue;
      const i = idx(xx, yy);
      if (!state.explored[i]) revealTile(state, ctx, rng, i);
    }
}

function revealTile(state: GameState, ctx: TickContext, rng: Rng, i: number) {
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
      const k = Math.round(15 + era * 35 + rng.int(0, 10));
      state.res.knowledge += k;
      claim();
      log(state, `Scouts uncovered ancient ruins covered in strange carvings. (+${k} knowledge)`, 'discovery');
      break;
    }
    case F.Tribe: {
      const n = rng.int(2, 4);
      addSettlers(state, ctx, rng, n, 14, 36);
      claim();
      log(state, `Scouts met a band of ${n} wanderers who agreed to join ${state.name}!`, 'discovery');
      break;
    }
    case F.Cache: {
      const caps = derived(state).caps;
      const r = rng.pick(['wood', 'stone', 'food', 'hides'] as const);
      const amt = Math.round((r === 'hides' ? 15 : 40) * (1 + era * 0.8));
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
