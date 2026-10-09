import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR, ERAS } from '../src/game/data';
import { newGame, eraOf } from '../src/game/state';
import { emptyRates, tick, type TickContext } from '../src/game/sim';
import { botStep } from './autoplayer';

function playthrough(seed: number, maxYears = 160) {
  const state = newGame(seed, 0, 0);
  const eraYears: number[] = [0];
  const ctx: TickContext = { fx: [], rates: emptyRates() };
  let minPop = Infinity;
  for (let day = 0; day < maxYears * DAYS_PER_YEAR; day++) {
    if (day % 2 === 0) botStep(state, ctx);
    ctx.fx.length = 0;
    tick(state, ctx);
    const era = eraOf(state);
    if (eraYears.length <= era) eraYears.push(Math.floor(state.day / DAYS_PER_YEAR));
    if (state.day > DAYS_PER_YEAR * 5) minPop = Math.min(minPop, state.settlers.length);
    if (state.victory || state.defeat) break;
  }
  return { state, eraYears, minPop };
}

describe('balance: a heuristic bot can finish the game', () => {
  const seeds = process.env.BAL_SEEDS ? process.env.BAL_SEEDS.split(',').map(Number) : [1, 2, 3, 42, 1337];
  for (const seed of seeds) {
    it(`seed ${seed}`, { timeout: 120_000 }, () => {
      const { state, eraYears, minPop } = playthrough(seed);
      const years = Math.floor(state.day / DAYS_PER_YEAR);
      console.log(
        `seed ${seed}: ${state.victory ? 'VICTORY' : state.defeat ? 'DEFEAT' : 'unfinished'} in year ${years}; ` +
          `eras at ${eraYears.map((y, i) => `${ERAS[i].short}:${y}`).join(' ')}; pop ${state.settlers.length} (peak ${state.stats.peakPop}, min ${minPop}); ` +
          `births ${state.stats.births} deaths ${state.stats.deaths} gen ${state.stats.maxGen} objective ${state.objective}`,
      );
      expect(state.defeat).toBe(false);
      expect(state.victory).toBe(true);
      expect(years).toBeLessThan(110);
      expect(years).toBeGreaterThan(30);
    });
  }
});
