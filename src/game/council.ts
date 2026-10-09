/**
 * The council runs the settlement day to day so the player can focus on decisions.
 * It assigns work, raises buildings and pursues discoveries according to the
 * chosen focus, policies and tweaks. It is deterministic so it also runs offline.
 */
import { buildingAvailability, placeBuilding, research, setJobTarget, techStatus } from './actions';
import { BUILDING_DEFS, MAP_H, MAP_W, TECH_DEFS, TECH_ORDER } from './data';
import { choiceOf, nextPath, pathRequirements, tweak } from './decisions';
import { canAfford, canPlace, census, derived, SPECIALTY_NAMES, type Derived, type Specialty } from './derived';
import { blocked, catchmentAt, centerOf, dryLand, hearthOf, layerSum, prepNeeded, ringOf, sizeOf } from './land';
import { getMap, idx, inBounds, N4, N8, tx, ty } from './map';
import { townCalling } from './realm';
import { baseRate, foodDemand, gathererCapacity, jobOutput, pastureYield, popSummary, yieldEff, type TickContext } from './sim';
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

const HOMES: BuildingId[] = ['hut', 'house', 'manor'];
const WORKS: BuildingId[] = ['quarry', 'mine', 'smithy', 'lumber', 'lodge', 'harbour'];
const FIELDS: BuildingId[] = ['farm', 'pasture'];

/** The trade each kind of workplace gives a settlement, so like is built beside like. */
const TRADE_OF: Partial<Record<BuildingId, Specialty>> = {
  farm: 'farming',
  granary: 'farming',
  pasture: 'herding',
  lumber: 'timber',
  lodge: 'hunting',
  mine: 'mining',
  quarry: 'quarrying',
  harbour: 'port',
  smithy: 'crafts',
  library: 'learning',
  shrine: 'temple',
};
void SPECIALTY_NAMES;

/**
 * How well a tile suits a building, so each settlement grows the way a real one would: homes line the
 * roads near its hearth, stores and halls sit at its heart, fields spread out over the fertile land
 * beyond, and camps, quarries, mines and harbours go where the timber, stone, ore and sea actually are.
 * Like draws like: a mining town gets more mines, a farming town more fields. Sites that need forest
 * felled or rock levelled first count against a tile, unless what lies there is worth the work.
 */
function siteScore(state: GameState, type: BuildingId, i: number, mult: number, at: Map<number, BuildingId>, d: Derived): number {
  const map = getMap(state.seed);
  const town = d.townAt[i];
  const h = hearthOf(state, town);
  const x = tx(i);
  const y = ty(i);
  const [w, hh] = sizeOf(type);
  const [cx, cy] = centerOf({ type, x, y });
  const dist = Math.hypot(cx - h.x, cy - h.y);
  const ring = ringOf(x, y, w, hh).filter(([xx, yy]) => inBounds(xx, yy));
  const around = (types: BuildingId[]) => {
    let k = 0;
    for (const [xx, yy] of ring) {
      const t = at.get(idx(xx, yy));
      if (t && types.includes(t)) k++;
    }
    return k;
  };
  let roadAdj = false;
  let free = 0;
  let water = false;
  for (const [xx, yy] of ring) {
    const j = idx(xx, yy);
    const t = map.terrain[j];
    if (t === T.River || t === T.Water) water = true;
    if (xx >= x && xx < x + w ? true : yy >= y && yy < y + hh) {
      if (d.network[j]) roadAdj = true;
      if (!d.occupied[j] && !blocked(map, j)) free++;
    }
  }
  const ter = map.terrain[i];
  const fertile = water && (ter === T.Grass || ter === T.Meadow);
  const catchSum = (layer: 'wood' | 'stone' | 'ore' | 'life') => layerSum(state, layer, catchmentAt(state, type, x, y, layer));
  const prep = prepNeeded(state, type, x, y);
  const info = d.towns.get(town);
  const trade = TRADE_OF[type];
  // Like draws like, and a settlement's own land suggests its trade.
  const kin = trade && info?.specialty === trade ? 2.5 : 0;
  const haul = info?.haul ?? 1;
  // A settlement that cannot staff the workplaces it has is a poor place for more of them.
  const c = state.towns.length > 1 ? census(state) : null;
  const unstaffed = c && info && town !== state.towns[0]?.id && !HOMES.includes(type) ? Math.max(0, info.fullSlots - (c.adults.get(town) ?? 0)) * 0.35 : 0;
  const prepCost = (prep.fell + prep.level) * 0.12 - Math.min(prep.stone, 40) * 0.02;
  let score: number;
  switch (type) {
    case 'hut':
    case 'house':
    case 'manor':
      score = -dist * 1.1 + (roadAdj ? 5 : 0) + Math.min(2, around(HOMES)) * 1.2 - around([...WORKS, ...FIELDS]) * 2 - (fertile ? 2 : 0) - (free + (roadAdj ? 1 : 0) < 2 ? 3 : 0);
      break;
    case 'storehouse':
    case 'granary':
    case 'library':
    case 'shrine':
    case 'herbalist':
      score = -dist * 0.8 + (roadAdj ? 4 : 0) - around(WORKS) - (fertile ? 2 : 0) + (type === 'granary' ? around(FIELDS) * 0.8 : 0) + kin;
      break;
    case 'smithy':
      score = -dist * 0.5 + (roadAdj ? 3 : 0) - (fertile ? 2 : 0) + around(['mine', 'storehouse']) * 1.5 + kin;
      break;
    case 'lumber': {
      let shared = 0;
      for (const j of catchmentAt(state, type, x, y, 'wood')) if (d.replant[j]) shared++;
      score = (catchSum('wood') / 40 + mult * 3) * haul - dist * 0.25 - shared * 0.6 + kin;
      break;
    }
    case 'lodge':
      score = (catchSum('life') / 25 + mult * 4) * haul - dist * 0.3 - around(['lodge']) * 4 + kin;
      break;
    case 'quarry':
      score = (catchSum('stone') / 150 + mult * 3) * haul - dist * 0.3 + kin;
      break;
    case 'mine':
      score = (catchSum('ore') / 100 + mult * 4) * haul - dist * 0.3 + kin;
      break;
    case 'farm':
      score = mult * 10 * haul - Math.abs(dist - 5.5) * 0.7 + around(FIELDS) * 2.5 - around(HOMES) - (dist < 3 ? 8 : 0) + kin;
      break;
    case 'pasture':
      score = -Math.abs(dist - 7) * 0.5 + around(FIELDS) * 1.5 - around(HOMES) * 1.5 + (ter === T.Meadow ? 1 : 0) - (fertile ? 1 : 0) + kin;
      break;
    case 'harbour': {
      // Where the fishing is good and the settlement looks to the sea.
      let fish = 0;
      for (let yy = y - 3; yy <= y + 3; yy++)
        for (let xx = x - 3; xx <= x + 3; xx++) if (inBounds(xx, yy) && map.feature[idx(xx, yy)] === F.Fish) fish++;
      score = -dist * 0.5 + (roadAdj ? 2 : 0) + fish * 2 + kin;
      break;
    }
    case 'watchtower':
      score = (ter === T.Hills ? 3 : 0) + map.elev[i] * 6 + Math.min(dist, 10) * 0.4 - around([...HOMES, ...WORKS, ...FIELDS]);
      break;
    case 'monument':
      score = -Math.abs(dist - 4) + (roadAdj ? 2 : 0) - (fertile ? 1 : 0);
      break;
    default:
      score = -dist * 0.6 + (roadAdj ? 2 : 0);
  }
  return score - prepCost - unstaffed;
}

const tileMemo = new WeakMap<Derived, Map<string, number | null>>();

/** The best place for a building, anywhere in the realm or within one settlement. Memoised while nothing changes. */
function bestTile(state: GameState, type: BuildingId, town?: number): number | null {
  if (type === 'bridge') return bridgeTile(state);
  const d = derived(state);
  let memo = tileMemo.get(d);
  if (!memo) tileMemo.set(d, (memo = new Map()));
  const key = `${type}:${town ?? ''}:${state.stats.tilesExplored}`;
  if (memo.has(key)) return memo.get(key)!;
  const at = new Map<number, BuildingId>();
  for (const b of state.buildings) for (const t of tilesOfB(b)) at.set(t, b.type);
  const capital = state.towns[0]?.id;
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const i of d.terrTiles) {
    if (town !== undefined && d.townAt[i] !== town) continue;
    // The great work rises in the capital.
    if (type === 'monument' && d.townAt[i] !== capital) continue;
    const c = canPlace(state, type, i, d);
    if (!c.ok) continue;
    const sc = siteScore(state, type, i, c.mult, at, d);
    if (sc > bestScore || (sc === bestScore && best !== null && i < best)) {
      bestScore = sc;
      best = i;
    }
  }
  memo.set(key, best);
  return best;
}

function tilesOfB(b: { type: BuildingId; x: number; y: number }) {
  const [w, h] = sizeOf(b.type);
  const out: number[] = [];
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) if (inBounds(b.x + dx, b.y + dy)) out.push(idx(b.x + dx, b.y + dy));
  return out;
}

/**
 * Where a bridge would open up the most useful land across a river: a river tile with reachable land
 * (or a bridge being built) on one bank, and land nobody can yet reach on the other.
 */
export function bridgeTile(state: GameState): number | null {
  if (count(state, 'bridge') >= 8) return null;
  const map = getMap(state.seed);
  const d = derived(state);
  const n = MAP_W * MAP_H;
  // Label the unreachable patches of land and value what they hold inside the territory.
  const label = new Int32Array(n).fill(-1);
  const value: number[] = [];
  const bridgeAt = new Set(state.buildings.filter((b) => b.type === 'bridge').map((b) => idx(b.x, b.y)));
  const pending = state.buildings.some((b) => b.type === 'bridge' && !b.done);
  const component = (start: number) => {
    if (label[start] >= 0) return value[label[start]];
    const id = value.length;
    let v = 0;
    const queue = [start];
    label[start] = id;
    for (let q = 0; q < queue.length && q < 600; q++) {
      const i = queue[q];
      if (d.territory[i] && state.explored[i]) {
        v += 1 + (map.feature[i] === F.Ore ? 8 : 0) + (map.feature[i] === F.Game ? 4 : 0) + (map.terrain[i] === T.Hills ? 1 : 0);
        for (const [dx, dy] of N8) {
          const xx = tx(i) + dx;
          const yy = ty(i) + dy;
          if (inBounds(xx, yy) && (map.terrain[idx(xx, yy)] === T.Mountain || map.terrain[idx(xx, yy)] === T.Hills)) {
            v += 0.3;
            break;
          }
        }
      }
      for (const [dx, dy] of N4) {
        const xx = tx(i) + dx;
        const yy = ty(i) + dy;
        if (!inBounds(xx, yy)) continue;
        const j = idx(xx, yy);
        if (label[j] >= 0 || d.reach[j] || blocked(map, j)) continue;
        label[j] = id;
        queue.push(j);
      }
    }
    value.push(v);
    return v;
  };
  let best: number | null = null;
  let bestScore = -Infinity;
  for (const i of d.terrTiles) {
    if (map.terrain[i] !== T.River || !state.explored[i] || d.occupied[i]) continue;
    const x = tx(i);
    const y = ty(i);
    for (const [dx, dy] of N4) {
      if (!inBounds(x - dx, y - dy) || !inBounds(x + dx, y + dy)) continue;
      const near = idx(x - dx, y - dy);
      const fromBridge = bridgeAt.has(near);
      if (!fromBridge && !(d.reach[near] && !blocked(map, near))) continue;
      // While a bridge is going up, only carry on across the same river.
      if (pending && !fromBridge) continue;
      let far = idx(x + dx, y + dy);
      let span = 1;
      if (map.terrain[far] === T.River && inBounds(x + 2 * dx, y + 2 * dy)) {
        far = idx(x + 2 * dx, y + 2 * dy);
        span = 2;
      }
      if (!dryLand(map, far) || d.reach[far]) continue;
      const v = component(far);
      if (v < 8) continue;
      const own = hearthOf(state, d.townAt[i]);
      const score = Math.min(v, 60) / span - Math.hypot(x - own.x, y - own.y) * 0.8;
      if (score > bestScore && canPlace(state, 'bridge', i).ok) {
        bestScore = score;
        best = i;
      }
    }
  }
  return best;
}

/** Whether the best spot for a new camp or lodge has woods or a healthy herd that no other workplace already works. */
function freshSite(state: GameState, type: 'lumber' | 'lodge') {
  const t = bestTile(state, type);
  if (t === null) return false;
  const layer = type === 'lumber' ? 'wood' : 'life';
  const worked = new Set<number>();
  for (const tiles of derived(state).catchments[layer].values()) for (const i of tiles) worked.add(i);
  const fresh = catchmentAt(state, type, tx(t), ty(t), layer).filter((i) => !worked.has(i));
  return layerSum(state, layer, fresh) >= (type === 'lumber' ? 300 : 60);
}

function count(state: GameState, t: BuildingId) {
  return state.buildings.filter((b) => b.type === t && !b.spent).length;
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
export interface Wish {
  type: BuildingId;
  waiting: boolean;
  /** Settlement it is meant for (anywhere when absent). */
  town?: number;
}

/**
 * Which settlement most needs homes: one whose workplaces lack hands, or whose families have no room
 * to grow. Spare beds are shared out in proportion to the people living in each.
 */
export function homeTown(state: GameState): { town: number; need: number } | null {
  const d = derived(state);
  const c = census(state);
  const pop = Math.max(1, state.settlers.length);
  const headroom = tweak(state, 'housing') + (focusOf(state) === 'growth' ? 3 : 0);
  let best: { town: number; need: number } | null = null;
  for (const t of state.towns) {
    const info = d.towns.get(t.id);
    if (!info) continue;
    const res = c.residents.get(t.id) ?? 0;
    const planned = d.sites.filter((b) => b.town === t.id).reduce((s, b) => s + (BUILDING_DEFS[b.type].housing ?? 0), 0);
    const short = t.id === state.towns[0].id ? 0 : Math.max(0, info.fullSlots - (c.adults.get(t.id) ?? 0));
    const want = Math.max(1, Math.round((headroom * res) / pop)) + Math.min(short, 6);
    const need = want - (info.housing + planned - res);
    if (need > 0 && (!best || need > best.need)) best = { town: t.id, need };
  }
  return best;
}

export function councilWish(state: GameState): Wish | null {
  const d = derived(state);
  const pop = state.settlers.length;
  const unlocked = (t: BuildingId) => !BUILDING_DEFS[t].tech || hasTech(state, BUILDING_DEFS[t].tech!);
  const wish = (t: BuildingId, town?: number): Wish | null => {
    if (!unlocked(t)) return null;
    if (BUILDING_DEFS[t].max !== undefined && count(state, t) >= BUILDING_DEFS[t].max!) return null;
    if (!fitsCaps(state, BUILDING_DEFS[t].cost)) return null;
    if (bestTile(state, t, town) === null) return null;
    return { type: t, waiting: !canAfford(state, BUILDING_DEFS[t].cost), town };
  };

  // 1. Homes, so families can grow, in the settlement that needs them most.
  const planned = d.sites.reduce((s, b) => s + (BUILDING_DEFS[b.type].housing ?? 0), 0);
  const headroom = tweak(state, 'housing') + (focusOf(state) === 'growth' ? 3 : 0);
  const ht = homeTown(state);
  if (ht && (d.housing + planned - pop < headroom || ht.need >= 2)) {
    const town = state.towns.length > 1 ? ht.town : undefined;
    const tier = state.towns.find((t) => t.id === ht.town)?.tier ?? 0;
    const w = (tier >= 2 && hasTech(state, 'masonry') && wish('manor', town)) || (hasTech(state, 'masonry') && wish('house', town)) || wish('hut', town);
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
  if (full('food') && hasTech(state, 'pottery') && seasonIndex(state.day) < 3 && count(state, 'granary') < 2 + eraOf(state) * 2) {
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
  // 5. Each new settlement takes up the trade its land suggests: mines in ore-rich hills, fields on
  // fertile river land, a harbour on a fishing coast, camps in the deep woods.
  for (const t of state.towns.slice(1)) {
    const own = d.towns.get(t.id);
    if (!own || own.buildings >= 6) continue;
    for (const type of townCalling(state, t).slice(0, 2)) {
      if ((own.counts[type] ?? 0) + d.sites.filter((b) => b.town === t.id && b.type === type).length >= (own.buildings < 3 ? 1 : 2)) continue;
      const w = wish(type, t.id);
      if (w && !w.waiting) return w;
    }
  }
  // A harbour, once galleys can be built, in the settlement best placed for the sea.
  if (hasTech(state, 'seafaring') && count(state, 'harbour') < Math.min(3, 1 + Math.floor(state.towns.length / 2))) {
    const w = wish('harbour');
    if (w && !w.waiting) return w;
  }
  // 5b. Rivers in the way of good land.
  if (pop >= 10 && state.res.wood >= (BUILDING_DEFS.bridge.cost.wood ?? 0) + 10) {
    const w = wish('bridge');
    if (w && !w.waiting) return w;
  }
  // 6. Woods felled bare or herds hunted thin: open a camp somewhere richer.
  if (yieldEff(state, 'woodcutter') < 0.6 && state.res.wood < d.caps.wood * 0.5 && count(state, 'lumber') < 6) {
    const w = wish('lumber');
    if (w && freshSite(state, 'lumber')) return w;
  }
  if (yieldEff(state, 'hunter') < 0.6 && count(state, 'lodge') < 4) {
    const w = wish('lodge');
    if (w && !w.waiting && freshSite(state, 'lodge')) return w;
  }
  // 7. The focus plan.
  for (const [t, n] of PLANS[focusOf(state)]) {
    if (count(state, t) >= n) continue;
    const w = wish(t);
    if (!w) continue;
    // A second camp or lodge only where the land is not already being worked.
    if ((t === 'lumber' || t === 'lodge') && count(state, t) >= 1 && !freshSite(state, t)) continue;
    return w;
  }
  // 8. Late game: keep adding storage so the Sunspire's appetite can be met.
  if (hasTech(state, 'architecture') && count(state, 'storehouse') < 8 + eraOf(state) * 2) {
    const w = wish('storehouse');
    if (w) return w;
  }
  return null;
}

function councilBuild(state: GameState) {
  const d = derived(state);
  const pop = state.settlers.length;
  const maxSites = (pop > 60 ? 3 : pop > 18 ? 2 : 1) + Math.min(3, state.towns.length - 1);
  const sites = d.sites.filter((b) => b.type !== 'monument').length;
  if (sites >= maxSites) return;
  const w = councilWish(state);
  if (!w || w.waiting) return;
  if (!buildingAvailability(state, w.type).ok) return;
  const t = bestTile(state, w.type, w.town);
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
/** Food from one more worker of a job: hunters past what the herds can bear catch only small game, gatherers past what the land can feed find little. */
function foodPer(state: GameState, j: JobId, n: number, forageCap: number) {
  const avg = (jobOutput(state, j, Math.max(1, n + 1), -1) / Math.max(1, n + 1)) * baseRate(j);
  if (j === 'hunter') return avg * (yieldEff(state, j) >= 0.97 ? 1 : 0.4);
  if (j === 'gatherer') return avg * (n + 1 > forageCap ? 0.4 : 1);
  return avg;
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
  const pasture = pastureYield(state, season).food;
  const foodCap = Math.max(Math.min(4, ps.adults), Math.ceil(ps.adults * (state.hunger > 0.02 || stock < need * 4 ? 0.9 : 0.7)));
  let produced = pasture;
  let foodWorkers = 0;
  const forageCap = gathererCapacity(state);
  const fillFood = (goal: number) => {
    // One worker at a time, to whichever food job yields most right now.
    while (produced < goal && foodWorkers < foodCap && adults > 0) {
      let best: JobId | null = null;
      let bestV = 0;
      for (const j of ['farmer', 'hunter', 'gatherer'] as JobId[]) {
        if (target[j] >= d.slots[j]) continue;
        const v = foodPer(state, j, target[j], forageCap);
        if (v > bestV + 1e-9) {
          bestV = v;
          best = j;
        }
      }
      if (!best) break;
      produced += bestV;
      take(best, 1);
      foodWorkers++;
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
  return Math.max(0.1, (jobOutput(state, j, 1, -1) || 1) * baseRate(j) * Math.max(0.2, yieldEff(state, j)));
}
