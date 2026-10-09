/**
 * A "decisive player": the council runs the settlement, and this player only makes decisions —
 * picking each path as soon as it is on offer and choosing the event options. Used by the balance tests.
 */
import { choose, research } from '../src/game/actions';
import { decide, nextPath, pathRequirements } from '../src/game/decisions';
import { techStatus } from '../src/game/actions';
import { TECH_DEFS } from '../src/game/data';
import type { TickContext } from '../src/game/sim';
import type { GameState } from '../src/game/types';

export interface Persona {
  /** Option index to pick for each path (way, path1..path4); wraps. */
  picks: number[];
  focus?: string;
  policies?: Record<string, string>;
}

export function decider(persona: Persona) {
  return (state: GameState, ctx: TickContext) => {
    if (persona.focus && state.decisions.focus !== persona.focus) decide(state, 'focus', persona.focus);
    for (const [k, v] of Object.entries(persona.policies ?? {})) if (state.decisions[k] !== v) decide(state, k, v);
    const p = nextPath(state);
    if (p && pathRequirements(state, p).ready && (!p.tech || techStatus(state, p.tech).ok)) {
      const idx = ['way', 'path1', 'path2', 'path3', 'path4'].indexOf(p.id);
      const opt = p.options[persona.picks[idx % persona.picks.length] % p.options.length];
      decide(state, p.id, opt.id, ctx.fx, research);
    }
    if (state.choice) {
      let pick = state.choice.options.length - 1;
      if (state.choice.id === 'refugees' && state.res.food > 60) pick = 0;
      if (state.choice.id === 'trader' || state.choice.id === 'sage') pick = 0;
      choose(state, ctx, pick);
    }
    void TECH_DEFS;
  };
}
