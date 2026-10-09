import { techStatus } from './actions';
import { decisionUnlocked, DECISIONS, milestoneDone, nextPath, pathRequirements, TWEAKS, type DecisionDef } from './decisions';
import { eraOf } from './state';
import type { GameState } from './types';

/**
 * Progressive disclosure: parts of the interface appear only once they start to matter,
 * so a new player meets one system at a time. Every check is a pure function of the
 * game state and only ever turns on as the settlement progresses.
 */
export type Tab = 'decide' | 'people' | 'build' | 'research' | 'realm' | 'log';

export function tabRevealed(s: GameState, t: Tab): boolean {
  switch (t) {
    case 'decide':
      return true;
    case 'people':
      return s.day >= 6 || s.objective > 0 || !s.council.jobs;
    case 'build':
      return s.buildings.some((b) => b.type !== 'campfire' && b.done) || s.objective > 0 || !s.council.build;
    case 'research':
      return s.techs.length > 0 || s.objective > 1 || !s.council.research;
    case 'realm':
      return s.techs.includes('scouting') || s.towns.length > 1 || s.expeditions.some((e) => e.kind !== 'scout');
    case 'log':
      return s.objective > 0;
  }
}

/** Council Focus: after the Founding Way is chosen, or once the first days have passed. */
export function focusRevealed(s: GameState) {
  return !!s.decisions.way || s.day >= 16 || (s.decisions.focus ?? 'balanced') !== 'balanced';
}

/** Manual control over the council's work: from the Age of Fields on. */
export function manualRevealed(s: GameState) {
  return eraOf(s) >= 1 || !s.council.jobs || !s.council.build || !s.council.research;
}

export function anyPolicyUnlocked(s: GameState) {
  return DECISIONS.some((d) => d.kind === 'policy' && decisionUnlocked(s, d));
}

export function anyTweakUnlocked(s: GameState) {
  return TWEAKS.some((t) => milestoneDone(s, t.unlock));
}

/** The next era path, when the settlement is ready and can pay for it. */
export function pendingDecision(s: GameState): DecisionDef | null {
  const p = nextPath(s);
  if (!p) return null;
  if (!pathRequirements(s, p).ready) return null;
  if (p.tech && !techStatus(s, p.tech).ok) return null;
  return p;
}

export function revealSignature(s: GameState) {
  return `${focusRevealed(s)}:${manualRevealed(s)}`;
}
