import { describe, expect, it } from 'vitest';
import { placeBuilding, setJobTarget } from '../src/game/actions';
import { bridgeTile } from '../src/game/council';
import { DAYS_PER_YEAR, MAP_H, MAP_W } from '../src/game/data';
import { canPlace, derived, invalidate } from '../src/game/derived';
import { catchmentAt, drawFrom, growLand, landMax, LIFE_FLOOR, wooded } from '../src/game/land';
import { getMap, idx, inBounds, isWater, N4, tx, ty } from '../src/game/map';
import { deserialize, serialize } from '../src/game/save';
import { emptyRates, tick, type TickContext } from '../src/game/sim';
import { newGame } from '../src/game/state';
import type { GameState } from '../src/game/types';
import { F, T } from '../src/game/types';

const ctx = (): TickContext => ({ fx: [], rates: emptyRates() });
const run = (s: GameState, days: number) => {
  for (let i = 0; i < days; i++) tick(s, ctx());
};

/** A finished building of a type on the first tile that allows it. */
function build(s: GameState, type: Parameters<typeof canPlace>[1], ok: (i: number) => boolean = () => true) {
  s.res = { ...s.res, wood: 500, stone: 500, hides: 100, ore: 100 };
  s.techs.push('stone_tools', 'hunting_traps', 'husbandry', 'agriculture');
  invalidate(s);
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    if (!ok(i) || !canPlace(s, type, i).ok) continue;
    expect(placeBuilding(s, type, i, tx(i), ty(i)).ok).toBe(true);
    const b = s.buildings[s.buildings.length - 1];
    b.done = true;
    invalidate(s);
    return b;
  }
  throw new Error(`nowhere to place ${type}`);
}

describe('occupied land', () => {
  it('nothing is built on water, rock, standing trees, roads or the green', () => {
    for (const seed of [1, 7, 42]) {
      const s = newGame(seed, 0, 0);
      const map = getMap(seed);
      for (let i = 0; i < MAP_W * MAP_H; i++) {
        const t = map.terrain[i];
        const c = canPlace(s, 'hut', i);
        if (isWater(t) || t === T.Mountain || t === T.Peak || wooded(s, i) || derived(s).occupied[i]) expect(c.ok, `${seed}:${i}`).toBe(false);
      }
    }
  });

  it('felled forest can be built on', () => {
    const s = newGame(7, 0, 0);
    const d = derived(s);
    let tile = -1;
    for (let i = 0; i < MAP_W * MAP_H && tile < 0; i++) {
      const c = canPlace(s, 'hut', i);
      if (d.territory[i] && !c.ok && c.reason.startsWith('Trees')) tile = i;
    }
    expect(tile).toBeGreaterThanOrEqual(0);
    s.land.wood[tile] = 0;
    s.landEpoch++;
    const c = canPlace(s, 'hut', tile);
    expect(c.ok ? '' : c.reason).not.toMatch(/^Trees/);
  });

  it('every building is joined to the green by a connected road network', () => {
    const s = newGame(11, 0, 0);
    run(s, DAYS_PER_YEAR * 8);
    const d = derived(s);
    expect(s.roads.length).toBeGreaterThan(0);
    for (const b of s.buildings) {
      if (b.type === 'campfire') continue;
      const touches = N4.some(([dx, dy]) => inBounds(b.x + dx, b.y + dy) && d.network[idx(b.x + dx, b.y + dy)]);
      expect(touches, `${b.type} at ${b.x},${b.y}`).toBe(true);
    }
    // Every road leads back to the hearth.
    const h = s.buildings[0];
    const seen = new Set([idx(h.x, h.y)]);
    const queue = [idx(h.x, h.y)];
    for (let q = 0; q < queue.length; q++)
      for (const [dx, dy] of N4) {
        const x = tx(queue[q]) + dx;
        const y = ty(queue[q]) + dy;
        if (!inBounds(x, y) || seen.has(idx(x, y)) || !d.network[idx(x, y)]) continue;
        seen.add(idx(x, y));
        queue.push(idx(x, y));
      }
    for (const r of s.roads) expect(seen.has(r), `road ${r}`).toBe(true);
  });
});

describe('resources run out', () => {
  it('woodcutters fell the woods, and lumber camps replant them', () => {
    const s = newGame(7, 0, 0);
    s.council.jobs = false;
    const camp = build(s, 'lumber');
    const tiles = derived(s).catchments.wood.get(camp.id)!;
    const before = tiles.reduce((a, i) => a + s.land.wood[i], 0);
    setJobTarget(s, 'woodcutter', 5);
    s.res.wood = 0;
    run(s, 60);
    const after = tiles.reduce((a, i) => a + s.land.wood[i], 0);
    expect(after).toBeLessThan(before - 30);
    // Nobody cutting: the camp's replanting brings the forest back.
    setJobTarget(s, 'woodcutter', 0);
    for (const j of Object.keys(s.jobTargets)) s.jobTargets[j as keyof typeof s.jobTargets] = 0;
    s.council.build = false;
    run(s, DAYS_PER_YEAR);
    expect(tiles.reduce((a, i) => a + s.land.wood[i], 0)).toBeGreaterThan(after + 20);
  });

  it('a quarry is worked out and stops offering work', () => {
    const s = newGame(1, 0, 0);
    s.council.jobs = false;
    s.council.build = false;
    const q = build(s, 'quarry');
    for (const i of derived(s).catchments.stone.get(q.id)!) s.land.stone[i] = 3;
    s.landEpoch++;
    setJobTarget(s, 'quarrier', 4);
    s.res.stone = 0;
    run(s, 30);
    expect(q.spent).toBe(true);
    expect(derived(s).slots.quarrier).toBe(0);
    expect(s.log.some((l) => /worked out/.test(l.text))).toBe(true);
  });

  it('herds hunted hard keep a breeding core and recover', () => {
    const s = newGame(2, 0, 0);
    const map = getMap(2);
    const herd = landMax(2).lifeTiles.find((i) => map.feature[i] === F.Game)!;
    drawFrom(s, 'life', [herd], 1000);
    const max = landMax(2).life[herd];
    expect(s.land.life[herd]).toBeCloseTo(max * LIFE_FLOOR, 5);
    const d = derived(s);
    for (let k = 0; k < 60; k++) growLand(s, 1, { replant: d.replant, occupied: d.occupied, sites: d.siteMask, trail: d.trail, regrow: 1, replanting: true });
    expect(s.land.life[herd]).toBeGreaterThan(max * LIFE_FLOOR * 2);
  });

  it('pastures breed their herd up over the seasons', () => {
    const s = newGame(3, 0, 0);
    s.council.build = false;
    const p = build(s, 'pasture');
    run(s, 2);
    const start = p.stock!;
    run(s, DAYS_PER_YEAR);
    expect(p.stock!).toBeGreaterThan(start + 2);
  });
});

describe('bridges', () => {
  it('a bridge opens land across a river', () => {
    let found: { s: GameState; tile: number } | null = null;
    for (let seed = 1; seed < 400 && !found; seed++) {
      const s = newGame(seed, 0, 0);
      for (let i = 0; i < s.explored.length; i++) s.explored[i] = 1;
      const tile = bridgeTile(s);
      if (tile !== null) found = { s, tile };
    }
    expect(found).not.toBeNull();
    const { s, tile } = found!;
    const d = derived(s);
    const far = N4.map(([dx, dy]) => idx(tx(tile) + dx, ty(tile) + dy)).filter((i) => !d.reach[i] && !isWater(getMap(s.seed).terrain[i]));
    expect(far.length).toBeGreaterThan(0);
    s.res.wood = 100;
    expect(placeBuilding(s, 'bridge', tile, tx(tile), ty(tile)).ok).toBe(true);
    s.buildings[s.buildings.length - 1].done = true;
    invalidate(s);
    expect(far.some((i) => derived(s).reach[i])).toBe(true);
  });
});

describe('saving the land', () => {
  it('round-trips stocks, roads and herds', () => {
    const s = newGame(21, 0, 0);
    run(s, DAYS_PER_YEAR * 4);
    const back = deserialize(serialize(s))!;
    expect(back.roads).toEqual(s.roads);
    for (const l of ['wood', 'stone', 'ore', 'life'] as const)
      for (let i = 0; i < s.land[l].length; i++) expect(Math.abs(back.land[l][i] - s.land[l][i])).toBeLessThan(0.001);
    expect(serialize(s).length).toBeLessThan(60_000);
  });

  it('upgrades saves from before the land could run out', () => {
    const s = newGame(22, 0, 0);
    run(s, DAYS_PER_YEAR * 3);
    const raw = JSON.parse(serialize(s));
    raw.version = 4;
    delete raw.land;
    delete raw.roads;
    delete raw.landEpoch;
    delete raw.eff;
    const back = deserialize(JSON.stringify(raw))!;
    expect(back).not.toBeNull();
    expect(back.land.wood.length).toBe(MAP_W * MAP_H);
    expect(back.roads.length).toBeGreaterThan(0);
    run(back, 20);
    expect(back.defeat).toBe(false);
  });

  it('catchments only reach tiles that hold the resource', () => {
    const s = newGame(5, 0, 0);
    const h = s.buildings[0];
    const m = landMax(5);
    for (const i of catchmentAt(s, 'campfire', h.x, h.y, 'wood')) expect(m.wood[i]).toBeGreaterThan(0);
  });
});
