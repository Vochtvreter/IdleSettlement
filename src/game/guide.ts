import { focusRevealed, manualRevealed, pendingDecision, tabRevealed, type Tab } from './reveal';
import { seasonIndex } from './state';
import type { GameState } from './types';

/**
 * The elder's advice: short tips that introduce one system at a time, at the moment it
 * starts to matter. Each tip shows once per settlement. Steps are listed in priority
 * order: when several are due, the first one wins, so urgent ones come first.
 */
export interface GuideStep {
  id: string;
  title: string;
  /** May contain simple markup; `{name}` becomes the settlement's name. */
  text: string;
  /** The tip becomes due when this is true. */
  when: (s: GameState) => boolean;
  /** Only after this step has been seen. */
  after?: string;
  /** Once true, the tip is no longer needed: it closes itself, or is skipped if not yet shown. */
  until?: (s: GameState) => boolean;
  /** CSS selector of the element to highlight. */
  target?: string;
  /** Tab the tip is about (and that holds the target): its button is highlighted while another tab is open. */
  tab?: Tab;
}

export const GUIDE: GuideStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to {name}',
    text: 'Eight wanderers have lit a fire here. Your <b>council</b> runs the camp day to day: it finds food, chops wood and raises huts, even while you are away.<br><br>Your part is the big decisions. I will explain each new thing as it comes up.',
    when: () => true,
  },
  // ------------------------------------------------ urgent, whenever they happen
  {
    id: 'hunger',
    title: 'Your people are hungry',
    text: 'Food is running out. Set the <b>Council Focus</b> to <b>Growth</b> and the council will put more hands on gathering, hunting and farming.',
    after: 'welcome',
    when: (s) => s.hunger > 0.05 && focusRevealed(s),
    until: (s) => s.decisions.focus === 'growth',
    target: '[data-guide="focus"]',
    tab: 'decide',
  },
  {
    id: 'cold',
    title: 'Your people are freezing',
    text: 'The firewood has run out. An <b>Industry</b> focus puts more people on woodcutting. Next autumn, make sure there is wood to spare.',
    after: 'welcome',
    when: (s) => s.cold > 0.05 && focusRevealed(s),
    until: (s) => s.decisions.focus === 'industry',
    target: '[data-guide="focus"]',
    tab: 'decide',
  },
  {
    id: 'event',
    title: 'Something is happening',
    text: 'Events like this one offer a choice. Take your time: if you have not answered when the time runs out, your people pick the last, most cautious option.',
    after: 'welcome',
    when: (s) => !!s.choice,
    target: '#choice',
  },
  {
    id: 'crossroads',
    title: 'A new age awaits',
    text: 'Your people are ready to enter the <b>Age of Fields</b>. Pick one of the three paths on the Crossroads card. The choice is permanent and shapes the rest of your saga.',
    after: 'welcome',
    when: (s) => pendingDecision(s)?.id === 'path1',
    until: (s) => !!s.decisions.path1,
    target: '.path-card',
    tab: 'decide',
  },
  // ------------------------------------------------ the first days
  {
    id: 'way',
    title: 'Your first decision',
    text: 'What kind of people will you be? Choose a <b>Founding Way</b> on the Crossroads card. Each Way strengthens different work, and the choice is permanent. There is no rush.',
    after: 'welcome',
    when: () => true,
    until: (s) => !!s.decisions.way,
    target: '.path-card',
    tab: 'decide',
  },
  {
    id: 'winter',
    title: 'Winter is coming',
    text: 'In winter almost nothing grows and everyone burns firewood to stay warm. The council stockpiles food and wood in autumn. Keep an eye on the season up here.',
    after: 'welcome',
    when: (s) => seasonIndex(s.day) === 2,
    until: (s) => s.day >= 40,
    target: '#date',
  },
  {
    id: 'resources',
    title: 'Your stores',
    text: '<b>Food</b> feeds everyone, <b>wood</b> builds and warms, and <b>knowledge</b> from your scholars pays for discoveries. The small number shows the change per day. Hover over or tap a resource to see where it comes from.',
    after: 'way',
    when: (s) => s.day >= 3,
    target: '#resources',
  },
  {
    id: 'goal',
    title: 'Milestones',
    text: 'This panel shows your current goal and how close you are. Each <b>milestone</b> you reach unlocks something new to decide.',
    after: 'resources',
    when: () => true,
    target: '#objective',
  },
  {
    id: 'focus',
    title: 'Council Focus',
    text: 'The <b>Council Focus</b> tells the council what to put first: food and families, materials, knowledge or exploring. Change it as often as you like.',
    after: 'goal',
    when: focusRevealed,
    target: '[data-guide="focus"]',
    tab: 'decide',
  },
  {
    id: 'people',
    title: 'Your people',
    text: 'The <b>People</b> tab shows how many you are, how happy they are and who does which job. The council hands out the work for you.',
    after: 'goal',
    when: (s) => tabRevealed(s, 'people'),
    tab: 'people',
  },
  {
    id: 'speed',
    title: 'Time',
    text: 'A day passes every second. Use these buttons, or the keys <b>1</b>, <b>2</b> and <b>3</b>, to speed time up. <b>Space</b> pauses.',
    after: 'focus',
    when: () => true,
    target: '#speed',
  },
  {
    id: 'build',
    title: 'Building',
    text: 'The council has raised its first building. The <b>Build</b> tab shows what is under construction. If you want a building in a particular spot, you can commission it there yourself.',
    after: 'goal',
    when: (s) => tabRevealed(s, 'build'),
    tab: 'build',
  },
  {
    id: 'land',
    title: 'The land is not endless',
    text: 'What your people take, the land gives back slowly or not at all. Felled woods regrow in a few years, fastest where a <b>lumber camp</b> replants them. Herds hunted too hard dwindle, and <b>pastures</b> breed animals instead. Quarries and mines run out for good, so the council opens new ones further out and builds <b>bridges</b> to reach land across rivers.<br><br>Click any tile to see what it still holds.',
    after: 'build',
    when: (s) => s.buildings.some((b) => b.spent) || (s.eff.woodcutter ?? 1) < 0.7 || (s.eff.hunter ?? 1) < 0.7,
  },
  // ------------------------------------------------ after the first milestones
  {
    id: 'policies',
    title: 'Your first policy',
    text: 'You made it through the first winter and unlocked <b>Rations</b>. Policies are trade-offs: more of one thing costs another. Each can be changed once per season.<br><br>Every milestone from now on unlocks a new policy or council setting.',
    after: 'welcome',
    when: (s) => s.objective > 0,
    target: '[data-guide="policies"]',
    tab: 'decide',
  },
  {
    id: 'log',
    title: 'The Chronicle',
    text: 'Births, deaths, discoveries and visitors are all written down in the <b>Chronicle</b>.',
    after: 'policies',
    when: (s) => tabRevealed(s, 'log'),
    tab: 'log',
  },
  {
    id: 'research',
    title: 'Discoveries',
    text: 'Your scholars made their first discovery! The <b>Research</b> tab lists what can be learned next. The council picks on its own, but you can now mark the discovery you want first.',
    after: 'welcome',
    when: (s) => tabRevealed(s, 'research') && s.objective > 0,
    tab: 'research',
  },
  {
    id: 'ages',
    title: 'The road ahead',
    text: 'The Crossroads card now shows the way into the <b>Age of Fields</b>. The council works toward it on its own. Once every requirement is ticked, you choose how your people enter the new age.',
    after: 'policies',
    when: (s) => !!s.decisions.way,
    until: (s) => pendingDecision(s)?.id === 'path1' || !!s.decisions.path1,
    target: '.path-card',
    tab: 'decide',
  },
  {
    id: 'explore',
    title: 'Beyond the firelight',
    text: 'Dark land on the map is unexplored. <b>Click or tap any dark area</b> to send your scouts there. Ruins, supply caches and wanderer camps are waiting.',
    after: 'welcome',
    when: (s) => s.objective === 3,
    until: (s) => s.claimed.length > 0,
  },
  {
    id: 'manual',
    title: 'Taking the reins',
    text: 'In a new age you can take direct control if you like. Under <b>Who decides the details?</b> you can take over work, construction or research from the council. Leaving it all to the council works just as well.',
    after: 'welcome',
    when: (s) => manualRevealed(s) && !!s.decisions.path1,
    target: '[data-guide="manual"]',
    tab: 'decide',
  },
  {
    id: 'onward',
    title: 'Onward',
    text: 'That is all you need to know. Keep reaching milestones, choose a path at each Crossroads, and in the Age of Wonders raise the <b>Sunspire</b>. The full guide is in the menu.',
    after: 'manual',
    when: () => true,
  },
];

export const GUIDE_BY_ID: Record<string, GuideStep> = Object.fromEntries(GUIDE.map((g) => [g.id, g]));

/** Mark steps that are no longer needed as seen. Returns true if anything changed. */
export function pruneGuide(s: GameState): boolean {
  if (!s.guide) return false;
  let changed = false;
  for (const g of GUIDE) {
    if (g.until && !s.guide.includes(g.id) && g.until(s)) {
      s.guide.push(g.id);
      changed = true;
    }
  }
  return changed;
}

/** The tip that should be on screen now, if any. */
export function nextGuide(s: GameState): GuideStep | null {
  const seen = s.guide;
  if (!seen || s.victory || s.defeat) return null;
  for (const g of GUIDE) {
    if (seen.includes(g.id)) continue;
    if (g.after && !seen.includes(g.after)) continue;
    if (g.until?.(s)) continue;
    if (g.when(s)) return g;
  }
  return null;
}
