import { ADULT_AGE, DAYS_PER_YEAR, ELDER_AGE, MAP_H, MAP_W } from './data';
import { initLand } from './land';
import { getMap, idx, tx, ty } from './map';
import { placeName, settlerName } from './names';
import { Rng } from './rng';
import type { GameState, JobId, Resources, Settler, TechId } from './types';
import { JOBS, RESOURCES } from './types';

export const SAVE_VERSION = 6;

export function emptyResources(): Resources {
  return Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Resources;
}

export function newGame(seed: number, legacy = 0, now = Date.now()): GameState {
  const map = getMap(seed);
  const rng = new Rng(seed ^ 0x9e3779b9);
  const jobTargets = Object.fromEntries(JOBS.map((j) => [j, 0])) as Record<JobId, number>;
  jobTargets.gatherer = 2;
  jobTargets.woodcutter = 1;
  jobTargets.scholar = 1;

  const state: GameState = {
    version: SAVE_VERSION,
    seed,
    rng: 0,
    name: placeName(rng),
    day: 0,
    res: { ...emptyResources(), food: 80, wood: 30 },
    settlers: [],
    nextId: 1,
    jobTargets,
    buildings: [{ id: 1, type: 'campfire', x: tx(map.start), y: ty(map.start), progress: 0, done: true, town: 1 }],
    nextBuildingId: 2,
    techs: [],
    explored: new Array(MAP_W * MAP_H).fill(0),
    claimed: [],
    exploreProgress: 0,
    exploreTarget: null,
    morale: 60,
    modifiers: [],
    log: [],
    choice: null,
    objective: 0,
    decisions: { focus: 'balanced' },
    decidedDay: {},
    tweaks: {},
    council: { jobs: true, build: true, research: true },
    pin: null,
    victory: false,
    defeat: false,
    legacy,
    lastSave: now,
    hunger: 0,
    cold: 0,
    land: initLand(seed),
    roads: [],
    trails: [],
    graded: [],
    towns: [],
    nextTownId: 2,
    expeditions: [],
    nextExpId: 1,
    routes: [],
    nextRouteId: 1,
    landEpoch: 0,
    eff: {},
    guide: [],
    stats: {
      births: 0,
      deaths: 0,
      immigrants: 0,
      peakPop: 0,
      maxGen: 1,
      tilesExplored: 0,
      buildingsBuilt: 0,
      playMs: 0,
      startedAt: now,
      victoryDay: null,
    },
  };

  state.towns.push({ id: 1, name: state.name, x: tx(map.start), y: ty(map.start), founded: 0, tier: 0, parent: null });

  const founders: [number, boolean][] = [
    [54, false],
    [36, true],
    [31, false],
    [27, true],
    [23, false],
    [19, true],
    [17, false],
    [5, true],
  ];
  for (const [age, f] of founders) {
    state.settlers.push(makeSettler(state, rng, -age * DAYS_PER_YEAR - rng.int(0, DAYS_PER_YEAR - 1), 1, 1, f));
  }
  state.stats.peakPop = state.settlers.length;

  // Reveal the land around the hearth.
  const sx = tx(map.start);
  const sy = ty(map.start);
  for (let y = sy - 6; y <= sy + 6; y++)
    for (let x = sx - 7; x <= sx + 7; x++) {
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
      if (Math.hypot((x - sx) * 0.9, y - sy) <= 6.2) state.explored[idx(x, y)] = 1;
    }
  state.stats.tilesExplored = state.explored.reduce((a, b) => a + b, 0);
  state.rng = rng.state;
  state.log.push({
    day: 0,
    kind: 'era',
    text: `Eight wanderers light a fire and name this place ${state.name}. The Age of Embers begins.`,
  });
  return state;
}

export function makeSettler(state: GameState, rng: Rng, born: number, gen: number, town: number, f?: boolean): Settler {
  const female = f ?? rng.chance(0.5);
  return { id: state.nextId++, name: settlerName(rng, female), born, gen, job: null, f: female, town };
}

export function ageOf(state: GameState, s: Settler): number {
  return (state.day - s.born) / DAYS_PER_YEAR;
}

export function isAdult(state: GameState, s: Settler) {
  const a = ageOf(state, s);
  return a >= ADULT_AGE && a < ELDER_AGE;
}

export function hasTech(state: GameState, t: TechId) {
  return state.techs.includes(t);
}

export function eraOf(state: GameState): number {
  let era = 0;
  if (hasTech(state, 'era_village')) era = 1;
  if (hasTech(state, 'era_bronze')) era = 2;
  if (hasTech(state, 'era_iron')) era = 3;
  if (hasTech(state, 'era_wonders')) era = 4;
  return era;
}

export function year(day: number) {
  return Math.floor(day / DAYS_PER_YEAR) + 1;
}

export function seasonIndex(day: number) {
  return Math.floor((day % DAYS_PER_YEAR) / (DAYS_PER_YEAR / 4));
}

export function dayOfSeason(day: number) {
  return (day % (DAYS_PER_YEAR / 4)) + 1;
}
