import { BUILDING_DEFS, ERAS, JOB_DEFS, TECH_DEFS } from './data';
import { buildingCount, canAfford, canPlace, derived, invalidate, pay, refund } from './derived';
import { resolveChoice } from './events';
import { clearTile, layRoad, roadPath } from './land';
import { idx } from './map';
import { checkObjectives } from './objectives';
import { eraOf, hasTech } from './state';
import { log, type TickContext } from './sim';
import type { BuildingId, FxEvent, GameState, JobId, TechId } from './types';

export type ActionResult = { ok: true } | { ok: false; reason: string };

export function buildingUnlocked(state: GameState, type: BuildingId) {
  const t = BUILDING_DEFS[type].tech;
  return !t || hasTech(state, t);
}

export function buildingAvailability(state: GameState, type: BuildingId): ActionResult {
  const def = BUILDING_DEFS[type];
  if (!buildingUnlocked(state, type)) return { ok: false, reason: `Requires ${TECH_DEFS[def.tech!].name}` };
  if (def.max !== undefined && buildingCount(state, type) >= def.max) return { ok: false, reason: 'Limit reached' };
  if (!canAfford(state, def.cost)) return { ok: false, reason: 'Not enough resources' };
  return { ok: true };
}

export function placeBuilding(state: GameState, type: BuildingId, tile: number, x: number, y: number): ActionResult {
  const avail = buildingAvailability(state, type);
  if (!avail.ok) return avail;
  const check = canPlace(state, type, tile);
  if (!check.ok) return check;
  // Every building is joined to the hearth by a road; somewhere a road cannot reach cannot be built.
  const road = roadPath(state, tile);
  if (!road) return { ok: false, reason: 'No road can reach this spot' };
  pay(state, BUILDING_DEFS[type].cost);
  clearTile(state, tile);
  state.buildings.push({ id: state.nextBuildingId++, type, x, y, progress: 0, done: false });
  layRoad(state, road);
  invalidate(state);
  if (state.jobTargets.builder === 0 && derived(state).sites.length === 1) {
    // Helpful nudge: ensure at least one builder is wanted once construction begins.
    state.jobTargets.builder = 1;
  }
  return { ok: true };
}

export function cancelBuilding(state: GameState, id: number): ActionResult {
  const b = state.buildings.find((x) => x.id === id);
  if (!b || b.done) return { ok: false, reason: 'Not a construction site' };
  state.buildings.splice(state.buildings.indexOf(b), 1);
  refund(state, BUILDING_DEFS[b.type].cost, 0.75);
  invalidate(state);
  return { ok: true };
}

/** Demolish a finished building (not the hearth or the Sunspire). Refunds a quarter of the cost. */
export function demolishBuilding(state: GameState, id: number): ActionResult {
  const b = state.buildings.find((x) => x.id === id);
  if (!b || !b.done) return { ok: false, reason: 'Nothing to demolish' };
  if (b.type === 'campfire' || b.type === 'monument') return { ok: false, reason: 'This cannot be demolished' };
  state.buildings.splice(state.buildings.indexOf(b), 1);
  refund(state, BUILDING_DEFS[b.type].cost, 0.25);
  invalidate(state);
  return { ok: true };
}

export function techStatus(state: GameState, t: TechId): ActionResult & { visible: boolean } {
  const def = TECH_DEFS[t];
  const era = eraOf(state);
  if (hasTech(state, t)) return { ok: false, reason: 'Known', visible: true };
  if (def.era > era) return { ok: false, reason: `Requires the ${ERAS[def.era].name}`, visible: false };
  const missing = (def.requires ?? []).filter((r) => !hasTech(state, r));
  if (missing.length) return { ok: false, reason: `Requires ${missing.map((m) => TECH_DEFS[m].name).join(', ')}`, visible: true };
  if (def.minPop && state.settlers.length < def.minPop) return { ok: false, reason: `Requires ${def.minPop} people`, visible: true };
  if (!canAfford(state, def.cost)) return { ok: false, reason: 'Not enough resources', visible: true };
  return { ok: true, visible: true };
}

export function research(state: GameState, t: TechId, fx?: FxEvent[]): ActionResult {
  const st = techStatus(state, t);
  if (!st.ok) return st;
  const def = TECH_DEFS[t];
  pay(state, def.cost);
  state.techs.push(t);
  invalidate(state);
  if (def.advancesTo !== undefined) {
    const era = ERAS[def.advancesTo];
    log(state, `${state.name} enters the ${era.name}! ${era.blurb}`, 'era');
    fx?.push({ kind: 'era', era: def.advancesTo });
  } else {
    log(state, `Discovered ${def.name}.`, 'good');
  }
  checkObjectives(state);
  return { ok: true };
}

export function setJobTarget(state: GameState, j: JobId, target: number) {
  const slots = derived(state).slots[j];
  const unlocked = !JOB_DEFS[j].tech || hasTech(state, JOB_DEFS[j].tech!);
  state.jobTargets[j] = unlocked ? Math.max(0, Math.min(slots, Math.round(target))) : 0;
}

export function setExploreTarget(state: GameState, x: number, y: number) {
  state.exploreTarget = state.explored[idx(x, y)] ? null : idx(x, y);
}

export function choose(state: GameState, ctx: TickContext, index: number) {
  resolveChoice(state, ctx, index);
  checkObjectives(state);
}
