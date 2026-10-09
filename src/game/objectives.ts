import { OBJECTIVES } from './data';
import { buildingCount, refund } from './derived';
import { eraOf, hasTech } from './state';
import type { GameState } from './types';

const built = (s: GameState, t: Parameters<typeof buildingCount>[1], n = 1) => buildingCount(s, t, false) >= n;

/** Returns [current, goal] progress for objective i. */
export function objectiveProgress(s: GameState, i: number): [number, number] {
  const pop = s.settlers.length;
  switch (i) {
    case 0:
      return [s.settlers.filter((x) => x.job === 'gatherer' || x.job === 'hunter').length, 4];
    case 1:
      return [buildingCount(s, 'hut', false), 1];
    case 2:
      return [hasTech(s, 'stone_tools') ? 1 : 0, 1];
    case 3:
      return [buildingCount(s, 'lumber', false), 1];
    case 4:
      return [buildingCount(s, 'quarry', false), 1];
    case 5:
      return [pop, 14];
    case 6:
      return [Math.min(1, eraOf(s)), 1];
    case 7:
      return [buildingCount(s, 'farm', false), 2];
    case 8:
      return [buildingCount(s, 'granary', false), 1];
    case 9:
      return [pop, 28];
    case 10:
      return [Math.min(2, eraOf(s)), 2];
    case 11:
      return [buildingCount(s, 'mine', false), 1];
    case 12:
      return [built(s, 'smithy') ? Math.min(20, Math.floor(s.res.tools)) : 0, 20];
    case 13:
      return [Math.min(3, eraOf(s)), 3];
    case 14:
      return [Math.min(4, eraOf(s)), 4];
    case 15:
      return [hasTech(s, 'architecture') ? 1 : 0, 1];
    case 16:
      return [s.victory ? 1 : 0, 1];
    default:
      return [1, 1];
  }
}

export function checkObjectives(s: GameState) {
  // Several objectives may complete at once (e.g. after loading or a big event).
  for (let guard = 0; guard < OBJECTIVES.length && s.objective < OBJECTIVES.length; guard++) {
    const [cur, goal] = objectiveProgress(s, s.objective);
    if (cur < goal) return;
    const def = OBJECTIVES[s.objective];
    if (def.reward) refund(s, def.reward);
    s.log.push({ day: s.day, kind: 'good', text: `Goal complete: ${def.text}.` });
    s.objective++;
  }
}
