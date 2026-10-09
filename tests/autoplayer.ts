/**
 * A simple heuristic bot that plays the game through the same actions a player uses.
 * Used by the balance tests to prove a settlement can be played from start to victory.
 */
import { BUILDING_DEFS, TECH_ORDER } from '../src/game/data';
import { buildingAvailability, choose, placeBuilding, research, setJobTarget, techStatus } from '../src/game/actions';
import { canPlace, derived } from '../src/game/derived';
import { getMap, MAP_W_H, tx, ty } from './util';
import { eraOf, hasTech, seasonIndex } from '../src/game/state';
import { popSummary, type TickContext } from '../src/game/sim';
import type { BuildingId, GameState, JobId } from '../src/game/types';
import { JOBS } from '../src/game/types';

function bestTile(state: GameState, type: BuildingId): number | null {
  const map = getMap(state.seed);
  const start = map.start;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < MAP_W_H; i++) {
    const c = canPlace(state, type, i);
    if (!c.ok) continue;
    const dist = Math.hypot(tx(i) - tx(start), ty(i) - ty(start));
    const score = c.mult * 10 - dist * (type === 'hut' || type === 'house' ? 1 : 0.4);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function tryBuild(state: GameState, type: BuildingId): boolean {
  if (!buildingAvailability(state, type).ok) return false;
  const t = bestTile(state, type);
  if (t === null) return false;
  return placeBuilding(state, type, t, tx(t), ty(t)).ok;
}

function target_gatherers(state: GameState) {
  return state.settlers.filter((x) => x.job === 'gatherer').length;
}

export function botStep(state: GameState, ctx: TickContext) {
  const d = derived(state);
  const era = eraOf(state);
  const pop = state.settlers.length;
  const c = d.counts;
  const all = (t: BuildingId) => state.buildings.filter((b) => b.type === t).length;

  if (state.choice) {
    // Accept affordable trades and refugees, fight raiders only with towers.
    const opts = state.choice.options;
    let pick = opts.length - 1;
    if (state.choice.id === 'refugees' && state.res.food > 60) pick = 0;
    if (state.choice.id === 'raiders') pick = (c.watchtower ?? 0) >= 2 ? 0 : 1;
    choose(state, ctx, pick);
  }

  // Research: era advances first, then cheapest available.
  for (const t of TECH_ORDER) {
    if (t.startsWith('era_') && techStatus(state, t).ok) research(state, t, ctx.fx);
  }
  const avail = TECH_ORDER.filter((t) => techStatus(state, t).ok && !t.startsWith('era_'));
  avail.sort((a, b) => 0 * a.length + 0 * b.length);
  // Hold some knowledge for the next era advance once pop requirement is near.
  for (const t of avail) research(state, t, ctx.fx);

  const sites = d.sites.length;
  const freeHousing = d.housing - pop;
  if (freeHousing < 4 && sites < 2) {
    if (!(hasTech(state, 'masonry') && tryBuild(state, 'house'))) tryBuild(state, 'hut');
  }
  if (sites < 1 || (sites < 2 && pop > 30)) {
    const wish: [BuildingId, number][] = [
      ['lumber', 1],
      ['quarry', 1],
      ['lodge', 1],
      ['storehouse', 1],
      ['farm', 2],
      ['granary', 1],
      ['lumber', 2],
      ['watchtower', 1],
      ['quarry', 2],
      ['herbalist', 1],
      ['farm', 4],
      ['pasture', 1],
      ['storehouse', 2],
      ['mine', 1],
      ['smithy', 1],
      ['library', 1],
      ['granary', 2],
      ['quarry', 3],
      ['mine', 2],
      ['farm', 6],
      ['lumber', 3],
      ['library', 2],
      ['smithy', 2],
      ['storehouse', 4],
      ['watchtower', 2],
      ['shrine', 1],
      ['herbalist', 2],
      ['farm', 8],
      ['quarry', 4],
      ['mine', 3],
      ['storehouse', 6],
      ['monument', 1],
      ['storehouse', 9],
    ];
    const farmPressure = hasTech(state, 'agriculture') && target_gatherers(state) > 4;
    const builtFarm = farmPressure && tryBuild(state, 'farm');
    for (const [t, n] of builtFarm ? [] : wish) {
      if (all(t) >= n) continue;
      if (t === 'storehouse' && all('storehouse') >= 1 && state.res.wood < d.caps.wood * 0.7 && state.res.stone < d.caps.stone * 0.7 && !hasTech(state, 'architecture')) continue;
      const unlocked = !BUILDING_DEFS[t].tech || hasTech(state, BUILDING_DEFS[t].tech!);
      if (!unlocked) continue;
      if (bestTile(state, t) === null) continue;
      if (tryBuild(state, t)) break;
      break; // wait for resources
    }
  }

  // Jobs
  const ps = popSummary(state);
  let adults = ps.adults;
  const target = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  const take = (j: JobId, n: number) => {
    const k = Math.max(0, Math.min(adults, Math.floor(n), d.slots[j]));
    target[j] += k;
    adults -= k;
  };
  const monument = state.buildings.find((b) => b.type === 'monument' && !b.done);
  take('healer', Math.ceil(pop / 14));
  const unexplored = state.explored.filter((x) => !x).length;
  take('scout', unexplored > 200 && ps.adults >= 8 ? (era === 0 ? 1 : 2) : 0);
  const foodNeed = ps.adults * 0.9 + ps.children * 0.5 + ps.elders * 0.7;
  const full = state.res.food >= d.caps.food * 0.9 && seasonIndex(state.day) < 2;
  const low = state.res.food < d.caps.food * 0.5;
  let want = foodNeed * (full ? 0.85 : low ? 1.4 : 1.15) - (c.pasture ?? 0) * 1.5;
  const foodBudget = Math.max(4, ps.adults * (low || state.hunger > 0 ? 0.85 : 0.62));
  const food0 = adults;
  const cap = (n: number) => Math.min(n, foodBudget - (food0 - adults));
  take('farmer', cap(Math.ceil(want / 3.6)));
  want -= target.farmer * 3.6;
  take('hunter', cap(Math.ceil(Math.max(0, want) / 1.9)));
  want -= target.hunter * 1.9;
  take('gatherer', cap(Math.ceil(Math.max(0, want) / 1.6)));
  take('woodcutter', 1);
  take('builder', sites ? (monument ? Math.max(3, ps.adults * 0.3) : Math.max(1, ps.adults * 0.1)) : 0);
  take('scholar', 1);
  const rest = adults;
  take('scholar', rest * 0.35);
  take('quarrier', rest * 0.2);
  take('miner', rest * 0.15);
  take('smith', rest * 0.12);
  take('woodcutter', rest * 0.15);
  take('scholar', adults);
  take('quarrier', adults);
  take('woodcutter', adults);
  take('gatherer', adults);
  for (const j of JOBS) setJobTarget(state, j, target[j]);
}
