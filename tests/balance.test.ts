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
    `towns ${s.towns.length} (${s.towns.map((t) => t.tier).join('')}) births ${s.stats.births} deaths ${s.stats.deaths} milestone ${s.objective} paths ${Object.entries(s.decisions).map(([k, v]) => `${k}=${v}`).join(',')}`
  );
}

const seeds = process.env.BAL_SEEDS ? process.env.BAL_SEEDS.split(',').map(Number) : [1, 2, 3, 42, 1337];
/** Whole games take a long while (the Sunspire is centuries away), so they only run when asked for: `npm run balance`. */
const FULL = !!process.env.BAL_FULL;

describe('balance: decisions drive progress, the council runs the settlement', () => {
  seeds.forEach((seed, i) => {
    const persona: Persona = { picks: [i, i + 1, i + 2, i, i + 1] };
    it(`seed ${seed}: a decisive player's realm takes root and enters the Age of Bronze, but not yet the Age of Iron`, { timeout: 300_000 }, () => {
      const r = playthrough(seed, persona, 60);
      console.log(summary(seed, 'opening', r));
      expect(r.state.defeat).toBe(false);
      expect(r.minPop).toBeGreaterThan(5);
      expect(eraOf(r.state)).toBeGreaterThanOrEqual(2);
      expect(eraOf(r.state)).toBeLessThan(4);
      expect(r.state.victory).toBe(false);
    });
    it.skipIf(!FULL)(`seed ${seed}: a decisive player raises the Sunspire after centuries`, { timeout: 7_200_000 }, () => {
      const r = playthrough(seed, persona, 600);
      console.log(summary(seed, 'decisive', r));
      expect(r.state.defeat).toBe(false);
      expect(r.state.victory).toBe(true);
      const years = Math.floor(r.state.day / DAYS_PER_YEAR);
      expect(years).toBeGreaterThan(120);
      expect(years).toBeLessThan(500);
    });
  });

  it('without decisions the settlement survives but never leaves the first age', { timeout: 300_000 }, () => {
    const r = playthrough(seeds[0], null, 40);
    console.log(summary(seeds[0], 'undecided', r));
    expect(r.state.defeat).toBe(false);
    expect(eraOf(r.state)).toBe(0);
  });
});
