export const RESOURCES = ['food', 'wood', 'stone', 'hides', 'ore', 'tools', 'knowledge'] as const;
export type ResourceId = (typeof RESOURCES)[number];
export type Resources = Record<ResourceId, number>;
export type Cost = Partial<Resources>;

export const JOBS = [
  'gatherer',
  'hunter',
  'woodcutter',
  'farmer',
  'quarrier',
  'miner',
  'smith',
  'scholar',
  'healer',
  'scout',
  'builder',
] as const;
export type JobId = (typeof JOBS)[number];

export type BuildingId =
  | 'campfire'
  | 'hut'
  | 'lumber'
  | 'lodge'
  | 'storehouse'
  | 'quarry'
  | 'farm'
  | 'granary'
  | 'watchtower'
  | 'herbalist'
  | 'pasture'
  | 'mine'
  | 'smithy'
  | 'library'
  | 'house'
  | 'shrine'
  | 'bridge'
  | 'monument';

export type TechId =
  | 'stone_tools'
  | 'hunting_traps'
  | 'oral_tradition'
  | 'furs'
  | 'era_village'
  | 'agriculture'
  | 'pottery'
  | 'scouting'
  | 'herbalism'
  | 'husbandry'
  | 'era_bronze'
  | 'mining'
  | 'bronze'
  | 'writing'
  | 'masonry'
  | 'the_wheel'
  | 'era_iron'
  | 'iron'
  | 'medicine'
  | 'plough'
  | 'mathematics'
  | 'faith'
  | 'era_wonders'
  | 'architecture';

export enum T {
  Deep = 0,
  Water = 1,
  Sand = 2,
  Grass = 3,
  Meadow = 4,
  Forest = 5,
  Dense = 6,
  Hills = 7,
  Mountain = 8,
  Peak = 9,
  River = 10,
}

export enum F {
  None = 0,
  Berries = 1,
  Game = 2,
  Ore = 3,
  Ruins = 4,
  Tribe = 5,
  Grove = 6,
  Fish = 7,
  Cache = 8,
}

export interface Settler {
  id: number;
  name: string;
  /** Day number this settler was born on (may be negative for founders). */
  born: number;
  gen: number;
  job: JobId | null;
  /** Female/male — purely for naming and pairing flavour. */
  f: boolean;
}

export interface Building {
  id: number;
  type: BuildingId;
  x: number;
  y: number;
  /** Work points invested. Complete when `done`. */
  progress: number;
  done: boolean;
  /** Pastures: the size of the herd bred there. */
  stock?: number;
  /** Quarries and mines whose ground has been worked out. */
  spent?: boolean;
}

/** What is left of the land's natural resources, per tile. Wood regrows, stone and ore do not, wildlife breeds. */
export interface Land {
  wood: number[];
  stone: number[];
  ore: number[];
  /** Game herds, fishing waters and berry thickets. */
  life: number[];
}
export type LandLayer = keyof Land;

export interface LogEntry {
  day: number;
  text: string;
  kind: 'info' | 'good' | 'bad' | 'birth' | 'death' | 'discovery' | 'era' | 'build';
}

export interface Modifier {
  id: string;
  label: string;
  until: number;
  /** Multipliers keyed by job id, or special keys: morale (additive), winter, births. */
  effects: Record<string, number>;
}

export interface ChoiceOption {
  label: string;
  /** Effect handled in events.ts by key. */
  key: string;
  cost?: Cost;
  gain?: Cost;
}

export interface PendingChoice {
  id: string;
  title: string;
  text: string;
  options: ChoiceOption[];
  expires: number;
}

export interface Stats {
  births: number;
  deaths: number;
  immigrants: number;
  peakPop: number;
  maxGen: number;
  tilesExplored: number;
  buildingsBuilt: number;
  playMs: number;
  startedAt: number;
  victoryDay: number | null;
}

export interface GameState {
  version: number;
  seed: number;
  rng: number;
  name: string;
  day: number;
  res: Resources;
  settlers: Settler[];
  nextId: number;
  jobTargets: Record<JobId, number>;
  buildings: Building[];
  nextBuildingId: number;
  techs: TechId[];
  /** Explored flag per tile, 0/1. */
  explored: number[];
  /** Tile indices whose feature has been claimed (discovery resolved). */
  claimed: number[];
  exploreProgress: number;
  exploreTarget: number | null;
  morale: number;
  modifiers: Modifier[];
  log: LogEntry[];
  choice: PendingChoice | null;
  /** Index of the next milestone to complete. */
  objective: number;
  /** Chosen option per decision id (focus, policies and paths). */
  decisions: Record<string, string>;
  /** Day each policy was last changed (for the cooldown). */
  decidedDay: Record<string, number>;
  tweaks: Partial<Record<'reserve' | 'housing' | 'scouts' | 'builders', number>>;
  /** Which areas the council manages automatically. */
  council: { jobs: boolean; build: boolean; research: boolean };
  /** Discovery the council should research next. */
  pin: TechId | null;
  victory: boolean;
  defeat: boolean;
  legacy: number;
  lastSave: number;
  stats: Stats;
  /** Sustained-shortage trackers (0..1) used for hunger/cold. */
  hunger: number;
  cold: number;
  land: Land;
  /** Tiles that carry a road (the village green around the hearth is implicit). */
  roads: number[];
  /** Bumped whenever the land changes in a way that affects building rules or slots. */
  landEpoch: number;
  /** Smoothed share of the full output each job actually achieved, given what the land had left. */
  eff: Partial<Record<JobId, number>>;
  /** Guide tips already shown. Missing on saves from before the guide existed (treated as all seen). */
  guide?: string[];
}

/** Transient, non-saved per-tick breakdowns for UI tooltips and visual effects. */
export interface Rates {
  prod: Record<ResourceId, Record<string, number>>;
  cons: Record<ResourceId, Record<string, number>>;
}

export type FxEvent =
  | { kind: 'birth'; settler: number }
  | { kind: 'death'; settler: number }
  | { kind: 'built'; building: number }
  | { kind: 'discover'; tile: number }
  | { kind: 'era'; era: number }
  | { kind: 'arrive'; count: number };
