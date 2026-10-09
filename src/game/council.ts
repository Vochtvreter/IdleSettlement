/**
 * The council runs the settlement day to day so the player can focus on decisions.
 * It assigns work, raises buildings and pursues discoveries according to the
 * chosen focus, policies and tweaks. It is deterministic so it also runs offline.
 */
import { buildingAvailability, placeBuilding, research, setJobTarget, techStatus } from './actions';
import { BUILDING_DEFS, MAP_H, MAP_W, TECH_DEFS, TECH_ORDER } from './data';
import { choiceOf, nextPath, pathRequirements, tweak } from './decisions';
import { canAfford, canPlace, derived } from './derived';
import { getMap, tx, ty } from './map';
import { baseRate, foodDemand, jobOutput, popSummary, type TickContext } from './sim';
import { eraOf, hasTech, seasonIndex } from './state';
import type { BuildingId, Cost, GameState, JobId, ResourceId, TechId } from './types';
import { F, JOBS, T } from './types';

type Focus = 'balanced' | 'growth' | 'industry' | 'knowledge' | 'explore';

export function focusOf(state: GameState): Focus {
  return (choiceOf(state, 'focus') ?? 'balanced') as Focus;
}

export function runCouncil(state: GameState, ctx: TickContext) {
  if (state.council.research) councilResearch(state, ctx);
  if (state.council.build && state.day % 2 === 0) councilBuild(state);
  if (state.council.jobs) councilJobs(state);
}

// ------------------------------------------------------------------ research

const FOCUS_TECHS: Record<Focus, TechId[]> = {
  balanced: ['stone_tools', 'agriculture', 'pottery', 'mining', 'bronze', 'writing'],
  growth: ['hunting_traps', 'furs', 'agriculture', 'pottery', 'herbalism', 'husbandry', 'masonry', 'medicine', 'plough'],
  industry: ['stone_tools', 'mining', 'bronze', 'masonry', 'the_wheel', 'iron', 'mathematics'],
  knowledge: ['oral_tradition', 'writing', 'mathematics', 'scouting'],
  explore: ['scouting', 'hunting_traps', 'the_wheel', 'oral_tradition'],
};

/** Resources the council keeps aside for the next era path once its other requirements are met. */
export function savingFor(state: GameState): Cost | null {
  const p = nextPath(state);
  if (!p?.tech) return null;
  if (!pathRequirements(state, p).ready) return null;
  return TECH_DEFS[p.tech].cost;
}

function councilResearch(state: GameState, ctx: TickContext) {
  const saving = savingFor(state);
  const affordableWithSaving = (cost: Cost) =>
    Object.entries(cost).every(([r, n]) => state.res[r as ResourceId] - (n ?? 0) >= (saving?.[r as ResourceId] ?? 0));
  const ok = (t: TechId) => !t.startsWith('era_') && techStatus(state, t).ok && affordableWithSaving(TECH_DEFS[t].cost);
  if (state.pin && state.techs.includes(state.pin)) state.pin = null;
  if (state.pin) {
    // While a discovery is pinned, knowledge is saved for it.
    if (ok(state.pin)) {
      research(state, state.pin, ctx.fx);
      state.pin = null;
    }
    return;
  }
  const prefer = FOCUS_TECHS[focusOf(state)];
  const candidates = TECH_ORDER.filter(ok);
  if (!candidates.length) return;
  const score = (t: TechId) => (TECH_DEFS[t].cost.knowledge ?? 0) * (prefer.includes(t) ? 0.5 : 1);
  candidates.sort((a, b) => score(a) - score(b));
  research(state, candidates[0], ctx.fx);
}

// ------------------------------------------------------------------ building

function bestTile(state: GameState, type: BuildingId): number | null {
  const map = getMap(state.seed);
  const hearth = state.buildings.find((b) => b.type === 'campfire')!;
  const d = derived(state);
  let best: number | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    if (!d.territory[i]) continue;
    const c = canPlace(state, type, i);
    if (!c.ok) continue;
    const dist = Math.hypot(tx(i) - hearth.x, ty(i) - hearth.y);
    const homey = type === 'hut' || type === 'house';
    let score = c.mult * 10 - dist * (homey ? 1 : 0.35);
    // Keep valuable spots free: ore veins for mines, open fields for farms.
    if (map.feature[i] === F.Ore && type !== 'mine') score -= 30;
    if (type !== 'farm' && type !== 'pasture' && (map.terrain[i] === T.Grass || map.terrain[i] === T.Meadow) && hasTech(state, 'agriculture')) score -= 1.5;
    // The Sunspire wants room to be seen: avoid the crowded centre.
    if (type === 'monument') score = -Math.abs(dist - 4);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function count(state: GameState, t: BuildingId) {
  return state.buildings.filter((b) => b.type === t).length;
}

function fitsCaps(state: GameState, cost: Cost) {
  const caps = derived(state).caps;
  return Object.entries(cost).every(([r, n]) => (n ?? 0) <= caps[r as ResourceId]);
}

type Plan = [BuildingId, number][];

const PLANS: Record<Focus, Plan> = {
  balanced: [
    ['lumber', 1], ['quarry', 1], ['lodge', 1], ['storehouse', 1], ['farm', 2], ['granary', 1], ['lumber', 2], ['watchtower', 1],
    ['quarry', 2], ['herbalist', 1], ['farm', 4], ['pasture', 1], ['storehouse', 2], ['mine', 1], ['smithy', 1], ['library', 1],
    ['granary', 2], ['quarry', 3], ['mine', 2], ['farm', 6], ['lumber', 3], ['library', 2], ['smithy', 2], ['storehouse', 4],
    ['watchtower', 2], ['shrine', 1], ['herbalist', 2], ['quarry', 4], ['mine', 3], ['storehouse', 6], ['shrine', 2],
  ],
  growth: [
    ['lodge', 1], ['lumber', 1], ['quarry', 1], ['storehouse', 1], ['farm', 3], ['granary', 1], ['herbalist', 1], ['pasture', 2],
    ['lumber', 2], ['farm', 5], ['granary', 2], ['quarry', 2], ['watchtower', 1], ['mine', 1], ['smithy', 1], ['library', 1],
    ['herbalist', 2], ['shrine', 1], ['farm', 8], ['storehouse', 3], ['mine', 2], ['smithy', 2], ['quarry', 3], ['storehouse', 5], ['shrine', 3],
  ],
  industry: [
    ['lumber', 1], ['quarry', 1], ['lumber', 2], ['storehouse', 1], ['quarry', 2], ['lodge', 1], ['farm', 2], ['granary', 1],
    ['storehouse', 2], ['mine', 1], ['smithy', 1], ['mine', 2], ['quarry', 3], ['smithy', 2], ['watchtower', 1], ['farm', 4],
    ['herbalist', 1], ['library', 1], ['mine', 3], ['lumber', 3], ['quarry', 4], ['storehouse', 5], ['smithy', 3], ['storehouse', 7],
  ],
  knowledge: [
    ['lumber', 1], ['quarry', 1], ['lodge', 1], ['storehouse', 1], ['farm', 2], ['granary', 1], ['library', 1], ['library', 2],
    ['quarry', 2], ['herbalist', 1], ['farm', 4], ['mine', 1], ['smithy', 1], ['library', 3], ['watchtower', 1], ['storehouse', 3],
    ['shrine', 1], ['mine', 2], ['quarry', 3], ['farm', 6], ['storehouse', 5],
  ],
  explore: [
    ['lumber', 1], ['lodge', 1], ['quarry', 1], ['watchtower', 1], ['storehouse', 1], ['farm', 2], ['granary', 1], ['watchtower', 2],
    ['lumber', 2], ['quarry', 2], ['herbalist', 1], ['farm', 4], ['mine', 1], ['smithy', 1], ['library', 1], ['watchtower', 3],
    ['storehouse', 3], ['mine', 2], ['quarry', 3], ['farm', 6], ['storehouse', 5],
  ],
};

/** The next building the council wants, and whether it is merely waiting for resources. */
export function councilWish(state: GameState): { type: BuildingId; waiting: boolean } | null {
  const d = derived(state);
  const pop = state.settlers.length;
  const unlocked = (t: BuildingId) => !BUILDING_DEFS[t].tech || hasTech(state, BUILDING_DEFS[t].tech!);
  const wish = (t: BuildingId) => {
    if (!unlocked(t)) return null;
    if (BUILDING_DEFS[t].max !== undefined && count(state, t) >= BUILDING_DEFS[t].max!) return null;
    if (!fitsCaps(state, BUILDING_DEFS[t].cost)) return null;
    if (bestTile(state, t) === null) return null;
    return { type: t, waiting: !canAfford(state, BUILDING_DEFS[t].cost) };
  };

  // 1. Homes, so families can grow.
  const planned = d.sites.reduce((s, b) => s + (BUILDING_DEFS[b.type].housing ?? 0), 0);
  const headroom = tweak(state, 'housing') + (focusOf(state) === 'growth' ? 3 : 0);
  if (d.housing + planned - pop < headroom) {
    const w = (hasTech(state, 'masonry') && wish('house')) || wish('hut');
    if (w) return w;
  }
  // 2. The great work.
  if (hasTech(state, 'architecture') && !count(state, 'monument')) {
    const w = wish('monument');
    if (w) return w;
  }
  // 3. Storage pressure.
  const full = (r: ResourceId) => state.res[r] >= d.caps[r] * 0.95;
  if ((full('wood') || full('stone') || full('ore') || full('tools')) && count(state, 'storehouse') < 3 + eraOf(state) * 2) {
    const w = wish('storehouse');
    if (w && !w.waiting) return w;
  }
  if (full('food') && hasTech(state, 'pottery') && seasonIndex(state.day) < 3) {
    const w = wish('granary');
    if (w && !w.waiting) return w;
  }
  // 4. Feed people with farms instead of foragers.
  if (hasTech(state, 'agriculture')) {
    const foragers = state.settlers.filter((s) => s.job === 'gatherer').length;
    if (foragers > 4) {
      const w = wish('farm');
      if (w) return w;
    }
  }
  // 5. The focus plan.
  for (const [t, n] of PLANS[focusOf(state)]) {
    if (count(state, t) >= n) continue;
    const w = wish(t);
    if (!w) continue;
    return w;
  }
  // 6. Late game: keep adding storage so the Sunspire's appetite can be met.
  if (hasTech(state, 'architecture')) {
    const w = wish('storehouse');
    if (w) return w;
  }
  return null;
}

function councilBuild(state: GameState) {
  const d = derived(state);
  const pop = state.settlers.length;
  const maxSites = pop > 60 ? 3 : pop > 18 ? 2 : 1;
  const sites = d.sites.filter((b) => b.type !== 'monument').length;
  if (sites >= maxSites) return;
  const w = councilWish(state);
  if (!w || w.waiting) return;
  if (!buildingAvailability(state, w.type).ok) return;
  const t = bestTile(state, w.type);
  if (t === null) return;
  placeBuilding(state, w.type, t, tx(t), ty(t));
}

// ------------------------------------------------------------------ work

const FOCUS_SPLIT: Record<Focus, Partial<Record<JobId, number>>> = {
  balanced: { scholar: 0.32, quarrier: 0.2, woodcutter: 0.16, miner: 0.16, smith: 0.16 },
  growth: { scholar: 0.25, woodcutter: 0.25, quarrier: 0.25, miner: 0.12, smith: 0.13 },
  industry: { scholar: 0.22, quarrier: 0.26, woodcutter: 0.16, miner: 0.2, smith: 0.16 },
  knowledge: { scholar: 0.55, quarrier: 0.15, woodcutter: 0.1, miner: 0.1, smith: 0.1 },
  explore: { scholar: 0.35, quarrier: 0.2, woodcutter: 0.15, miner: 0.15, smith: 0.15 },
};

/** Average daily food from one more worker of a job, given current bonuses. */
function foodPer(state: GameState, j: JobId, n: number) {
  return (jobOutput(state, j, Math.max(1, n + 1), -1) / Math.max(1, n + 1)) * baseRate(j);
}

function councilJobs(state: GameState) {
  const d = derived(state);
  const ps = popSummary(state);
  const focus = focusOf(state);
  const season = seasonIndex(state.day);
  let adults = ps.adults;
  const target = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  const take = (j: JobId, n: number) => {
    const k = Math.max(0, Math.min(adults, Math.floor(n + 1e-9), d.slots[j] - target[j]));
    target[j] += k;
    adults -= k;
    return k;
  };
  const pop = state.settlers.length;

  take('healer', Math.ceil(pop / 14));

  // Food: cover today's needs first, then build toward the winter reserve.
  const need = foodDemand(state, ps);
  const reserve = Math.min(d.caps.food * 0.9, need * (tweak(state, 'reserve') + 2));
  const stock = state.res.food;
  const full = stock >= d.caps.food * 0.92;
  let base = full ? 0.8 : stock < need * 5 ? 1.15 : 1;
  if (state.hunger > 0.02) base = 2;
  if (season === 3) base = stock < need * 3 ? Math.max(base, 1.4) : Math.min(base, 1);
  const pasture = (d.counts.pasture ?? 0) * 1.4;
  const foodCap = Math.max(Math.min(4, ps.adults), Math.ceil(ps.adults * (state.hunger > 0.02 || stock < need * 4 ? 0.9 : 0.7)));
  let produced = pasture;
  let foodWorkers = 0;
  const fillFood = (goal: number) => {
    for (const j of ['farmer', 'hunter', 'gatherer'] as JobId[]) {
      while (produced < goal && foodWorkers < foodCap && target[j] < d.slots[j] && adults > 0) {
        produced += foodPer(state, j, target[j]);
        take(j, 1);
        foodWorkers++;
      }
    }
  };
  fillFood(need * base);

  // Essentials: firewood and a storyteller.
  const heat = pop * 0.13 * 0.3;
  const woodLow = state.res.wood < d.caps.wood * 0.3;
  take('woodcutter', Math.max(1, Math.ceil((heat + (woodLow ? ps.adults * 0.04 : 0)) / foodPerResource(state, 'woodcutter'))));

  // Builders before storytellers: an unbuilt site helps no one.
  const sites = d.sites.length;
  const monument = d.sites.some((b) => b.type === 'monument');
  if (sites) take('builder', Math.max(1, ps.adults * Math.max(tweak(state, 'builders') / 100, monument ? 0.3 : 0)));
  take('scholar', 1);

  // Stock up for winter when there is room in the stores.
  if (!full && stock < reserve && season !== 3) fillFood(need * (1.35 + (focus === 'growth' ? 0.1 : 0)));

  // Exploration
  const unexplored = MAP_W * MAP_H - state.stats.tilesExplored;
  if (unexplored > 40 && ps.adults >= (focus === 'explore' ? 5 : 8)) take('scout', tweak(state, 'scouts') + (focus === 'explore' ? 2 : 0));

  // Split the rest by focus
  const rest = adults;
  const split = { ...FOCUS_SPLIT[focus] };
  if (monument) {
    split.quarrier = (split.quarrier ?? 0) + 0.15;
    split.miner = (split.miner ?? 0) + 0.08;
    split.smith = (split.smith ?? 0) + 0.08;
  }
  for (const [j, w] of Object.entries(split)) take(j as JobId, rest * (w ?? 0));
  // Leftovers: whatever has room, in focus order
  for (const j of ['scholar', 'quarrier', 'woodcutter', 'miner', 'smith', 'hunter', 'farmer', 'gatherer'] as JobId[]) take(j, adults);

  for (const j of JOBS) setJobTarget(state, j, target[j]);
}

function foodPerResource(state: GameState, j: JobId) {
  return Math.max(0.1, (jobOutput(state, j, 1, -1) || 1) * baseRate(j));
}
