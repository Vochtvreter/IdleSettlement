import { ERAS, TECH_DEFS } from './data';
import { invalidate } from './derived';
import type { GameState, FxEvent, TechId } from './types';

/**
 * Decisions are the heart of the game: the council runs the settlement day to day,
 * while the player sets its direction. Three kinds:
 *  - focus:  what the council prioritises (free to change)
 *  - policy: trade-offs, changeable once per season, unlocked by milestones
 *  - path:   permanent choices; the era paths are how a settlement enters a new age
 */
export type Effects = Record<string, number>;

export interface DecisionOption {
  id: string;
  name: string;
  desc: string;
  fx: Effects;
}

export interface DecisionDef {
  id: string;
  kind: 'focus' | 'policy' | 'path';
  name: string;
  prompt: string;
  options: DecisionOption[];
  /** Milestone that must be completed first (index into MILESTONES), or -1 for always. */
  unlock: number;
  /** Era-path decisions: the tech whose requirements & cost gate the choice. */
  tech?: TechId;
  /** Default option for policies (the neutral choice). */
  initial?: string;
}

/** Keys in Effects that add rather than multiply. */
export const ADDITIVE = new Set(['morale', 'life']);
/** Jobs boosted by the 'labour' effect. */
export const LABOUR = new Set(['gatherer', 'hunter', 'woodcutter', 'farmer', 'quarrier', 'miner', 'smith', 'builder']);

export const POLICY_COOLDOWN = 10;

export const DECISIONS: DecisionDef[] = [
  // ------------------------------------------------------------ focus
  {
    id: 'focus',
    kind: 'focus',
    name: 'Council Focus',
    prompt: 'What should the council put first when it assigns work, builds and researches?',
    unlock: -1,
    initial: 'balanced',
    options: [
      { id: 'balanced', name: 'Balanced', desc: 'A bit of everything.', fx: {} },
      { id: 'growth', name: 'Growth', desc: 'Food, homes and families first.', fx: {} },
      { id: 'industry', name: 'Industry', desc: 'Wood, stone, ore and tools.', fx: {} },
      { id: 'knowledge', name: 'Knowledge', desc: 'Scholars and libraries.', fx: {} },
      { id: 'explore', name: 'Exploration', desc: 'More scouts; push into the unknown.', fx: {} },
    ],
  },
  // ------------------------------------------------------------ paths
  {
    id: 'way',
    kind: 'path',
    name: 'The Founding Way',
    prompt: 'Around the first fire, the elders ask: what kind of people will we be?',
    unlock: -1,
    options: [
      { id: 'hunt', name: 'Way of the Hunt', desc: 'Hunters +35%. Wolves and raiders are driven off more easily.', fx: { hunter: 1.35, defense: 1.3 } },
      { id: 'grove', name: 'Way of the Grove', desc: 'Gatherers +30%, the land feeds more foragers, morale +4.', fx: { gatherer: 1.3, forage: 1.3, morale: 4 } },
      { id: 'hearth', name: 'Way of the Hearth', desc: 'Scholars +30% and more children are born.', fx: { scholar: 1.3, births: 1.2 } },
    ],
  },
  {
    id: 'path1',
    kind: 'path',
    name: 'Into the Age of Fields',
    prompt: 'Your people are ready to settle for good. How will they live off the land?',
    unlock: -1,
    tech: 'era_village',
    options: [
      { id: 'tillers', name: 'Tillers of the Soil', desc: 'Farmers +25%. Granaries hold 25% more.', fx: { farmer: 1.25, foodStore: 1.25 } },
      { id: 'herders', name: 'Herders of the Plain', desc: 'Pastures produce double. Hunters +20%.', fx: { pasture: 2, hunter: 1.2 } },
      { id: 'roads', name: 'The Wanderers’ Road', desc: 'Scouts +75%, discoveries yield double, more newcomers.', fx: { scout: 1.75, discovery: 2, immigration: 1.5 } },
    ],
  },
  {
    id: 'path2',
    kind: 'path',
    name: 'Into the Age of Bronze',
    prompt: 'The families unite under one banner. What will your chiefdom be known for?',
    unlock: -1,
    tech: 'era_bronze',
    options: [
      { id: 'merchants', name: 'Merchant Houses', desc: 'Storage +30%. Traders visit twice as often with better deals.', fx: { storage: 1.3, trade: 2 } },
      { id: 'warriors', name: 'Warrior Clans', desc: 'Raids are almost always repelled. Morale +5.', fx: { defense: 2.2, morale: 5 } },
      { id: 'lore', name: 'Keepers of Lore', desc: 'All knowledge +30%.', fx: { knowledge: 1.3 } },
    ],
  },
  {
    id: 'path3',
    kind: 'path',
    name: 'Into the Age of Iron',
    prompt: 'A township rises. Which of its crafts will you hold above the rest?',
    unlock: -1,
    tech: 'era_iron',
    options: [
      { id: 'engineers', name: 'Guild of Engineers', desc: 'Builders +50%, quarriers +20%.', fx: { builder: 1.5, quarrier: 1.2 } },
      { id: 'physicians', name: 'House of Physicians', desc: 'People live 8 years longer. Fevers are half as deadly.', fx: { life: 8, disease: 0.5, healer: 1.5 } },
      { id: 'artisans', name: 'Artisan Quarter', desc: 'Smiths +40%, miners +20%, tools wear out half as fast.', fx: { smith: 1.4, miner: 1.2, toolWear: 0.5 } },
    ],
  },
  {
    id: 'path4',
    kind: 'path',
    name: 'Into the Age of Wonders',
    prompt: 'A golden age dawns. What vision will guide the building of your wonder?',
    unlock: -1,
    tech: 'era_wonders',
    options: [
      { id: 'sun', name: 'Children of the Sun', desc: 'Morale +10. The Sunspire needs 20% less work.', fx: { morale: 10, monumentWork: 0.8 } },
      { id: 'reason', name: 'Age of Reason', desc: 'Knowledge +25%. The Sunspire needs 20% fewer materials.', fx: { knowledge: 1.25, monumentMat: 0.8 } },
      { id: 'empire', name: 'Imperial Ambition', desc: 'All labourers +12%.', fx: { labour: 1.12 } },
    ],
  },
  // ------------------------------------------------------------ policies
  {
    id: 'rations',
    kind: 'policy',
    name: 'Rations',
    prompt: 'How much does each person eat?',
    unlock: 0,
    initial: 'normal',
    options: [
      { id: 'generous', name: 'Generous', desc: 'Food eaten +15%, morale +8.', fx: { foodUse: 1.15, morale: 8 } },
      { id: 'normal', name: 'Normal', desc: 'No change.', fx: {} },
      { id: 'strict', name: 'Strict', desc: 'Food eaten −20%, morale −8.', fx: { foodUse: 0.8, morale: -8 } },
    ],
  },
  {
    id: 'workday',
    kind: 'policy',
    name: 'Working Hours',
    prompt: 'How long do your people work each day?',
    unlock: 2,
    initial: 'normal',
    options: [
      { id: 'relaxed', name: 'Relaxed', desc: 'Labourers −10%, morale +8.', fx: { labour: 0.9, morale: 8 } },
      { id: 'normal', name: 'Normal', desc: 'No change.', fx: {} },
      { id: 'long', name: 'Long Days', desc: 'Labourers +15%, morale −12, more illness.', fx: { labour: 1.15, morale: -12, disease: 1.4 } },
    ],
  },
  {
    id: 'borders',
    kind: 'policy',
    name: 'Strangers',
    prompt: 'How do you treat wanderers who arrive at your fires?',
    unlock: 3,
    initial: 'normal',
    options: [
      { id: 'open', name: 'Open Arms', desc: 'Twice as many newcomers, but fevers spread more.', fx: { immigration: 2, disease: 1.3 } },
      { id: 'normal', name: 'Cautious', desc: 'No change.', fx: {} },
      { id: 'closed', name: 'Closed Camp', desc: 'No newcomers. Morale +3, fewer fevers.', fx: { immigration: 0, morale: 3, disease: 0.8 } },
    ],
  },
  {
    id: 'families',
    kind: 'policy',
    name: 'Families',
    prompt: 'Should families be large or small?',
    unlock: 4,
    initial: 'normal',
    options: [
      { id: 'large', name: 'Large Families', desc: 'Births +50%, children eat a little more.', fx: { births: 1.5, foodUse: 1.04 } },
      { id: 'normal', name: 'Normal', desc: 'No change.', fx: {} },
      { id: 'small', name: 'Small Families', desc: 'Births −50%, labourers +6%.', fx: { births: 0.5, labour: 1.06 } },
    ],
  },
  {
    id: 'forestry',
    kind: 'policy',
    name: 'Forestry',
    prompt: 'How hard should the woodcutters work the forests?',
    unlock: 5,
    initial: 'normal',
    options: [
      { id: 'clearcut', name: 'Clear-cut', desc: 'Woodcutters +35%, but nobody replants: felled forest only creeps back on its own. Morale −4.', fx: { woodcutter: 1.35, replant: 0, morale: -4 } },
      { id: 'normal', name: 'Replanting', desc: 'Lumber camps replant what they fell.', fx: {} },
      { id: 'sacred', name: 'Sacred Woods', desc: 'Woodcutters −10%, forests and herds regrow 50% faster, hunters +10%, morale +4.', fx: { woodcutter: 0.9, regrow: 1.5, hunter: 1.1, morale: 4 } },
    ],
  },
  {
    id: 'festivals',
    kind: 'policy',
    name: 'Festivals',
    prompt: 'How often do your people celebrate?',
    unlock: 6,
    initial: 'normal',
    options: [
      { id: 'often', name: 'Frequent Feasts', desc: 'Morale +10, food eaten +8%.', fx: { morale: 10, foodUse: 1.08 } },
      { id: 'normal', name: 'Seasonal', desc: 'No change.', fx: {} },
      { id: 'austere', name: 'Austerity', desc: 'Morale −6, labourers +5%, scholars +10%.', fx: { morale: -6, labour: 1.05, scholar: 1.1 } },
    ],
  },
  {
    id: 'expansion',
    kind: 'policy',
    name: 'Expansion',
    prompt: 'Should your people found new settlements beyond the hearth?',
    unlock: 6,
    initial: 'steady',
    options: [
      { id: 'expand', name: 'Manifest Frontier', desc: 'Larger pioneer parties set out sooner and the realm aims for more settlements. Scouts +25%.', fx: { scout: 1.25 } },
      { id: 'steady', name: 'Steady Growth', desc: 'Pioneers set out when the realm can spare them.', fx: {} },
      { id: 'consolidate', name: 'Consolidate', desc: 'No new settlements. Builders +8%, morale +3.', fx: { builder: 1.08, morale: 3 } },
    ],
  },
  {
    id: 'levy',
    kind: 'policy',
    name: 'Militia',
    prompt: 'Should able adults train to defend the settlement?',
    unlock: 7,
    initial: 'none',
    options: [
      { id: 'drill', name: 'Drilled Militia', desc: 'Raids much easier to repel. Labourers −5%.', fx: { defense: 1.6, labour: 0.95 } },
      { id: 'none', name: 'No Militia', desc: 'No change.', fx: {} },
    ],
  },
  {
    id: 'markets',
    kind: 'policy',
    name: 'Markets',
    prompt: 'Do you welcome merchants into the town?',
    unlock: 8,
    initial: 'normal',
    options: [
      { id: 'fair', name: 'Market Fairs', desc: 'Traders twice as often, morale +3, stone −10%.', fx: { trade: 2, morale: 3, quarrier: 0.9 } },
      { id: 'normal', name: 'Normal', desc: 'No change.', fx: {} },
    ],
  },
  {
    id: 'laws',
    kind: 'policy',
    name: 'Laws',
    prompt: 'How does the township keep order?',
    unlock: 9,
    initial: 'normal',
    options: [
      { id: 'harsh', name: 'Iron Law', desc: 'Labourers +6%, raids easier to repel, morale −6.', fx: { labour: 1.06, defense: 1.3, morale: -6 } },
      { id: 'normal', name: 'Custom', desc: 'No change.', fx: {} },
      { id: 'fair', name: 'Fair Courts', desc: 'Morale +6, more newcomers.', fx: { morale: 6, immigration: 1.3 } },
    ],
  },
  {
    id: 'works',
    kind: 'policy',
    name: 'Public Works',
    prompt: 'How hard should the people push on great projects?',
    unlock: 10,
    initial: 'normal',
    options: [
      { id: 'grand', name: 'Grand Works', desc: 'Builders +30%, morale −5.', fx: { builder: 1.3, morale: -5 } },
      { id: 'normal', name: 'Steady', desc: 'No change.', fx: {} },
      { id: 'leisure', name: 'Leisure', desc: 'Morale +7, builders −15%.', fx: { morale: 7, builder: 0.85 } },
    ],
  },
];

export const DECISION_BY_ID: Record<string, DecisionDef> = Object.fromEntries(DECISIONS.map((d) => [d.id, d]));
export const PATH_ORDER = ['way', 'path1', 'path2', 'path3', 'path4'];

// ---------------------------------------------------------------- tweaks

export interface TweakDef {
  id: 'reserve' | 'housing' | 'scouts' | 'builders';
  name: string;
  desc: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  unit: string;
  unlock: number;
}

export const TWEAKS: TweakDef[] = [
  { id: 'reserve', name: 'Winter reserve', desc: 'Days of food the council stockpiles before winter.', min: 0, max: 30, step: 2, initial: 10, unit: ' days', unlock: 0 },
  { id: 'housing', name: 'Spare homes', desc: 'Empty beds the council keeps ready so families can grow.', min: 0, max: 16, step: 1, initial: 4, unit: ' beds', unlock: 2 },
  { id: 'scouts', name: 'Scouts', desc: 'How many people the council sends exploring.', min: 0, max: 8, step: 1, initial: 1, unit: '', unlock: 3 },
  { id: 'builders', name: 'Builders', desc: 'Share of workers on construction while there is something to build.', min: 5, max: 40, step: 5, initial: 12, unit: '%', unlock: 4 },
];

/** Milestone that unlocks pinning the council's next discovery. */
export const PIN_UNLOCK = 1;

// ---------------------------------------------------------------- milestones

export interface MilestoneDef {
  text: string;
  hint: string;
}

export const MILESTONES: MilestoneDef[] = [
  { text: 'Survive your first winter', hint: 'Winter brings little food and bitter cold. The council stockpiles what it can.' },
  { text: 'Make your first discovery', hint: 'Scholars gather knowledge; the council spends it.' },
  { text: 'Grow to 12 people', hint: 'Families need food, free homes and good morale.' },
  { text: 'Uncover a secret of the wilds', hint: 'Scouts explore. Click a dark area of the map to send them there.' },
  { text: 'Enter the Age of Fields', hint: 'When your people are ready, choose a path in the Decide tab.' },
  { text: 'Raise 15 buildings', hint: 'The council builds as resources allow. You can commission buildings too.' },
  { text: 'Grow to 30 people', hint: 'A Growth focus, spare homes and large families all help.' },
  { text: 'Enter the Age of Bronze', hint: 'Choose your next path in the Decide tab.' },
  { text: 'Forge 20 tools', hint: 'Mines and smithies turn ore into tools. An Industry focus helps.' },
  { text: 'Enter the Age of Iron', hint: 'Choose your next path in the Decide tab.' },
  { text: 'Grow to 60 people', hint: 'A great work needs many hands.' },
  { text: 'Enter the Age of Wonders', hint: 'Choose your final path in the Decide tab.' },
  { text: 'Discover Architecture', hint: 'The final discovery — the council will lay the Sunspire’s foundations.' },
  { text: 'Complete the Sunspire', hint: 'It devours stone, wood, ore, tools and knowledge as it rises.' },
  { text: 'Found a second settlement', hint: 'Pioneers blaze a trail to the best land your scouts have found. See the Realm tab.' },
  { text: 'Open a trade route', hint: 'Join two villages by cart along a trail, or by galley between two harbours.' },
  { text: 'Raise a city', hint: 'A settlement becomes a city with enough people and buildings in the Age of Bronze.' },
  { text: 'Found a colony across the sea', hint: 'Build a harbour: galleys chart the coasts and carry pioneers to other lands.' },
  { text: 'Raise a metropolis', hint: 'The greatest cities grow where the land is richest and trade flows.' },
];

/** What each milestone unlocks, for display. */
export function milestoneUnlocks(i: number): string[] {
  const out: string[] = [];
  for (const d of DECISIONS) if (d.unlock === i) out.push(`${d.name} policy`);
  for (const t of TWEAKS) if (t.unlock === i) out.push(`${t.name} setting`);
  if (i === PIN_UNLOCK) out.push('Choosing the next discovery');
  return out;
}

// ---------------------------------------------------------------- helpers

export function milestoneDone(state: GameState, i: number) {
  return i < 0 || state.objective > i;
}

export function decisionUnlocked(state: GameState, d: DecisionDef) {
  return milestoneDone(state, d.unlock);
}

export function choiceOf(state: GameState, id: string): string | undefined {
  return state.decisions[id] ?? DECISION_BY_ID[id]?.initial;
}

function activeOptions(state: GameState): DecisionOption[] {
  const out: DecisionOption[] = [];
  for (const d of DECISIONS) {
    if (d.kind === 'focus') continue;
    const c = state.decisions[d.id];
    if (!c) continue;
    const o = d.options.find((x) => x.id === c);
    if (o) out.push(o);
  }
  return out;
}

/** Multiplicative effect of all active decisions for a key (1 if none). Job keys include the 'labour' effect. */
export function fxMul(state: GameState, key: string): number {
  let m = 1;
  for (const o of activeOptions(state)) {
    if (o.fx[key] !== undefined) m *= o.fx[key];
    if (LABOUR.has(key) && o.fx.labour !== undefined) m *= o.fx.labour;
  }
  return m;
}

export function fxAdd(state: GameState, key: string): number {
  let a = 0;
  for (const o of activeOptions(state)) a += o.fx[key] ?? 0;
  return a;
}

export function tweak(state: GameState, id: TweakDef['id']): number {
  const def = TWEAKS.find((t) => t.id === id)!;
  if (!milestoneDone(state, def.unlock)) return def.initial;
  return state.tweaks[id] ?? def.initial;
}

export function setTweak(state: GameState, id: TweakDef['id'], v: number) {
  const def = TWEAKS.find((t) => t.id === id)!;
  if (!milestoneDone(state, def.unlock)) return;
  state.tweaks[id] = Math.max(def.min, Math.min(def.max, Math.round(v / def.step) * def.step));
}

export type DecideResult = { ok: true } | { ok: false; reason: string };

export function policyCooldown(state: GameState, id: string): number {
  const last = state.decidedDay[id];
  if (last === undefined) return 0;
  return Math.max(0, last + POLICY_COOLDOWN - state.day);
}

/** The era path that is currently on offer (the next one not yet taken), if any. */
export function nextPath(state: GameState): DecisionDef | null {
  for (const id of PATH_ORDER) if (!state.decisions[id]) return DECISION_BY_ID[id];
  return null;
}

export function pathRequirements(state: GameState, d: DecisionDef): { ready: boolean; needs: string[] } {
  if (!d.tech) return { ready: true, needs: [] };
  const t = TECH_DEFS[d.tech];
  const needs: string[] = [];
  if (t.minPop && state.settlers.length < t.minPop) needs.push(`${t.minPop} people (now ${state.settlers.length})`);
  for (const r of t.requires ?? []) if (!state.techs.includes(r)) needs.push(`Discover ${TECH_DEFS[r].name}`);
  // previous path must be chosen
  const idx = PATH_ORDER.indexOf(d.id);
  if (idx > 0 && !state.decisions[PATH_ORDER[idx - 1]]) needs.push(`Choose ${DECISION_BY_ID[PATH_ORDER[idx - 1]].name}`);
  return { ready: needs.length === 0, needs };
}

/** Apply a decision. Paths are permanent; era paths also pay for and grant their era tech. */
export function decide(state: GameState, id: string, option: string, fx?: FxEvent[], researchFn?: (s: GameState, t: TechId, fx?: FxEvent[]) => DecideResult): DecideResult {
  const d = DECISION_BY_ID[id];
  if (!d) return { ok: false, reason: 'Unknown decision' };
  const opt = d.options.find((o) => o.id === option);
  if (!opt) return { ok: false, reason: 'Unknown option' };
  if (!decisionUnlocked(state, d)) return { ok: false, reason: 'Not yet unlocked' };
  if (d.kind === 'path') {
    if (state.decisions[id]) return { ok: false, reason: 'Already chosen' };
    const req = pathRequirements(state, d);
    if (!req.ready) return { ok: false, reason: `Requires ${req.needs.join(', ')}` };
    if (d.tech) {
      const r = researchFn!(state, d.tech, fx);
      if (!r.ok) return r;
    }
    state.decisions[id] = option;
    state.log.push({ day: state.day, kind: 'era', text: d.tech ? `${state.name} chose the path of ${opt.name}.` : `The people of ${state.name} will follow the ${opt.name}.` });
  } else {
    if (d.kind === 'policy') {
      const cd = policyCooldown(state, id);
      if (cd > 0 && choiceOf(state, id) !== option) return { ok: false, reason: `Can change again in ${cd} days` };
      if (choiceOf(state, id) === option) return { ok: true };
      state.decidedDay[id] = state.day;
      state.log.push({ day: state.day, kind: 'info', text: `New policy — ${d.name}: ${opt.name}.` });
    }
    state.decisions[id] = option;
  }
  invalidate(state);
  return { ok: true };
}

export function eraPathName(era: number) {
  return ERAS[era]?.name ?? '';
}
