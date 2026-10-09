import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR, ERAS } from '../src/game/data';
import { newGame, eraOf } from '../src/game/state';
import { emptyRates, tick, type TickContext } from '../src/game/sim';
import type { GameState } from '../src/game/types';
import { decider, type Persona } from './autoplayer';

export function playthrough(seed: number, persona: Persona | null, maxYears = 160) {
  const state = newGame(seed, 0, 0);
  const decide = persona ? decider(persona) : null;
  const eraYears: number[] = [0];
  const ctx: TickContext = { fx: [], rates: emptyRates() };
  let minPop = Infinity;
  for (let day = 0; day < maxYears * DAYS_PER_YEAR; day++) {
    if (decide && day % 2 === 0) decide(state, ctx);
    ctx.fx.length = 0;
    tick(state, ctx);
    const era = eraOf(state);
    while (eraYears.length <= era) eraYears.push(Math.floor(state.day / DAYS_PER_YEAR));
    if (state.day > DAYS_PER_YEAR * 5) minPop = Math.min(minPop, state.settlers.length);
    if (state.victory || state.defeat) break;
  }
  return { state, eraYears, minPop };
}

function summary(seed: number, label: string, r: { state: GameState; eraYears: number[]; minPop: number }) {
  const s = r.state;
  return (
    `${label} seed ${seed}: ${s.victory ? 'VICTORY' : s.defeat ? 'DEFEAT' : 'unfinished'} in year ${Math.floor(s.day / DAYS_PER_YEAR)}; ` +
    `eras ${r.eraYears.map((y, i) => `${ERAS[i].short}:${y}`).join(' ')}; pop ${s.settlers.length} (peak ${s.stats.peakPop}, min ${r.minPop}); ` +
    `births ${s.stats.births} deaths ${s.stats.deaths} milestone ${s.objective} paths ${Object.entries(s.decisions).map(([k, v]) => `${k}=${v}`).join(',')}`
  );
}

const seeds = process.env.BAL_SEEDS ? process.env.BAL_SEEDS.split(',').map(Number) : [1, 2, 3, 42, 1337];

describe('balance: decisions drive progress, the council runs the settlement', () => {
  seeds.forEach((seed, i) => {
    const persona: Persona = { picks: [i, i + 1, i + 2, i, i + 1] };
    it(`seed ${seed}: a decisive player reaches victory`, { timeout: 120_000 }, () => {
      const r = playthrough(seed, persona);
      console.log(summary(seed, 'decisive', r));
      expect(r.state.defeat).toBe(false);
      expect(r.state.victory).toBe(true);
      const years = Math.floor(r.state.day / DAYS_PER_YEAR);
      expect(years).toBeLessThan(85);
      expect(years).toBeGreaterThan(25);
    });
  });

  it('without decisions the settlement survives but never leaves the first age', { timeout: 120_000 }, () => {
    const r = playthrough(seeds[0], null, 40);
    console.log(summary(seeds[0], 'undecided', r));
    expect(r.state.defeat).toBe(false);
    expect(eraOf(r.state)).toBe(0);
  });
});
