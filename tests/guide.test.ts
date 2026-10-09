import { describe, expect, it } from 'vitest';
import { GUIDE, nextGuide, pruneGuide } from '../src/game/guide';
import { focusRevealed, manualRevealed, tabRevealed, type Tab } from '../src/game/reveal';
import { deserialize, serialize } from '../src/game/save';
import { emptyRates, tick, type TickContext } from '../src/game/sim';
import { newGame } from '../src/game/state';
import { decider } from './autoplayer';

const TABS: Tab[] = ['decide', 'people', 'build', 'research', 'log'];
/** Tips that only appear if something happens (an event, or something going wrong). */
const CONTEXTUAL = new Set(['hunger', 'cold', 'event']);

describe('a new player meets one system at a time', () => {
  it('starts with only the Decide tab and the Founding Way', () => {
    const s = newGame(1, 0, 0);
    expect(TABS.filter((t) => tabRevealed(s, t))).toEqual(['decide']);
    expect(focusRevealed(s)).toBe(false);
    expect(manualRevealed(s)).toBe(false);
    expect(nextGuide(s)?.id).toBe('welcome');
  });

  it('guide steps are well formed', () => {
    const ids = GUIDE.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GUIDE) if (g.after) expect(ids).toContain(g.after);
  });

  it('reveals every tab and shows every tip over a playthrough', { timeout: 60_000 }, () => {
    const s = newGame(2, 0, 0);
    const play = decider({ picks: [0, 1, 2, 0, 1] });
    const ctx: TickContext = { fx: [], rates: emptyRates() };
    const shown: string[] = [];
    for (let day = 0; day < 600 && !s.guide!.includes('onward'); day++) {
      // A player who reads each tip as soon as it appears.
      pruneGuide(s);
      for (let g = nextGuide(s); g; g = nextGuide(s)) {
        shown.push(g.id);
        s.guide!.push(g.id);
      }
      if (day % 2 === 0) play(s, ctx);
      ctx.fx.length = 0;
      tick(s, ctx);
    }
    expect(TABS.every((t) => tabRevealed(s, t))).toBe(true);
    expect(focusRevealed(s) && manualRevealed(s)).toBe(true);
    for (const g of GUIDE) if (!CONTEXTUAL.has(g.id)) expect(s.guide, g.id).toContain(g.id);
    expect(shown.slice(0, 2)).toEqual(['welcome', 'way']);
    for (const id of ['resources', 'focus', 'people', 'build', 'policies', 'research', 'ages', 'crossroads', 'manual', 'onward']) expect(shown, id).toContain(id);
  });

  it('shows no tips for settlements saved before the guide existed', () => {
    const s = newGame(3, 0, 0);
    delete s.guide;
    const loaded = deserialize(serialize(s))!;
    expect(nextGuide(loaded)).toBeNull();
  });
});
