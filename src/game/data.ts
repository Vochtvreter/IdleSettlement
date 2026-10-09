import type { BuildingId, Cost, JobId, ResourceId, TechId } from './types';
import { Biome, T } from './types';

/** Simulation calendar. */
export const DAYS_PER_SEASON = 10;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const ADULT_AGE = 13;
export const ELDER_AGE = 52;

/** A world large enough for several cities, with oceans between its continents. */
export const MAP_W = 720;
export const MAP_H = 540;

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
  tools: { name: 'Tools', baseCap: 40, desc: 'Each labourer with a tool works better. Tools wear out with use. Needed for great works.' },
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
    desc: 'Set out in parties to explore the unknown, uncovering lands, ruins and lost tribes. What they see is only known once they are home again, and the wilds are dangerous.',
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

export type TerrainRule = 'land' | 'open' | 'quarry' | 'mine' | 'forest-edge' | 'bridge' | 'coast';

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
  /** Footprint in tiles [width, height]; 1×1 when absent. */
  size?: [number, number];
  /** Smallest settlement tier (see TIERS) that may raise it. */
  tier?: number;
}

/**
 * Terrain that buildings may stand on. Standing trees are felled and rock is levelled first, as part of
 * the site's preparation, so building on forest, hills or a mountainside simply takes longer.
 */
export const BUILDABLE: ReadonlySet<T> = new Set([T.Sand, T.Grass, T.Meadow, T.Forest, T.Dense, T.Hills, T.Mountain]);

/** Work to level one tile of rock before anything can be built on it, and the stone it yields. */
export const LEVEL_WORK: Partial<Record<T, number>> = { [T.Hills]: 3, [T.Mountain]: 30 };
export const LEVEL_STONE: Partial<Record<T, number>> = { [T.Hills]: 4, [T.Mountain]: 20 };
/** Work to fell one unit of standing timber when clearing a site. */
export const FELL_WORK = 1 / 12;

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
    size: [2, 1],
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
    size: [2, 1],
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
    size: [2, 2],
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
    size: [2, 2],
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
    size: [2, 2],
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
    size: [2, 1],
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
    size: [2, 1],
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
    size: [2, 2],
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
  harbour: {
    name: 'Harbour',
    desc: 'A boathouse and pier on the sea. Galleys sail from here to chart unknown coasts, carry colonists overseas and keep trade routes across the water.',
    cost: { wood: 60, stone: 20 },
    work: 24,
    tech: 'seafaring',
    rule: 'coast',
    storage: { food: 40, wood: 40 },
    territory: 3,
    benefit: 'Galleys, sea routes',
    hint: 'On the shore of the open sea',
    size: [2, 1],
  },
  manor: {
    name: 'Town Block',
    desc: 'Tall stone houses crowded around a courtyard, where a town packs its people in.',
    cost: { wood: 40, stone: 110 },
    work: 40,
    tech: 'masonry',
    rule: 'land',
    housing: 24,
    storage: { food: 60 },
    territory: 2,
    benefit: '+24 housing',
    hint: 'In a town or city',
    size: [2, 2],
    tier: 2,
  },
  monument: {
    name: 'The Sunspire',
    desc: 'A towering beacon of stone and bronze, the legacy of your people for all ages. It consumes vast materials as it rises. Completing it wins the game.',
    cost: { wood: 150, stone: 200 },
    materials: { wood: 20000, stone: 40000, ore: 8000, tools: 5000, knowledge: 16000 },
    work: 60000,
    tech: 'architecture',
    rule: 'land',
    territory: 6,
    max: 1,
    benefit: 'Victory!',
    size: [2, 2],
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
  'manor',
  'mine',
  'smithy',
  'library',
  'shrine',
  'harbour',
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
  /** Settlements the realm must have. */
  minTowns?: number;
  /** A settlement of at least this tier (see TIERS) the realm must have. */
  minTier?: number;
  /** If set, researching this advances the settlement into the given era. */
  advancesTo?: number;
}

export const TECH_DEFS: Record<TechId, TechDef> = {
  stone_tools: { name: 'Stone Tools', era: 0, cost: { knowledge: 12 }, desc: 'Unlocks Quarries, Quarriers and Storehouses. Woodcutters +20%.' },
  hunting_traps: { name: 'Snares & Traps', era: 0, cost: { knowledge: 10 }, desc: 'Unlocks Hunting Lodges. Hunters +15%.' },
  oral_tradition: { name: 'Oral Tradition', era: 0, cost: { knowledge: 18 }, desc: 'Scholars +25%. Elders share wisdom (+knowledge).' },
  furs: { name: 'Fur Clothing', era: 0, cost: { knowledge: 20, hides: 12 }, requires: ['hunting_traps'], desc: 'Warm clothes: winter firewood need -40%, fewer cold deaths.' },
  era_village: { name: 'Village Life', era: 0, cost: { knowledge: 40, wood: 60 }, requires: ['stone_tools'], minPop: 14, advancesTo: 1, desc: 'Settle down for good. Enter the Age of Fields.' },

  agriculture: { name: 'Agriculture', era: 1, cost: { knowledge: 90 }, desc: 'Unlocks Farms and Farmers.' },
  pottery: { name: 'Pottery', era: 1, cost: { knowledge: 90, stone: 20 }, desc: 'Unlocks Granaries to store the harvest.' },
  scouting: { name: 'Pathfinding', era: 1, cost: { knowledge: 80 }, desc: 'Unlocks Watchtowers. Scouting parties travel faster, see further and come to less harm. Pioneers can blaze trails into the wilds and found new settlements.' },
  herbalism: { name: 'Herbalism', era: 1, cost: { knowledge: 120 }, desc: 'Unlocks Herbalists and Healers.' },
  husbandry: { name: 'Animal Husbandry', era: 1, cost: { knowledge: 140, food: 40 }, requires: ['agriculture'], desc: 'Unlocks Pastures. Hunters +15%.' },
  era_bronze: { name: 'Chiefdom', era: 1, cost: { knowledge: 240, stone: 100 }, requires: ['agriculture'], minPop: 50, advancesTo: 2, desc: 'Unite the families under one chief. Enter the Age of Bronze.' },

  mining: { name: 'Mining', era: 2, cost: { knowledge: 720 }, desc: 'Unlocks Mines and Miners.' },
  bronze: { name: 'Bronze Working', era: 2, cost: { knowledge: 900, ore: 60 }, requires: ['mining'], desc: 'Unlocks Smithies. Smiths turn ore into tools.' },
  writing: { name: 'Writing', era: 2, cost: { knowledge: 840 }, desc: 'Unlocks Libraries. Scholars +25%.' },
  masonry: { name: 'Masonry', era: 2, cost: { knowledge: 960, stone: 160 }, desc: 'Unlocks Stone Houses. Quarriers +25%.' },
  the_wheel: { name: 'The Wheel', era: 2, cost: { knowledge: 780, wood: 160 }, desc: 'Builders +50%. Farmers +10%. Carts can run the busiest ways between settlements as trade routes.' },
  seafaring: { name: 'Seafaring', era: 2, cost: { knowledge: 900, wood: 160 }, desc: 'Unlocks Harbours. Galleys chart the seas, carry colonists to other lands and sail trade routes.' },
  era_iron: { name: 'Township', era: 2, cost: { knowledge: 1920, tools: 80 }, requires: ['bronze', 'writing'], minPop: 250, minTowns: 6, minTier: 3, advancesTo: 3, desc: 'Laws, markets and roads. Enter the Age of Iron.' },

  iron: { name: 'Iron Smelting', era: 3, cost: { knowledge: 4080, ore: 280 }, desc: 'Smiths +60%. Tools grant a larger bonus.' },
  medicine: { name: 'Medicine', era: 3, cost: { knowledge: 3840, hides: 140 }, requires: [], desc: 'People live ~10 years longer. Healers +50%.' },
  plough: { name: 'Iron Plough', era: 3, cost: { knowledge: 3600, tools: 105 }, desc: 'Farmers +40%.' },
  mathematics: { name: 'Mathematics', era: 3, cost: { knowledge: 4800 }, desc: 'Builders +30%, knowledge +15%.' },
  faith: { name: 'Faith', era: 3, cost: { knowledge: 3360 }, desc: 'Unlocks Temples. Morale +5.' },
  era_wonders: { name: 'Golden Age', era: 3, cost: { knowledge: 8400, tools: 280 }, requires: ['iron', 'mathematics'], minPop: 900, minTowns: 14, minTier: 4, advancesTo: 4, desc: 'A flourishing of art and ambition. Enter the Age of Wonders.' },

  architecture: { name: 'Architecture', era: 4, cost: { knowledge: 150000 }, minTowns: 18, desc: 'The knowledge to raise the Sunspire, a wonder to outlast the ages.' },
};

export const TECH_ORDER = Object.keys(TECH_DEFS) as TechId[];

export interface BiomeDef {
  name: string;
  desc: string;
  /** Harvest multiplier for farms. */
  farm: number;
  /** Hunting multiplier (and the hides it yields). */
  hunt: number;
}

export const BIOMES: Record<Biome, BiomeDef> = {
  [Biome.Temperate]: { name: 'Temperate', desc: 'Mild lands of mixed woods and fertile meadows.', farm: 1, hunt: 1 },
  [Biome.Boreal]: { name: 'Boreal', desc: 'Cold northern pine forest and tundra. Thin harvests, but rich in game and furs.', farm: 0.7, hunt: 1.25 },
  [Biome.Arid]: { name: 'Arid', desc: 'Hot, dry steppe and desert. Little timber and thin soil except where a river waters an oasis, but the hills are rich in ore.', farm: 0.65, hunt: 0.8 },
  [Biome.Tropical]: { name: 'Tropical', desc: 'Hot, wet jungle and lush coasts. Timber grows back fast, and fruit and fish abound.', farm: 1.15, hunt: 1 },
};

export interface TierDef {
  name: string;
  /** People living there. */
  pop: number;
  /** Finished buildings belonging to it. */
  buildings: number;
  /** Age the realm must have reached. */
  era: number;
  /** Extra territory around its hearth. */
  reach: number;
}

/** How a settlement grows: from a pioneers' camp to a metropolis. */
export const TIERS: TierDef[] = [
  { name: 'Camp', pop: 0, buildings: 0, era: 0, reach: 0 },
  { name: 'Village', pop: 12, buildings: 4, era: 0, reach: 1 },
  { name: 'Town', pop: 32, buildings: 12, era: 1, reach: 3 },
  { name: 'City', pop: 90, buildings: 30, era: 2, reach: 5 },
  { name: 'Metropolis', pop: 220, buildings: 60, era: 3, reach: 7 },
];

/** Pioneers who set out to found a settlement, and what they take with them. */
export const PIONEERS = 5;
export const PIONEER_SUPPLIES: Cost = { food: 40, wood: 30 };
/** A galley to carry them, or to sail a sea route. */
export const GALLEY_COST: Cost = { wood: 60, hides: 10 };
/**
 * Travel between two settlements that wears a trail between them, opens a cart route along it, and
 * gets builders paving it into a road (paved tile by tile, a stone each).
 */
export const TRAFFIC_TRAIL = 300;
export const TRAFFIC_ROUTE = 1200;
export const TRAFFIC_PAVE = 3000;
export const PAVE_WORK = 1.5;
export const PAVE_STONE = 1;
/** New settlements keep this far from each other. */
export const TOWN_SPACING = 15;

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

/** Local names for terrain in each climate. */
const BIOME_TERRAIN: Partial<Record<Biome, Partial<Record<number, string>>>> = {
  [Biome.Boreal]: { [T.Grass]: 'Tundra', [T.Meadow]: 'Heath', [T.Forest]: 'Pine Forest', [T.Dense]: 'Taiga' },
  [Biome.Arid]: { [T.Sand]: 'Desert', [T.Grass]: 'Steppe', [T.Meadow]: 'Savanna', [T.Forest]: 'Scrubland', [T.Dense]: 'Oasis Grove' },
  [Biome.Tropical]: { [T.Forest]: 'Palm Forest', [T.Dense]: 'Jungle', [T.Meadow]: 'Lush Meadow' },
};

export function terrainName(t: number, biome: Biome = Biome.Temperate) {
  return BIOME_TERRAIN[biome]?.[t] ?? TERRAIN_NAMES[t];
}

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

/** Days for a scouting party to cross a tile on foot, by terrain (Infinity where they cannot go). */
export const SCOUT_DAYS: Record<number, number> = {
  [T.Deep]: Infinity,
  [T.Water]: Infinity,
  [T.Sand]: 0.3,
  [T.Grass]: 0.25,
  [T.Meadow]: 0.25,
  [T.Forest]: 0.4,
  [T.Dense]: 0.55,
  [T.Hills]: 0.45,
  [T.Mountain]: 0.9,
  [T.Peak]: Infinity,
  [T.River]: 0.7,
};
/** Most scouts in one party. */
export const PARTY_SIZE = 3;
/** Days scouts rest at home between trips. */
export const SCOUT_REST = 3;
/** How worn down a party may get before it makes camp for the night. */
export const CAMP_AT = 3;
