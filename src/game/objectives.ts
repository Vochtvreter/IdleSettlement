import { MILESTONES } from './decisions';
import { buildingCount } from './derived';
import { eraOf, hasTech } from './state';
import type { GameState } from './types';

/** Returns [current, goal] progress for milestone i. */
export function objectiveProgress(s: GameState, i: number): [number, number] {
  const pop = s.settlers.length;
  switch (i) {
    case 0:
      return [Math.min(40, s.day), 40];
    case 1:
      return [s.techs.filter((t) => !t.startsWith('era_')).length ? 1 : 0, 1];
    case 2:
      return [pop, 12];
    case 3:
      return [Math.min(1, s.claimed.length), 1];
    case 4:
      return [Math.min(1, eraOf(s)), 1];
    case 5:
      return [s.buildings.filter((b) => b.done && b.type !== 'campfire').length, 15];
    case 6:
      return [pop, 30];
    case 7:
      return [Math.min(2, eraOf(s)), 2];
    case 8:
      return [buildingCount(s, 'smithy', false) ? Math.min(20, Math.floor(s.res.tools)) : 0, 20];
    case 9:
      return [Math.min(3, eraOf(s)), 3];
    case 10:
      return [pop, 60];
    case 11:
      return [Math.min(4, eraOf(s)), 4];
    case 12:
      return [hasTech(s, 'architecture') ? 1 : 0, 1];
    case 13:
      return [s.victory ? 1 : 0, 1];
    default:
      return [1, 1];
  }
}

export function checkObjectives(s: GameState) {
  // Several milestones may complete at once (e.g. after offline progress).
  for (let guard = 0; guard < MILESTONES.length && s.objective < MILESTONES.length; guard++) {
    const [cur, goal] = objectiveProgress(s, s.objective);
    if (cur < goal) return;
    s.log.push({ day: s.day, kind: 'good', text: `Milestone reached: ${MILESTONES[s.objective].text}.` });
    s.objective++;
  }
}
