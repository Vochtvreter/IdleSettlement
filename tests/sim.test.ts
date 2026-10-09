import { describe, expect, it } from 'vitest';
import { placeBuilding, research, setJobTarget } from '../src/game/actions';
import { DAYS_PER_YEAR, MAP_H, MAP_W } from '../src/game/data';
import { canPlace, derived } from '../src/game/derived';
import { getMap, tx, ty } from '../src/game/map';
import { deserialize, serialize, simulateOffline } from '../src/game/save';
import { emptyRates, tick, type TickContext } from '../src/game/sim';
import { newGame } from '../src/game/state';
import { T } from '../src/game/types';

const ctx = (): TickContext => ({ fx: [], rates: emptyRates() });

describe('map generation', () => {
  it('is deterministic per seed and has a sensible start', () => {
    const a = getMap(123);
    const b = getMap(123);
    expect(a.start).toBe(b.start);
    expect(a.terrain.length).toBe(MAP_W * MAP_H);
    expect([T.Grass, T.Meadow]).toContain(a.terrain[a.start]);
  });

  it('always offers somewhere to quarry near the hearth', () => {
    for (const seed of [1, 7, 99, 2024, 31337]) {
      const s = newGame(seed, 0, 0);
      const map = getMap(seed);
      let near = false;
      for (let i = 0; i < map.terrain.length; i++) {
        if (map.terrain[i] !== T.Hills && map.terrain[i] !== T.Mountain) continue;
        if (Math.hypot(tx(i) - tx(map.start), ty(i) - ty(map.start)) <= 5) near = true;
      }
      expect(near, `seed ${seed}`).toBe(true);
      expect(s.settlers.length).toBe(7);
    }
  });
});

describe('simulation', () => {
  it('is deterministic for the same seed and inputs', () => {
    const run = () => {
      const s = newGame(5, 0, 0);
      setJobTarget(s, 'gatherer', 4);
      for (let i = 0; i < 400; i++) tick(s, ctx());
      return serialize({ ...s, lastSave: 0 });
    };
    expect(run()).toBe(run());
  });

  it('a lightly managed camp survives its first years', () => {
    const s = newGame(11, 0, 0);
    setJobTarget(s, 'gatherer', 4);
    for (let i = 0; i < DAYS_PER_YEAR * 3; i++) tick(s, ctx());
    expect(s.defeat).toBe(false);
    expect(s.settlers.length).toBeGreaterThan(3);
  });

  it('builders complete placed buildings and they add housing', () => {
    const s = newGame(3, 0, 0);
    const map = getMap(3);
    const before = derived(s).housing;
    let tile = -1;
    for (let i = 0; i < map.terrain.length && tile < 0; i++) if (canPlace(s, 'hut', i).ok) tile = i;
    expect(tile).toBeGreaterThanOrEqual(0);
    expect(placeBuilding(s, 'hut', tile, tx(tile), ty(tile)).ok).toBe(true);
    setJobTarget(s, 'builder', 2);
    for (let i = 0; i < 20; i++) tick(s, ctx());
    expect(s.buildings.find((b) => b.type === 'hut')?.done).toBe(true);
    expect(derived(s).housing).toBe(before + 4);
  });

  it('refuses research without knowledge and accepts it with', () => {
    const s = newGame(4, 0, 0);
    expect(research(s, 'stone_tools').ok).toBe(false);
    s.res.knowledge = 50;
    expect(research(s, 'stone_tools').ok).toBe(true);
    expect(s.techs).toContain('stone_tools');
  });

  it('job targets are clamped to building slots', () => {
    const s = newGame(8, 0, 0);
    setJobTarget(s, 'hunter', 50);
    expect(s.jobTargets.hunter).toBe(2);
    setJobTarget(s, 'farmer', 5);
    expect(s.jobTargets.farmer).toBe(0); // agriculture unknown
  });
});

describe('saving', () => {
  it('round-trips through serialisation', () => {
    const s = newGame(21, 1, 0);
    for (let i = 0; i < 50; i++) tick(s, ctx());
    const back = deserialize(serialize(s))!;
    expect(back).not.toBeNull();
    expect(back.explored).toEqual(s.explored);
    expect(back.settlers).toEqual(s.settlers);
    expect(back.legacy).toBe(1);
  });

  it('rejects garbage', () => {
    expect(deserialize('not json')).toBeNull();
    expect(deserialize('{"version":-1}')).toBeNull();
  });

  it('offline progress advances time at half speed with a cap', () => {
    const s = newGame(9, 0, 0);
    setJobTarget(s, 'gatherer', 4);
    const r = simulateOffline(s, 200_000)!; // 200s away -> 100 days
    expect(r.days).toBe(100);
    expect(s.day).toBe(100);
    const s2 = newGame(9, 0, 0);
    const r2 = simulateOffline(s2, 1000 * 60 * 60 * 24)!;
    expect(r2.days).toBe(480);
  });
});
