import { describe, expect, it } from 'vitest';
import { placeBuilding, prioritise, setJobTarget, worksQueue } from '../src/game/actions';
import { bridgeTile } from '../src/game/council';
import { BUILDING_DEFS, DAYS_PER_YEAR, MAP_H, MAP_W } from '../src/game/data';
import { canPlace, derived, invalidate } from '../src/game/derived';
import { catchmentAt, drawFrom, footprint, growLand, landMax, LIFE_FLOOR, prepNeeded, ringOf, siteStage, sizeOf, wooded } from '../src/game/land';
import { getMap, idx, inBounds, isWater, N4, tx, ty } from '../src/game/map';
import { deserialize, isLegacySave, serialize } from '../src/game/save';
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
  it('nothing is built on water, peaks, roads or the green; footprints never overlap', () => {
    for (const seed of [1, 7]) {
      const s = newGame(seed, 0, 0);
      const map = getMap(seed);
      const d = derived(s);
      for (const i of d.terrTiles) {
        for (const type of ['hut', 'farm'] as const) {
          const c = canPlace(s, type, i);
          if (!c.ok) continue;
          for (const j of footprint(type, tx(i), ty(i))!) {
            expect(isWater(map.terrain[j]), `${seed}:${type}@${i}`).toBe(false);
            expect(map.terrain[j]).not.toBe(T.Peak);
            expect(d.occupied[j]).toBe(0);
          }
        }
      }
    }
  });

  it('standing forest can be built on: the trees are felled first, for their timber', () => {
    const s = newGame(7, 0, 0);
    s.council.build = false;
    s.council.jobs = false;
    const d = derived(s);
    const tile = d.terrTiles.find((i) => wooded(s, i) && canPlace(s, 'hut', i).ok);
    expect(tile).toBeDefined();
    const wood0 = s.land.wood[tile!];
    s.res.wood = 50;
    expect(placeBuilding(s, 'hut', tile!, tx(tile!), ty(tile!)).ok).toBe(true);
    const b = s.buildings[s.buildings.length - 1];
    expect(siteStage(s, b)).toBe('felling');
    expect(s.land.wood[tile!]).toBe(wood0);
    setJobTarget(s, 'builder', 3);
    // Clearing the way to the site may already have filled the stores.
    s.res.wood = 20;
    const before = s.res.wood;
    run(s, 60);
    expect(s.land.wood[tile!]).toBe(0);
    expect(b.done).toBe(true);
    expect(s.res.wood).toBeGreaterThan(before);
  });

  it('a mountainside can be built on after a long levelling, which turns up stone', () => {
    let found: { s: GameState; tile: number } | null = null;
    for (const seed of [1, 2, 3, 42, 7]) {
      const s = newGame(seed, 0, 0);
      for (let i = 0; i < s.explored.length; i++) s.explored[i] = 1;
      s.techs.push('stone_tools');
      invalidate(s);
      const tile = derived(s).terrTiles.find((i) => getMap(seed).terrain[i] === T.Mountain && canPlace(s, 'hut', i).ok);
      if (tile !== undefined) {
        found = { s, tile };
        break;
      }
    }
    expect(found).not.toBeNull();
    const { s, tile } = found!;
    s.council.build = false;
    const need = prepNeeded(s, 'hut', tx(tile), ty(tile));
    expect(need.level).toBeGreaterThanOrEqual(30);
    s.res.wood = 50;
    expect(placeBuilding(s, 'hut', tile, tx(tile), ty(tile)).ok).toBe(true);
    const b = s.buildings[s.buildings.length - 1];
    expect(siteStage(s, b)).toBe('levelling');
    const stone = s.res.stone;
    for (let k = 0; k < 400 && !b.done; k++) tick(s, ctx());
    expect(b.done).toBe(true);
    expect(s.graded).toContain(tile);
    expect(s.res.stone).toBeGreaterThan(stone);
  });

  it('works are done in queue order, and a site can be moved to the front', () => {
    const s = newGame(3, 0, 0);
    s.council.build = false;
    s.council.jobs = false;
    s.res.wood = 200;
    const d = derived(s);
    const open = d.terrTiles.filter((i) => canPlace(s, 'hut', i).ok && prepNeeded(s, 'hut', tx(i), ty(i)).fell === 0);
    expect(placeBuilding(s, 'hut', open[0], tx(open[0]), ty(open[0])).ok).toBe(true);
    const later = derived(s).terrTiles.find((i) => canPlace(s, 'hut', i).ok && prepNeeded(s, 'hut', tx(i), ty(i)).fell === 0)!;
    expect(placeBuilding(s, 'hut', later, tx(later), ty(later)).ok).toBe(true);
    const [first, second] = worksQueue(s);
    expect(prioritise(s, second.id).ok).toBe(true);
    expect(worksQueue(s)[0].id).toBe(second.id);
    setJobTarget(s, 'builder', 1);
    for (let k = 0; k < 40 && !second.done; k++) tick(s, ctx());
    expect(second.done).toBe(true);
    expect(first.progress).toBeLessThan(BUILDING_DEFS.hut.work);
  });

  it('big buildings cover their whole footprint', () => {
    const s = newGame(5, 0, 0);
    const farm = build(s, 'farm');
    const d = derived(s);
    for (const i of footprint('farm', farm.x, farm.y)!) expect(d.buildingAt[i]).toBe(farm.id);
    expect(canPlace(s, 'hut', idx(farm.x + 1, farm.y + 1)).ok).toBe(false);
  });

  it('every building is joined to a green by a connected road network', () => {
    const s = newGame(11, 0, 0);
    run(s, DAYS_PER_YEAR * 8);
    const d = derived(s);
    expect(s.roads.length).toBeGreaterThan(0);
    for (const b of s.buildings) {
      if (b.type === 'campfire') continue;
      const [w, h] = sizeOf(b.type);
      const touches = ringOf(b.x, b.y, w, h).some(([x, y]) => inBounds(x, y) && d.network[idx(x, y)]);
      expect(touches, `${b.type} at ${b.x},${b.y}`).toBe(true);
    }
    // Every road leads back to a hearth.
    const seen = new Set<number>();
    const queue: number[] = [];
    for (const h of s.buildings.filter((b) => b.type === 'campfire')) (seen.add(idx(h.x, h.y)), queue.push(idx(h.x, h.y)));
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
  it('a bridge opens land across a river', { timeout: 120_000 }, () => {
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
  it('round-trips stocks, roads and herds', { timeout: 60_000 }, () => {
    const s = newGame(21, 0, 0);
    run(s, DAYS_PER_YEAR * 4);
    const back = deserialize(serialize(s))!;
    expect(back.roads).toEqual(s.roads);
    for (const l of ['wood', 'stone', 'ore', 'life'] as const) {
      let off = 0;
      for (let i = 0; i < s.land[l].length; i++) if (Math.abs(back.land[l][i] - s.land[l][i]) >= 0.001) off++;
      expect(off, l).toBe(0);
    }
    expect(serialize(s).length).toBeLessThan(60_000);
  });

  it('declines saves made on the old, smaller world', () => {
    const s = newGame(22, 0, 0);
    const raw = JSON.parse(serialize(s));
    raw.version = 5;
    expect(deserialize(JSON.stringify(raw))).toBeNull();
    expect(isLegacySave(JSON.stringify(raw))).toBe(true);
  });

  it('catchments only reach tiles that hold the resource', () => {
    const s = newGame(5, 0, 0);
    const h = s.buildings[0];
    const m = landMax(5);
    for (const i of catchmentAt(s, 'campfire', h.x, h.y, 'wood')) expect(m.wood[i]).toBeGreaterThan(0);
  });
});

describe('settlements that rebuild themselves', () => {
  it('tear down worked-out pits, and rebuild old huts near the hearth in stone', () => {
    const s = newGame(1, 0, 0);
    s.council.jobs = false;
    s.techs.push('stone_tools', 'era_village', 'agriculture', 'era_bronze', 'masonry');
    const near = (i: number) => Math.hypot(tx(i) - s.towns[0].x, ty(i) - s.towns[0].y) <= 5;
    const hut = build(s, 'hut', near)!;
    const pit = build(s, 'quarry')!;
    pit.spent = true;
    s.towns[0].tier = 2;
    s.res = { ...s.res, wood: 500, stone: 600 };
    invalidate(s);
    s.council.build = true;
    run(s, 25);
    expect(s.buildings.includes(pit)).toBe(false);
    expect(s.buildings.includes(hut)).toBe(false);
    const house = s.buildings.find((b) => b.type === 'house' && b.x === hut.x && b.y === hut.y);
    expect(house).toBeTruthy();
    expect(s.log.some((l) => /make way for a stone house/.test(l.text))).toBe(true);
  });
});
