import { it } from 'vitest';
import { DAYS_PER_YEAR } from '../src/game/data';
import { newGame, eraOf, seasonIndex } from '../src/game/state';
import { emptyRates, popSummary, tick, type TickContext } from '../src/game/sim';
import { derived } from '../src/game/derived';
import { botStep } from './autoplayer';

const SEED = Number(process.env.TRACE_SEED ?? 0);
it.skipIf(!SEED)('trace', () => {
  const state = newGame(SEED, 0, 0);
  const years = Number(process.env.TRACE_YEARS ?? 30);
  const every = Number(process.env.TRACE_EVERY ?? 10);
  for (let day = 0; day < years * DAYS_PER_YEAR; day++) {
    const ctx: TickContext = { fx: [], rates: emptyRates() };
    if (day % 2 === 0) botStep(state, ctx);
    tick(state, ctx);
    if (state.day % every === 0) {
      const p = popSummary(state);
      const d = derived(state);
      const r = Object.fromEntries(Object.entries(state.res).map(([k, v]) => [k, Math.round(v)]));
      const jobs = Object.entries(p.jobs).filter(([, v]) => v).map(([k, v]) => `${k.slice(0, 4)}${v}`).join(' ');
      console.log(`y${Math.floor(state.day / DAYS_PER_YEAR) + 1}s${seasonIndex(state.day)} era${eraOf(state)} pop${p.total}(c${p.children} a${p.adults} e${p.elders} i${p.idle}) house${d.housing} mor${Math.round(state.morale)} hun${state.hunger.toFixed(2)} cold${state.cold.toFixed(2)} ${JSON.stringify(r)} ${jobs} bld${state.buildings.length} techs${state.techs.length} obj${state.objective}`);
    }
    if (state.defeat || state.victory) break;
  }
  console.log(state.log.slice(-25).map((l) => l.day + ' ' + l.text).join('\n'));
});
