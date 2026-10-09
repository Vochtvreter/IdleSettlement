import type { BuildingId, Cost, JobId, ResourceId, TechId } from './types';
import { T } from './types';

/** Simulation calendar. */
export const DAYS_PER_SEASON = 10;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const ADULT_AGE = 13;
export const ELDER_AGE = 52;

export const MAP_W = 72;
export const MAP_H = 54;

export interface ResourceDef {
  name: string;
  baseCap: number;
  desc: string;
}

export const RESOURCE_DEFS: Record<ResourceId, ResourceDef> = {
  food: { name: 'Food', baseCap: 120, desc: 'Everyone eats every day. Children and elders eat less.' },
  wood: { name: 'Wood', baseCap: 100, desc: 'Building material, and fuel to keep warm in winter.' },
  stone: { name: 'Stone', baseCap: 80, desc: 'Sturdy building material from quarries.' },
  hides: { name: 'Hides', baseCap: 40, desc: 'From hunting and pastures. Used for clothing and crafts.' },
  ore: { name: 'Ore', baseCap: 60, desc: 'Dug from mountain mines. Smiths forge it into tools.' },
  tools: { name: 'Tools', baseCap: 40, desc: 'Boost labourers when in stock. Needed for great works.' },
  knowledge: { name: 'Knowledge', baseCap: Infinity, desc: 'Gathered by scholars and spent on discoveries.' },
};

export interface JobDef {
  name: string;
  plural: string;
  desc: string;
  tech?: TechId;
  /** Output per worker per day before modifiers. */
  output: Partial<Record<ResourceId, number>>;
  input?: Partial<Record<ResourceId, number>>;
  /** Whether stocked tools speed this job up. */
  usesTools: boolean;
  color: string;
}

export const JOB_DEFS: Record<JobId, JobDef> = {
  gatherer: {
    name: 'Gatherer',
    plural: 'Gatherers',
    desc: 'Forage berries, roots and nuts. Poor yields in winter.',
    output: { food: 1.8 },
    usesTools: false,
    color: '#7bc950',
  },
  hunter: {
    name: 'Hunter',
    plural: 'Hunters',
    desc: 'Track game in the wilds for meat and hides.',
    output: { food: 1.7, hides: 0.14 },
    usesTools: true,
    color: '#c0533a',
  },
  woodcutter: {
    name: 'Woodcutter',
    plural: 'Woodcutters',
    desc: 'Fell trees for wood. Lumber camps by forests work best.',
    output: { wood: 0.9 },
    usesTools: true,
    color: '#a8743c',
  },
  farmer: {
    name: 'Farmer',
    plural: 'Farmers',
    desc: 'Sow and harvest fields. Little grows in winter — store the surplus!',
    tech: 'agriculture',
    output: { food: 4.2 },
    usesTools: true,
    color: '#e8c547',
  },
  quarrier: {
    name: 'Quarrier',
    plural: 'Quarriers',
    desc: 'Cut stone from hills and cliffs.',
    tech: 'stone_tools',
    output: { stone: 0.6 },
    usesTools: true,
    color: '#9aa3ad',
  },
  miner: {
    name: 'Miner',
    plural: 'Miners',
    desc: 'Dig ore from the mountains. Rich veins yield double.',
    tech: 'mining',
    output: { ore: 0.38 },
    usesTools: true,
    color: '#5d6b8a',
  },
  smith: {
    name: 'Smith',
    plural: 'Smiths',
    desc: 'Forge ore and wood into tools.',
    tech: 'bronze',
    output: { tools: 0.22 },
    input: { ore: 0.4, wood: 0.25 },
    usesTools: false,
    color: '#e0703a',
  },
  scholar: {
    name: 'Scholar',
    plural: 'Scholars',
    desc: 'Storytellers and sages who accumulate knowledge.',
    output: { knowledge: 0.26 },
    usesTools: false,
    color: '#8b6cd9',
  },
  healer: {
    name: 'Healer',
    plural: 'Healers',
    desc: 'Tend the sick and the newborn. Reduces deaths from illness and age.',
    tech: 'herbalism',
    output: {},
    usesTools: false,
    color: '#e5e5e5',
  },
  scout: {
    name: 'Scout',
    plural: 'Scouts',
    desc: 'Explore the unknown, uncovering lands, ruins and lost tribes.',
    output: {},
    usesTools: false,
    color: '#3fb6a8',
  },
  builder: {
    name: 'Builder',
    plural: 'Builders',
    desc: 'Raise new buildings. Idle adults help a little too.',
    output: {},
    usesTools: true,
    color: '#d99a3d',
  },
};

export type TerrainRule = 'land' | 'open' | 'quarry' | 'mine' | 'forest-edge' | 'bridge';

export interface BuildingDef {
  name: string;
  desc: string;
  cost: Cost;
  work: number;
  tech?: TechId;
  rule: TerrainRule;
  housing?: number;
  slots?: Partial<Record<JobId, number>>;
  storage?: Partial<Record<ResourceId, number>>;
  territory: number;
  max?: number;
  /** Shown in the build menu as the key benefit. */
  benefit: string;
  /** Materials consumed gradually as construction progresses (on top of the up-front cost). */
  materials?: Cost;
  /** Adjacency hint shown when placing. */
  hint?: string;
}

/** Terrain that buildings may stand on. Forest only counts once its trees have been felled. */
export const BUILDABLE: ReadonlySet<T> = new Set([T.Sand, T.Grass, T.Meadow, T.Forest, T.Dense, T.Hills]);

export const BUILDING_DEFS: Record<BuildingId, BuildingDef> = {
  campfire: {
    name: 'Great Hearth',
    desc: 'The heart of your people. Shelter for a few, and a place for stories.',
    cost: {},
    work: 0,
    rule: 'land',
    housing: 10,
    slots: { hunter: 2, woodcutter: 2, scholar: 2, scout: 2 },
    territory: 5,
    max: 1,
    benefit: 'Housing 10',
  },
  hut: {
    name: 'Hut',
    desc: 'A simple dwelling of branches and hides. Families need homes to grow.',
    cost: { wood: 14 },
    work: 8,
    rule: 'land',
    housing: 4,
    storage: { food: 12 },
    territory: 2,
    benefit: '+4 housing',
  },
  lumber: {
    name: 'Lumber Camp',
    desc: 'A woodcutters’ camp. They fell the woods nearby and replant what they cut, so the forest grows back. Each neighbouring stand of trees adds +15% output.',
    cost: { wood: 20 },
    work: 12,
    rule: 'forest-edge',
    slots: { woodcutter: 3 },
    territory: 2,
    benefit: '+3 woodcutter slots',
    hint: 'Cleared land at a forest’s edge',
  },
  lodge: {
    name: 'Hunting Lodge',
    desc: 'Trappers and hunters base here. Nearby forests and game herds boost the hunt, but herds hunted too hard dwindle and take years to recover.',
    cost: { wood: 24 },
    work: 12,
    tech: 'hunting_traps',
    rule: 'land',
    slots: { hunter: 3 },
    territory: 2,
    benefit: '+3 hunter slots',
    hint: 'Place near forests & game',
  },
  storehouse: {
    name: 'Storehouse',
    desc: 'Dry, safe storage for your goods.',
    cost: { wood: 30, stone: 10 },
    work: 15,
    tech: 'stone_tools',
    rule: 'land',
    storage: { food: 60, wood: 100, stone: 100, hides: 40, ore: 60, tools: 40 },
    territory: 2,
    benefit: '+100 wood & stone storage',
  },
  quarry: {
    name: 'Quarry',
    desc: 'Cut stone from the hillside. Each neighbouring hill or mountain adds +10%. The rock runs out in time, and a worked-out quarry must be replaced.',
    cost: { wood: 28 },
    work: 15,
    tech: 'stone_tools',
    rule: 'quarry',
    slots: { quarrier: 4 },
    territory: 2,
    benefit: '+4 quarrier slots',
    hint: 'On hills, or beside mountains',
  },
  farm: {
    name: 'Farm',
    desc: 'Tilled fields. +30% next to rivers or lakes, +10% on meadows. Can be sown on felled forest.',
    cost: { wood: 30, stone: 10 },
    work: 18,
    tech: 'agriculture',
    rule: 'open',
    slots: { farmer: 4 },
    territory: 2,
    benefit: '+4 farmer slots',
    hint: 'Open land, best by water',
  },
  granary: {
    name: 'Granary',
    desc: 'Clay-sealed food storage, so the harvest lasts through winter.',
    cost: { wood: 40, stone: 30 },
    work: 20,
    tech: 'pottery',
    rule: 'land',
    storage: { food: 400 },
    territory: 2,
    benefit: '+400 food storage',
  },
  watchtower: {
    name: 'Watchtower',
    desc: 'Scouts see far from its heights. Reveals the land around it and deters wolves and raiders.',
    cost: { wood: 30, stone: 25 },
    work: 18,
    tech: 'scouting',
    rule: 'land',
    slots: { scout: 2 },
    territory: 4,
    benefit: '+2 scout slots, defence',
  },
  herbalist: {
    name: 'Herbalist',
    desc: 'A hut of drying herbs and poultices.',
    cost: { wood: 30, stone: 20, hides: 10 },
    work: 18,
    tech: 'herbalism',
    rule: 'land',
    slots: { healer: 2 },
    territory: 2,
    benefit: '+2 healer slots',
  },
  pasture: {
    name: 'Pasture',
    desc: 'Fenced grazing where tamed animals are bred. The herd grows over the seasons and gives food and hides without hunting the wild.',
    cost: { wood: 40, hides: 10 },
    work: 16,
    tech: 'husbandry',
    rule: 'open',
    territory: 2,
    benefit: 'Up to +1.8 food, +0.15 hides /day',
  },
  mine: {
    name: 'Mine',
    desc: 'Shafts into the mountainside. Next to a rich ore vein, yields are doubled. Veins run dry, and so in time does the mountain.',
    cost: { wood: 50, stone: 40 },
    work: 25,
    tech: 'mining',
    rule: 'mine',
    slots: { miner: 3 },
    territory: 2,
    benefit: '+3 miner slots',
    hint: 'On hills or beside mountains; ore veins ×2',
  },
  smithy: {
    name: 'Smithy',
    desc: 'A forge where ore becomes tools.',
    cost: { wood: 40, stone: 60, ore: 10 },
    work: 25,
    tech: 'bronze',
    rule: 'land',
    slots: { smith: 2 },
    territory: 2,
    benefit: '+2 smith slots',
  },
  library: {
    name: 'Library',
    desc: 'Clay tablets and scrolls. Each library makes all scholars 10% wiser.',
    cost: { wood: 60, stone: 80, hides: 20 },
    work: 30,
    tech: 'writing',
    rule: 'land',
    slots: { scholar: 3 },
    territory: 2,
    benefit: '+3 scholar slots, +10% knowledge',
  },
  house: {
    name: 'Stone House',
    desc: 'Solid stone walls keep a large family warm, using less firewood.',
    cost: { wood: 20, stone: 45 },
    work: 22,
    tech: 'masonry',
    rule: 'land',
    housing: 8,
    storage: { food: 30 },
    territory: 2,
    benefit: '+8 housing',
  },
  shrine: {
    name: 'Temple',
    desc: 'A sacred place that lifts the spirits of all.',
    cost: { wood: 40, stone: 80, tools: 10 },
    work: 30,
    tech: 'faith',
    rule: 'land',
    territory: 3,
    max: 3,
    benefit: '+8 morale',
  },
  bridge: {
    name: 'Bridge',
    desc: 'Timber spans across a river, so your people can settle and work the far bank.',
    cost: { wood: 24 },
    work: 10,
    rule: 'bridge',
    territory: 2,
    benefit: 'Opens the far bank',
    hint: 'On a river, next to land you can reach',
  },
  monument: {
    name: 'The Sunspire',
    desc: 'A towering beacon of stone and bronze, the legacy of your people for all ages. It consumes vast materials as it rises. Completing it wins the game.',
    cost: { wood: 150, stone: 200 },
    materials: { wood: 800, stone: 1600, ore: 300, tools: 200, knowledge: 600 },
    work: 2400,
    tech: 'architecture',
    rule: 'land',
    territory: 6,
    max: 1,
    benefit: 'Victory!',
  },
};

export const BUILD_ORDER: BuildingId[] = [
  'hut',
  'lumber',
  'bridge',
  'lodge',
  'storehouse',
  'quarry',
  'farm',
  'granary',
  'watchtower',
  'herbalist',
  'pasture',
  'house',
  'mine',
  'smithy',
  'library',
  'shrine',
  'monument',
];

export interface EraDef {
  name: string;
  short: string;
  blurb: string;
}

export const ERAS: EraDef[] = [
  { name: 'Age of Embers', short: 'Embers', blurb: 'A handful of wanderers huddle around a fire at the edge of the known world.' },
  { name: 'Age of Fields', short: 'Fields', blurb: 'Your people put down roots, tilling soil and taming beasts.' },
  { name: 'Age of Bronze', short: 'Bronze', blurb: 'Fire and ore give birth to metal. Words are pressed into clay.' },
  { name: 'Age of Iron', short: 'Iron', blurb: 'Iron ploughs and iron wills. Your settlement becomes a town.' },
  { name: 'Age of Wonders', short: 'Wonders', blurb: 'Your people dream of building something that will outlast them all.' },
];

export interface TechDef {
  name: string;
  desc: string;
  era: number;
  cost: Cost;
  requires?: TechId[];
  minPop?: number;
  /** If set, researching this advances the settlement into the given era. */
  advancesTo?: number;
}

export const TECH_DEFS: Record<TechId, TechDef> = {
  stone_tools: { name: 'Stone Tools', era: 0, cost: { knowledge: 12 }, desc: 'Unlocks Quarries, Quarriers and Storehouses. Woodcutters +20%.' },
  hunting_traps: { name: 'Snares & Traps', era: 0, cost: { knowledge: 10 }, desc: 'Unlocks Hunting Lodges. Hunters +15%.' },
  oral_tradition: { name: 'Oral Tradition', era: 0, cost: { knowledge: 18 }, desc: 'Scholars +25%. Elders share wisdom (+knowledge).' },
  furs: { name: 'Fur Clothing', era: 0, cost: { knowledge: 20, hides: 12 }, requires: ['hunting_traps'], desc: 'Warm clothes: winter firewood need -40%, fewer cold deaths.' },
  era_village: { name: 'Village Life', era: 0, cost: { knowledge: 40, wood: 60 }, requires: ['stone_tools'], minPop: 14, advancesTo: 1, desc: 'Settle down for good. Enter the Age of Fields.' },

  agriculture: { name: 'Agriculture', era: 1, cost: { knowledge: 45 }, desc: 'Unlocks Farms and Farmers.' },
  pottery: { name: 'Pottery', era: 1, cost: { knowledge: 45, stone: 20 }, desc: 'Unlocks Granaries to store the harvest.' },
  scouting: { name: 'Pathfinding', era: 1, cost: { knowledge: 40 }, desc: 'Unlocks Watchtowers. Scouts +50%.' },
  herbalism: { name: 'Herbalism', era: 1, cost: { knowledge: 60 }, desc: 'Unlocks Herbalists and Healers.' },
  husbandry: { name: 'Animal Husbandry', era: 1, cost: { knowledge: 70, food: 40 }, requires: ['agriculture'], desc: 'Unlocks Pastures. Hunters +15%.' },
  era_bronze: { name: 'Chiefdom', era: 1, cost: { knowledge: 120, stone: 100 }, requires: ['agriculture'], minPop: 28, advancesTo: 2, desc: 'Unite the families under one chief. Enter the Age of Bronze.' },

  mining: { name: 'Mining', era: 2, cost: { knowledge: 120 }, desc: 'Unlocks Mines and Miners.' },
  bronze: { name: 'Bronze Working', era: 2, cost: { knowledge: 150, ore: 30 }, requires: ['mining'], desc: 'Unlocks Smithies. Smiths turn ore into tools.' },
  writing: { name: 'Writing', era: 2, cost: { knowledge: 140 }, desc: 'Unlocks Libraries. Scholars +25%.' },
  masonry: { name: 'Masonry', era: 2, cost: { knowledge: 160, stone: 80 }, desc: 'Unlocks Stone Houses. Quarriers +25%.' },
  the_wheel: { name: 'The Wheel', era: 2, cost: { knowledge: 130, wood: 80 }, desc: 'Builders +50%. Farmers +10%.' },
  era_iron: { name: 'Township', era: 2, cost: { knowledge: 320, tools: 40 }, requires: ['bronze', 'writing'], minPop: 45, advancesTo: 3, desc: 'Laws, markets and roads. Enter the Age of Iron.' },

  iron: { name: 'Iron Smelting', era: 3, cost: { knowledge: 340, ore: 80 }, desc: 'Smiths +60%. Tools grant a larger bonus.' },
  medicine: { name: 'Medicine', era: 3, cost: { knowledge: 320, hides: 40 }, requires: [], desc: 'People live ~10 years longer. Healers +50%.' },
  plough: { name: 'Iron Plough', era: 3, cost: { knowledge: 300, tools: 30 }, desc: 'Farmers +40%.' },
  mathematics: { name: 'Mathematics', era: 3, cost: { knowledge: 400 }, desc: 'Builders +30%, knowledge +15%.' },
  faith: { name: 'Faith', era: 3, cost: { knowledge: 280 }, desc: 'Unlocks Temples. Morale +5.' },
  era_wonders: { name: 'Golden Age', era: 3, cost: { knowledge: 700, tools: 80 }, requires: ['iron', 'mathematics'], minPop: 60, advancesTo: 4, desc: 'A flourishing of art and ambition. Enter the Age of Wonders.' },

  architecture: { name: 'Architecture', era: 4, cost: { knowledge: 900 }, desc: 'The knowledge to raise the Sunspire, a wonder to outlast the ages.' },
};

export const TECH_ORDER = Object.keys(TECH_DEFS) as TechId[];

export const TERRAIN_NAMES: Record<number, string> = {
  [T.Deep]: 'Deep Water',
  [T.Water]: 'Shallows',
  [T.Sand]: 'Sand',
  [T.Grass]: 'Grassland',
  [T.Meadow]: 'Meadow',
  [T.Forest]: 'Forest',
  [T.Dense]: 'Old Forest',
  [T.Hills]: 'Hills',
  [T.Mountain]: 'Mountain',
  [T.Peak]: 'Snowy Peak',
  [T.River]: 'River',
};

export const FEATURE_NAMES: Record<number, string> = {
  0: '',
  1: 'Berry Thicket',
  2: 'Game Herd',
  3: 'Ore Vein',
  4: 'Ancient Ruins',
  5: 'Wanderer Camp',
  6: 'Sacred Grove',
  7: 'Fishing Waters',
  8: 'Forgotten Cache',
};

/** Exploration points needed to reveal a tile, by terrain. */
export const EXPLORE_COST: Record<number, number> = {
  [T.Deep]: 1.2,
  [T.Water]: 1.2,
  [T.Sand]: 2,
  [T.Grass]: 2.2,
  [T.Meadow]: 2.2,
  [T.Forest]: 3,
  [T.Dense]: 3.6,
  [T.Hills]: 3.5,
  [T.Mountain]: 5,
  [T.Peak]: 6,
  [T.River]: 1.6,
};
