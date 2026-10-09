/**
 * Scouting parties. Scouts set out together from their settlement with provisions for a trip, walk out
 * into the unknown noting the land around them, survey the country from each camp they make when they
 * are worn down, and turn for home in time to get back. What they see is only known to the realm once
 * they bring it home: a party that never returns takes it with it. A party that comes upon prime land
 * far from home may break camp and settle it, sending one of its number home with the news.
 *
 * The wilds are dangerous: falls in the mountains, wolves, fords and cold, and worse for a party that
 * pushes on without making camp, or is held up far from home until the provisions run out.
 * Deterministic, so it runs the same offline.
 */
import { CAMP_AT, MAP_H, MAP_W, PARTY_SIZE, SCOUT_DAYS, SCOUT_REST } from './data';
import { derived, invalidate, recount } from './derived';
import { choiceOf, fxMul, tweak } from './decisions';
import { Heap, layTrail, townById } from './land';
import { getMap, idx, inBounds, N4, tx, ty } from './map';
import { chart, inParty, lightHearth, siteCalling, siteFree, siteProfile, siteValues, townCap } from './realm';
import { hash2, type Rng } from './rng';
import { withSearch } from './scratch';
import { hasTech, isAdult, seasonIndex } from './state';
import type { Expedition, FxEvent, GameState, Settler } from './types';
import { Biome, T } from './types';

interface Ctx {
  fx: FxEvent[];
}

type Kill = (s: Settler, cause: string) => void;

function note(state: GameState, text: string, kind: 'info' | 'bad' | 'good' | 'realm' = 'info') {
  state.log.push({ day: state.day, text, kind });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

/** How good the realm's scouts are at their craft: Pathfinding and the paths that favour exploring. */
export function scoutcraft(state: GameState) {
  return (hasTech(state, 'scouting') ? 1.5 : 1) * fxMul(state, 'scout');
}

/** Tiles scouts can see to either side of their way. From a camp they survey further. */
export function sightOf(state: GameState) {
  return scoutcraft(state) >= 1.4 ? 3 : 2;
}

/** A site this good is worth settling on the spot, rather than going home first. */
const PRIME = 26;

/** Tiles' worth of walking a party covers in a day. */
function speedOf(state: GameState) {
  return 1 + 0.25 * (scoutcraft(state) - 1);
}

/** Days of provisions a party sets out with. */
export function provisions(state: GameState) {
  return tweak(state, 'trip');
}

/** Days for a scouting party to cross a tile (roads, trails and greens are quick; the sea and peaks stop them). */
function scoutCost(map: ReturnType<typeof getMap>, net: Uint8Array, i: number) {
  if (map.ocean[i]) return Infinity;
  if (net[i]) return 0.2;
  return SCOUT_DAYS[map.terrain[i]] ?? Infinity;
}

/** Unknown tiles in every box within a window of the map, from a summed-area table of the fog. */
function unknownCounter(state: GameState, wx0: number, wy0: number, wx1: number, wy1: number) {
  wx0 = Math.max(0, wx0);
  wy0 = Math.max(0, wy0);
  wx1 = Math.min(MAP_W, wx1);
  wy1 = Math.min(MAP_H, wy1);
  const W = wx1 - wx0 + 1;
  const H = wy1 - wy0;
  const sat = new Int32Array(W * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W - 1; x++) {
      row += state.explored[idx(wx0 + x, wy0 + y)] ? 0 : 1;
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  return (i: number, r: number) => {
    const x0 = Math.max(wx0, tx(i) - r) - wx0;
    const y0 = Math.max(wy0, ty(i) - r) - wy0;
    const x1 = Math.min(wx1, tx(i) + r + 1) - wx0;
    const y1 = Math.min(wy1, ty(i) + r + 1) - wy0;
    return sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
  };
}

export interface TripPlan {
  /** Out and back again. */
  path: number[];
  turn: number;
  /** About how many unknown tiles they expect to chart. */
  gain: number;
}

/**
 * Where a party from a settlement would go: out over the land (known or not) as far as half its
 * provisions allow, toward the most unknown land along the way, or toward the land marked for them.
 * Parties already out are given room, so they fan out.
 */
export function planTrip(state: GameState, town: number): TripPlan | null {
  const home = townById(state, town);
  if (!home) return null;
  const map = getMap(state.seed);
  const net = derived(state).network;
  // Unknown land well within sight of each step (a square inside their circle of sight).
  const rb = sightOf(state) - 1;
  // Out and back, with a night in camp for every few days on the move, and something to spare.
  const budget = provisions(state) * speedOf(state) * 0.28;
  const R = Math.ceil(budget / 0.2) + rb + 2;
  const unknown = unknownCounter(state, home.x - R, home.y - R, home.x + R + 1, home.y + R + 1);
  const others = state.expeditions.filter((e) => e.kind === 'scout' && e.turn !== undefined).map((e) => e.path[e.turn!]);
  const mark = state.exploreTarget;
  const plan = withSearch((search): TripPlan | null | 'unreachable' => {
    const { dist, prev, extra: gain, flag: closed } = search;
    const heap = new Heap();
    const start = idx(home.x, home.y);
    search.touch(start);
    dist[start] = 0;
    heap.push(start, 0);
    let best = -1;
    let bestScore = -Infinity;
    while (heap.size) {
      const i = heap.pop();
      if (closed[i]) continue;
      closed[i] = 1;
      if (dist[i] > budget) break;
      if (i !== start) {
        let sc: number;
        if (mark !== null) sc = -Math.hypot(tx(i) - tx(mark), ty(i) - ty(mark)) * 3 + gain[i] * 0.1;
        else {
          sc = gain[i] + hash2(tx(i), ty(i), state.day) * 3;
          for (const o of others) {
            const dd = Math.hypot(tx(o) - tx(i), ty(o) - ty(i));
            if (dd < 12) sc -= (12 - dd) * 2;
          }
        }
        if (sc > bestScore) (bestScore = sc), (best = i);
      }
      const x = tx(i);
      const y = ty(i);
      for (const [dx, dy] of N4) {
        if (!inBounds(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (closed[j]) continue;
        const c = scoutCost(map, net, j);
        if (!isFinite(c)) continue;
        const nd = dist[i] + c;
        if (nd < dist[j]) {
          if (dist[j] === Infinity) search.touch(j);
          dist[j] = nd;
          prev[j] = i;
          gain[j] = gain[i] + unknown(j, rb) / (2 * rb + 1);
          heap.push(j, nd);
        }
      }
    }
    if (best < 0) return null;
    // The marked land is out of reach on foot.
    if (mark !== null && gain[best] < 4 && Math.hypot(tx(best) - tx(mark), ty(best) - ty(mark)) > rb + 2) return 'unreachable';
    if (gain[best] < 4) return null;
    const out: number[] = [];
    for (let k = best; k >= 0; k = prev[k]) out.push(k);
    out.reverse();
    return { path: [...out, ...out.slice(0, -1).reverse()], turn: out.length - 1, gain: gain[best] };
  });
  if (plan === 'unreachable') {
    // Give up on the marked land and scout what can be reached.
    state.exploreTarget = null;
    note(state, 'Your scouts can find no way on foot to the marked land.', 'info');
    return planTrip(state, town);
  }
  return plan;
}

/** Scouts of a settlement: all of them (home or away), and those home, rested and ready to go. */
function scoutsOf(state: GameState, town: number, away: Set<number>) {
  let all = 0;
  const ready: Settler[] = [];
  for (const s of state.settlers) {
    if (s.town !== town || s.job !== 'scout') continue;
    all++;
    if (away.has(s.id) || !isAdult(state, s)) continue;
    if (s.back === undefined || state.day - s.back >= SCOUT_REST) ready.push(s);
  }
  return { all, ready };
}

/**
 * Settlements whose scouts found nothing left in reach, and under what conditions: the search is only
 * repeated once the known land, the trips, the roads or the marked land change. (Not saved: it only
 * skips searches that would come to nothing, so a reloaded game plays out the same.)
 */
const nothingInReach = new WeakMap<GameState, Map<number, string>>();

function reachKey(state: GameState) {
  return `${state.stats.tilesExplored}:${provisions(state)}:${scoutcraft(state)}:${state.landEpoch}:${state.exploreTarget}`;
}

/** Scouts who are home and rested set out together, unless it is winter or there is nothing left in reach. */
function launchParties(state: GameState) {
  if (seasonIndex(state.day) === 3 || state.hunger > 0.1) return;
  const away = inParty(state);
  for (const t of state.towns) {
    const { all, ready } = scoutsOf(state, t.id, away);
    // They go out together: wait for the others to come home and rest up, then split into even parties.
    if (!ready.length || ready.length < Math.min(PARTY_SIZE, all)) continue;
    const parties = Math.ceil(ready.length / PARTY_SIZE);
    const size = Math.ceil(ready.length / parties);
    let memo = nothingInReach.get(state);
    if (!memo) nothingInReach.set(state, (memo = new Map()));
    if (memo.get(t.id) === reachKey(state)) continue;
    for (let k = 0; k < parties; k++) {
      const plan = planTrip(state, t.id);
      if (!plan) {
        memo.set(t.id, reachKey(state));
        break;
      }
      memo.delete(t.id);
      const party = ready.slice(k * size, (k + 1) * size);
      if (!party.length) break;
      const e: Expedition = {
        id: state.nextExpId++,
        kind: 'scout',
        from: t.id,
        path: plan.path,
        at: 0,
        step: 0,
        people: party.map((s) => s.id),
        started: state.day,
        turn: plan.turn,
        food: provisions(state),
        weary: 0,
        camp: 0,
        found: [],
      };
      state.expeditions.push(e);
      for (const s of party) away.add(s.id);
    }
  }
}

/** Days still to walk to get home from where a party is. */
function daysHome(state: GameState, e: Expedition) {
  const map = getMap(state.seed);
  const net = derived(state).network;
  let c = 0;
  for (let k = e.at + 1; k < e.path.length; k++) {
    const s = scoutCost(map, net, e.path[k]);
    c += isFinite(s) ? s : 1;
  }
  return c / speedOf(state);
}

/** Turn for home from where they stand, the way they came. */
function turnBack(e: Expedition) {
  const out = e.path.slice(0, e.at + 1);
  e.path = [...out, ...out.slice(0, -1).reverse()];
  e.turn = e.at;
}

/** How hard a day on this ground is on a party, and how dangerous. */
function terrainToll(t: T): { wear: number; risk: number } {
  switch (t) {
    case T.Mountain:
      return { wear: 0.8, risk: 3 };
    case T.Hills:
      return { wear: 0.3, risk: 1.4 };
    case T.Dense:
      return { wear: 0.3, risk: 1.5 };
    case T.River:
      return { wear: 0.3, risk: 1.6 };
    case T.Sand:
      return { wear: 0.2, risk: 1 };
    default:
      return { wear: 0, risk: 1 };
  }
}

const MISHAPS: { text: string; days: number }[] = [
  { text: 'lost their way in fog', days: 2 },
  { text: 'were held up by a swollen river', days: 2 },
  { text: 'sheltered from a storm', days: 1 },
  { text: 'carried an injured companion', days: 3 },
];

function partyNames(state: GameState, ids: number[]) {
  const names = ids.map((id) => state.settlers.find((s) => s.id === id)?.name.split(' ')[0]).filter(Boolean) as string[];
  if (names.length <= 1) return names[0] ?? 'The scouts';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Note the unknown land within sight of a tile on the party's charts. */
function look(state: GameState, e: Expedition, seen: Set<number>, i: number, r: number) {
  const x = tx(i);
  const y = ty(i);
  for (let yy = y - r; yy <= y + r; yy++)
    for (let xx = x - r; xx <= x + r; xx++) {
      if (!inBounds(xx, yy) || Math.hypot(xx - x, yy - y) > r + 0.3) continue;
      const j = idx(xx, yy);
      if (state.explored[j] || seen.has(j)) continue;
      seen.add(j);
      e.found!.push(j);
    }
}

/** Unknown land the realm's parties have seen but not yet brought home. */
export function glimpsed(state: GameState): number[] {
  const out: number[] = [];
  for (const e of state.expeditions) if (e.kind === 'scout' && e.found) for (const i of e.found) if (!state.explored[i]) out.push(i);
  return out;
}

/** Whether a party may settle prime land it stands on, instead of only bringing word of it. */
function maySettle(state: GameState, e: Expedition) {
  if (e.messenger || e.people.length < 3 || !state.council.build || !hasTech(state, 'scouting')) return false;
  if (choiceOf(state, 'expansion') === 'consolidate' || state.towns.length >= townCap(state)) return false;
  if (state.expeditions.some((x) => x.kind === 'settle') || state.settlers.length < 24) return false;
  // Close to home it is better to go back and send proper pioneers.
  return daysHome(state, e) >= 4;
}

/** Most of the party break camp and light a hearth here; one of them hurries home with the news, blazing a trail. */
function settleHere(state: GameState, ctx: Ctx, rng: Rng, e: Expedition) {
  const tile = e.path[e.at];
  const from = townById(state, e.from);
  const [messenger, ...founders] = e.people;
  const town = lightHearth(state, ctx, tile, founders, e.from, rng);
  e.people = [messenger];
  e.messenger = true;
  e.camp = 0;
  e.weary = 0;
  turnBack(e);
  const p = siteProfile(state.seed, tile);
  note(
    state,
    `${partyNames(state, founders)}, out scouting from ${from?.name ?? 'home'}, came upon prime ${siteCalling(p)} land and broke camp to light a hearth there: ${town.name}. ${partyNames(state, [messenger])} hurries home with the news, blazing a trail.`,
    'good',
  );
}

/** Compass direction from one place to another, in words. */
function direction(dx: number, dy: number) {
  const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
  return names[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
}

/** A party gets home: its charts become the realm's, and it tells of the best land it saw. */
function comeHome(state: GameState, ctx: Ctx, e: Expedition) {
  state.expeditions.splice(state.expeditions.indexOf(e), 1);
  const from = townById(state, e.from) ?? state.towns[0];
  for (const s of state.settlers)
    if (e.people.includes(s.id)) {
      s.back = state.day;
      s.town = from.id;
    }
  const found = e.found ?? [];
  const n = chart(state, ctx, found);
  const days = state.day - e.started;
  if (e.messenger) {
    note(state, `${partyNames(state, e.people)} reaches ${from.name} after ${days} days with news of the new settlement, and charts of ${n} tiles of land.`, 'realm');
    return;
  }
  // The best free land they saw, if it is worth sending pioneers to.
  const values = siteValues(state.seed);
  let best = -1;
  for (const i of found) if (values.at(i) >= 20 && (best < 0 || values.at(i) > values.at(best)) && siteFree(state, i)) best = i;
  const hungry = (e.food ?? 0) < 0 ? 'Hungry and footsore, the' : 'The';
  let text = `${hungry} scouts are back in ${from.name} after ${days} days in the wilds, with charts of ${n} tiles of land.`;
  if (best >= 0) {
    const dx = tx(best) - from.x;
    const dy = ty(best) - from.y;
    text += ` They bring word of promising ${siteCalling(siteProfile(state.seed, best))} land ${Math.round(Math.hypot(dx, dy))} leagues to the ${direction(dx, dy)}.`;
  }
  if (n || best >= 0) note(state, text, best >= 0 ? 'good' : 'info');
}

/** A day in the life of every party in the field: march or camp, take the risks, look about. */
function stepParties(state: GameState, ctx: Ctx, rng: Rng, kill: Kill) {
  const map = getMap(state.seed);
  const season = seasonIndex(state.day);
  const winter = season === 3;
  const sight = sightOf(state);
  const craft = scoutcraft(state);
  const speed = speedOf(state);
  const net = derived(state).network;
  const values = siteValues(state.seed);
  const home: Expedition[] = [];
  for (const e of [...state.expeditions]) {
    if (e.kind !== 'scout') continue;
    e.found ??= [];
    const seen = new Set(e.found);
    const here = e.path[e.at];
    const biome = map.biome[here] as Biome;
    const camped = (e.camp ?? 0) > 0;
    let toll = terrainToll(map.terrain[here] as T);
    e.food = (e.food ?? 0) - 1;
    if (camped) {
      e.camp!--;
      e.weary = Math.max(0, (e.weary ?? 0) - (winter ? 1.5 : 2.5));
    } else {
      // On the march.
      e.step += speed;
      let wear = 1;
      const trail: number[] = [];
      while (e.at < e.path.length - 1) {
        const c = scoutCost(map, net, e.path[e.at + 1]);
        const need = isFinite(c) ? c : 1;
        if (e.step < need) break;
        e.step -= need;
        e.at++;
        const i = e.path[e.at];
        const t = terrainToll(map.terrain[i] as T);
        wear = Math.max(wear, 1 + t.wear);
        if (t.risk > toll.risk) toll = t;
        look(state, e, seen, i, sight);
        if (e.messenger) trail.push(i);
        if (values.at(i) >= PRIME && e.at <= (e.turn ?? 0) && maySettle(state, e) && siteFree(state, i)) {
          settleHere(state, ctx, rng, e);
          break;
        }
      }
      if (trail.length) {
        layTrail(state, trail);
        invalidate(state);
      }
      const climate = winter ? (biome === Biome.Boreal ? 2.2 : 1.6) : season === 1 && biome === Biome.Arid ? 1.4 : biome === Biome.Tropical ? 1.15 : 1;
      e.weary = (e.weary ?? 0) + wear * climate;
    }

    // The dangers of the wilds, for each of them.
    const over = Math.max(0, (e.weary ?? 0) - CAMP_AT);
    const cold = winter ? (camped ? 0.0008 : 0.003) * (biome === Biome.Boreal ? 2.5 : biome === Biome.Arid || biome === Biome.Tropical ? 0.4 : 1) : 0;
    const starving = (e.food ?? 0) < 0 ? 0.07 : 0;
    const accident = 0.0007 * (camped ? 0.4 : toll.risk);
    const exhaustion = 0.005 * over * over;
    const total = accident + exhaustion + cold + starving;
    const p = (total / Math.sqrt(craft)) * (e.people.length === 1 ? 1.5 : 1);
    for (const id of [...e.people]) {
      if (!rng.chance(p)) continue;
      const s = state.settlers.find((x) => x.id === id);
      if (!s) continue;
      const r = rng.next() * total;
      const ground = map.terrain[e.path[e.at]];
      const cause =
        r < starving
          ? 'hunger, far from home'
          : r < starving + accident
            ? ground === T.Mountain
              ? 'a fall in the mountains'
              : ground === T.River
                ? 'drowning at a ford'
                : rng.pick(['wolves in the wilds', 'a fall in the wilds', 'a fever on the trail'])
            : r < starving + accident + exhaustion
              ? 'exhaustion, pushing on without making camp'
              : 'the cold on the trail';
      kill(s, cause);
    }
    if (!state.expeditions.includes(e)) continue; // the last of them is gone, and their charts with them

    if (e.at >= e.path.length - 1) {
      home.push(e);
      continue;
    }
    // Their plans for tomorrow: turn back if the provisions will not last, camp when worn down
    // unless they must hurry home, and now and then the wilds hold them up.
    const need = daysHome(state, e);
    const left = e.food ?? 0;
    if (e.turn !== undefined && e.at < e.turn && left < need * 1.35 + 2) turnBack(e);
    const hurry = left < need * 1.2;
    if (!(e.camp ?? 0) && (e.weary ?? 0) >= CAMP_AT && !hurry) {
      e.camp = winter ? 2 : 1;
      // From camp they climb a rise and survey the country around.
      look(state, e, seen, e.path[e.at], sight + 2);
    }
    if (rng.chance(winter ? 0.025 : 0.012)) {
      const m = rng.pick(MISHAPS);
      e.camp = (e.camp ?? 0) + m.days;
      note(state, `${partyNames(state, e.people)}, out scouting from ${townById(state, e.from)?.name ?? 'home'}, ${m.text}.`);
    }
  }
  for (const e of home) comeHome(state, ctx, e);
  if (home.length) recount(state);
}

/** How a party in the field is faring, in words. */
export function partyStatus(state: GameState, e: Expedition): string {
  const days = state.day - e.started;
  const food = e.food ?? 0;
  const homeward = e.turn !== undefined && e.at >= e.turn;
  const need = daysHome(state, e);
  const doing =
    food < 0
      ? 'out of food, starving'
      : (e.camp ?? 0) > 0
        ? 'in camp'
        : homeward && food < need * 1.2
          ? 'hurrying home without making camp'
          : (e.weary ?? 0) >= CAMP_AT
            ? 'worn out, pushing on'
            : homeward
              ? 'heading home'
              : 'heading into the unknown';
  return `Day ${days} · ${doing} · ${Math.max(0, food)} days of food left · ${e.found?.length ?? 0} tiles seen`;
}

/** Everything the scouts do in a day: parties set out, and those in the field march, camp, chart and come home. */
export function scoutDay(state: GameState, ctx: Ctx, rng: Rng, kill: Kill) {
  launchParties(state);
  stepParties(state, ctx, rng, kill);
  if (state.exploreTarget !== null && state.explored[state.exploreTarget]) {
    state.exploreTarget = null;
    note(state, 'Your scouts have reached the marked lands.', 'info');
  }
}
