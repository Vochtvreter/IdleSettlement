import { BUILDING_DEFS } from './data';
import { canAfford, derived, pay, refund } from './derived';
import { Rng } from './rng';
import { ageOf, eraOf, hasTech, seasonIndex } from './state';
import { addSettlers, killSettler, log, type TickContext } from './sim';
import type { ChoiceOption, Cost, GameState, Modifier } from './types';

const EVENT_CHANCE = 1 / 26;

interface EventDef {
  id: string;
  weight: (s: GameState) => number;
  /** Disasters & choices are skipped while catching up offline. */
  benign?: boolean;
  run: (s: GameState, ctx: TickContext, rng: Rng) => void;
}

function addMod(state: GameState, m: Omit<Modifier, 'until'>, days: number) {
  state.modifiers = state.modifiers.filter((x) => x.id !== m.id);
  state.modifiers.push({ ...m, until: state.day + days });
}

function hasMod(state: GameState, id: string) {
  return state.modifiers.some((m) => m.id === id);
}

const towers = (s: GameState) => derived(s).counts.watchtower ?? 0;
const freeHousing = (s: GameState) => derived(s).housing - s.settlers.length;

const EVENTS: EventDef[] = [
  {
    id: 'wanderers',
    benign: true,
    weight: (s) => (s.morale > 45 && freeHousing(s) >= 2 ? 3 : 0),
    run: (s, ctx, rng) => {
      const n = Math.min(freeHousing(s), rng.int(1, 3));
      addSettlers(s, ctx, rng, n);
      log(s, n === 1 ? 'A lone wanderer, drawn by the smoke of your fires, asks to join you.' : `${n} wanderers, drawn by tales of ${s.name}, settle among you.`, 'good');
    },
  },
  {
    id: 'bountiful',
    benign: true,
    weight: (s) => (seasonIndex(s.day) < 2 && !hasMod(s, 'bountiful') ? 1.5 : 0),
    run: (s) => {
      addMod(s, { id: 'bountiful', label: 'Bountiful Season', effects: { gatherer: 1.5, farmer: 1.3 } }, 12);
      log(s, 'A bountiful season! Berries hang heavy and the fields are lush. (Gatherers +50%, Farmers +30%)', 'good');
    },
  },
  {
    id: 'herd',
    benign: true,
    weight: (s) => (eraOf(s) <= 1 && !hasMod(s, 'herd') ? 1.2 : 0),
    run: (s) => {
      addMod(s, { id: 'herd', label: 'Great Migration', effects: { hunter: 1.8 } }, 12);
      log(s, 'A great herd thunders across the plains. (Hunters +80% for a while)', 'good');
    },
  },
  {
    id: 'festival',
    benign: true,
    weight: (s) => (s.settlers.length >= 10 && !hasMod(s, 'festival') ? 1 : 0),
    run: (s) => {
      addMod(s, { id: 'festival', label: 'Midsummer Festival', effects: { morale: 12, births: 1.4 } }, 20);
      log(s, 'Your people hold a festival of song and dance around the great hearth. (Morale +12, more births)', 'good');
    },
  },
  {
    id: 'elder_wisdom',
    benign: true,
    weight: (s) => (s.settlers.some((x) => ageOf(s, x) >= 52) ? 1 : 0),
    run: (s, _ctx, rng) => {
      const k = Math.round(6 + eraOf(s) * 18 + rng.int(0, 6));
      s.res.knowledge += k;
      log(s, `The elders recount the old stories by firelight, and the young listen closely. (+${k} knowledge)`, 'good');
    },
  },
  {
    id: 'comet',
    benign: true,
    weight: (s) => (eraOf(s) >= 1 ? 0.4 : 0),
    run: (s) => {
      s.res.knowledge += 10 + eraOf(s) * 20;
      addMod(s, { id: 'comet', label: 'Omen in the Sky', effects: { morale: 8 } }, 15);
      log(s, 'A great comet crosses the night sky. Your scholars record it in awe. (+knowledge, +morale)', 'good');
    },
  },
  {
    id: 'wolves',
    weight: (s) => (eraOf(s) <= 2 ? Math.max(0.2, 1.4 - towers(s) * 0.5) : 0),
    run: (s, ctx, rng) => {
      const lostFood = Math.round(s.res.food * rng.range(0.1, 0.2));
      s.res.food -= lostFood;
      const hunters = s.settlers.filter((x) => x.job === 'hunter' || x.job === 'gatherer');
      if (towers(s) === 0 && hunters.length && s.settlers.length >= 12 && rng.chance(0.25)) {
        const v = rng.pick(hunters);
        killSettler(s, ctx, v, 'a wolf attack');
      }
      log(s, `Wolves prowl the edge of camp at night, stealing ${lostFood} food.${towers(s) ? ' Your watchtowers kept the worst at bay.' : ''}`, 'bad');
    },
  },
  {
    id: 'harsh_winter',
    weight: (s) => (seasonIndex(s.day) === 2 && !hasMod(s, 'harsh_winter') ? 1.6 : 0),
    run: (s) => {
      addMod(s, { id: 'harsh_winter', label: 'Harsh Winter Ahead', effects: { heating: 1.6, gatherer: 0.7, hunter: 0.8 } }, 22);
      log(s, 'The geese flew south early. Elders warn of a harsh winter — stock up on food and firewood!', 'bad');
    },
  },
  {
    id: 'sickness',
    weight: (s) => (s.settlers.length >= 16 && !hasMod(s, 'sickness') ? 1 : 0),
    run: (s, ctx, rng) => {
      const healers = s.settlers.filter((x) => x.job === 'healer').length;
      const care = Math.min(1, (healers * 12) / s.settlers.length);
      const deaths = Math.max(0, Math.round(rng.range(1, 3.5) * (1 - care * 0.8) * (hasTech(s, 'medicine') ? 0.5 : 1)));
      addMod(s, { id: 'sickness', label: 'Fever', effects: { morale: -10 } }, 12);
      const vulnerable = [...s.settlers].sort((a, b) => Math.abs(ageOf(s, b) - 30) - Math.abs(ageOf(s, a) - 30));
      for (let k = 0; k < deaths && vulnerable.length; k++) killSettler(s, ctx, vulnerable.shift()!, 'fever');
      log(s, deaths ? `A fever spreads through ${s.name}.${care > 0.3 ? ' Your healers saved many.' : ' Healers would have helped.'}` : 'A fever went around, but your healers nursed everyone back to health.', deaths ? 'bad' : 'good');
    },
  },
  {
    id: 'storm',
    weight: (s) => (s.res.wood > 30 ? 0.8 : 0),
    run: (s, _ctx, rng) => {
      const lost = Math.round(s.res.wood * rng.range(0.12, 0.25));
      s.res.wood -= lost;
      log(s, `A violent storm scatters your woodpiles. (-${lost} wood)`, 'bad');
    },
  },
  {
    id: 'fire',
    weight: (s) => (s.buildings.filter((b) => !b.done).length > 0 ? 0.4 : 0),
    run: (s) => {
      const site = s.buildings.find((b) => !b.done);
      if (!site) return;
      site.progress = Math.max(0, site.progress * 0.5);
      log(s, `Sparks from a cookfire set the ${BUILDING_DEFS[site.type].name} construction site alight. Half the work is lost.`, 'bad');
    },
  },
  // ---- choices
  {
    id: 'trader',
    weight: (s) => (eraOf(s) >= 1 && !s.choice ? 1.6 : 0),
    run: (s, _ctx, rng) => {
      const era = eraOf(s);
      const offers: ChoiceOption[] =
        era <= 1
          ? [
              { label: 'Trade food for hides', key: 'trade', cost: { food: 40 }, gain: { hides: 18 } },
              { label: 'Trade wood for stone', key: 'trade', cost: { wood: 40 }, gain: { stone: 30 } },
            ]
          : [
              { label: 'Trade hides for ore', key: 'trade', cost: { hides: 30 }, gain: { ore: 25 } },
              { label: 'Trade food for tools', key: 'trade', cost: { food: 90 }, gain: { tools: 14 } },
              { label: 'Trade stone for knowledge', key: 'trade', cost: { stone: 80 }, gain: { knowledge: 40 + era * 15 } },
            ];
      const picks = era <= 1 ? offers : [offers.splice(rng.int(0, offers.length - 1), 1)[0], offers[rng.int(0, offers.length - 1)]];
      s.choice = {
        id: 'trader',
        title: 'Traders Arrive',
        text: 'A caravan of travelling traders makes camp by the river. They are willing to barter.',
        options: [...picks, { label: 'Send them on their way', key: 'none' }],
        expires: s.day + 15,
      };
    },
  },
  {
    id: 'refugees',
    weight: (s) => (!s.choice && s.settlers.length >= 8 ? 0.9 : 0),
    run: (s, _ctx, rng) => {
      const n = rng.int(3, 5);
      s.choice = {
        id: 'refugees',
        title: 'Refugees at the Gate',
        text: `${n} ragged travellers fleeing a flood beg for shelter. They are hungry, and one of them coughs badly.`,
        options: [
          { label: `Welcome them (+${n} people)`, key: `refugees:${n}`, cost: { food: 25 } },
          { label: 'Turn them away', key: 'turn_away' },
        ],
        expires: s.day + 12,
      };
    },
  },
  {
    id: 'sage',
    weight: (s) => (!s.choice && eraOf(s) >= 1 ? 0.8 : 0),
    run: (s) => {
      const era = eraOf(s);
      s.choice = {
        id: 'sage',
        title: 'A Wandering Sage',
        text: 'An old sage with ink-stained fingers offers to teach your scholars, in exchange for room and board.',
        options: [
          { label: 'Host the sage', key: 'trade', cost: { food: 30 + era * 20 }, gain: { knowledge: 35 + era * 40 } },
          { label: 'Politely decline', key: 'none' },
        ],
        expires: s.day + 15,
      };
    },
  },
  {
    id: 'raiders',
    weight: (s) => (!s.choice && eraOf(s) >= 2 ? Math.max(0.3, 1.2 - towers(s) * 0.3) : 0),
    run: (s) => {
      const tribute = Math.round(s.res.food * 0.25);
      s.choice = {
        id: 'raiders',
        title: 'Raiders!',
        text: `Armed raiders from the hills surround ${s.name} and demand tribute. Your ${towers(s)} watchtower${towers(s) === 1 ? '' : 's'} give your defenders an edge.`,
        options: [
          { label: 'Stand and fight', key: 'fight' },
          { label: `Pay tribute (${tribute} food)`, key: 'tribute', cost: { food: tribute } },
        ],
        expires: s.day + 10,
      };
    },
  },
];

export function rollEvent(state: GameState, ctx: TickContext, rng: Rng) {
  if (state.day < 40) return; // grace period for new settlements
  if (!rng.chance(EVENT_CHANCE)) return;
  const pool = EVENTS.filter((e) => !ctx.offline || e.benign).map((e) => ({ w: e.weight(state), v: e }));
  const ev = rng.weighted(pool);
  if (ev) ev.run(state, ctx, rng);
}

export function choiceAffordable(state: GameState, opt: ChoiceOption) {
  return !opt.cost || canAfford(state, opt.cost);
}

/** Apply a choice option. Falls back to the last (safe) option if the chosen one is unaffordable. */
export function resolveChoice(state: GameState, ctx: TickContext, index: number) {
  const choice = state.choice;
  if (!choice) return;
  let opt = choice.options[index];
  if (!opt || !choiceAffordable(state, opt)) opt = choice.options[choice.options.length - 1];
  if (!choiceAffordable(state, opt)) opt = { label: '', key: choice.id === 'raiders' ? 'fight' : 'none' };
  state.choice = null;
  const rng = new Rng(state.rng ^ 0xabcdef);
  if (opt.cost) pay(state, opt.cost);
  if (opt.gain) refund(state, opt.gain as Cost);
  const [key, arg] = opt.key.split(':');
  switch (key) {
    case 'trade':
      log(state, `You struck a deal with the visitors.`, 'good');
      break;
    case 'refugees': {
      const n = Number(arg);
      addSettlers(state, ctx, rng, n, 6, 40);
      if (rng.chance(0.35)) {
        addMod(state, { id: 'sickness', label: 'Fever', effects: { morale: -8 } }, 10);
        log(state, `The ${n} refugees join ${state.name}, but bring a mild fever with them.`, 'info');
      } else {
        addMod(state, { id: 'kindness', label: 'Kindness Remembered', effects: { morale: 6 } }, 20);
        log(state, `The ${n} refugees join ${state.name}, grateful for your kindness.`, 'good');
      }
      break;
    }
    case 'turn_away':
      addMod(state, { id: 'guilt', label: 'Uneasy Conscience', effects: { morale: -5 } }, 15);
      log(state, 'The refugees trudge away into the rain.', 'info');
      break;
    case 'tribute':
      log(state, 'You paid the raiders, and they left without bloodshed.', 'info');
      break;
    case 'fight': {
      const defenders = state.settlers.filter((x) => ageOf(state, x) >= 16 && ageOf(state, x) < 50);
      const strength = 0.45 + towers(state) * 0.12 + (hasTech(state, 'iron') ? 0.15 : 0) + (state.res.tools > 20 ? 0.1 : 0);
      if (rng.chance(Math.min(0.92, strength))) {
        const loot = 10 + eraOf(state) * 5;
        refund(state, { hides: loot, ore: loot });
        addMod(state, { id: 'victory', label: 'Triumph', effects: { morale: 10 } }, 20);
        log(state, 'Your defenders drove the raiders off! Their abandoned gear is yours. (+morale)', 'good');
      } else {
        const deaths = Math.min(defenders.length, rng.int(1, 3));
        for (let k = 0; k < deaths; k++) killSettler(state, ctx, defenders.splice(rng.int(0, defenders.length - 1), 1)[0], 'wounds from the raid');
        const lost = Math.round(state.res.food * 0.35);
        state.res.food -= lost;
        addMod(state, { id: 'raided', label: 'Raided', effects: { morale: -12 } }, 20);
        log(state, `The raiders broke through, plundering ${lost} food. More watchtowers would help.`, 'bad');
      }
      break;
    }
    default:
      if (choice.id === 'trader' || choice.id === 'sage') log(state, 'The visitors move on.', 'info');
  }
}
