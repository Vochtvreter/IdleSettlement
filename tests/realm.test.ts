import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR, TIERS } from '../src/game/data';
import { census, derived, invalidate } from '../src/game/derived';
import { hearthOf, landMax, passableMask, TRAIL_WOOD, layRoad } from '../src/game/land';
import { getMap, idx, inBounds, tx, ty } from '../src/game/map';
import { findSites, launchPioneers, openRoute, routeOptions, tierFor, tradeKnowledge } from '../src/game/realm';
import { Rng } from '../src/game/rng';
import { deserialize, serialize } from '../src/game/save';
import { emptyRates, tick, type TickContext } from '../src/game/sim';
import { makeSettler, newGame } from '../src/game/state';
import type { GameState } from '../src/game/types';
import { Biome, T } from '../src/game/types';

const ctx = (): TickContext => ({ fx: [], rates: emptyRates() });

/** A camp that knows Pathfinding, has seen the land around it and has people to spare. */
function readyRealm(seed: number, extra = 14): GameState {
  const s = newGame(seed, 0, 0);
  s.council.build = false;
  const map = getMap(seed);
  const h = hearthOf(s);
  for (let i = 0; i < s.explored.length; i++) if (Math.hypot(tx(i) - h.x, ty(i) - h.y) < 40 && map.island[i] === map.island[map.start]) s.explored[i] = 1;
  s.stats.tilesExplored = s.explored.reduce((a, b) => a + b, 0);
  s.techs.push('stone_tools', 'era_village', 'scouting');
  const rng = new Rng(seed);
  for (let k = 0; k < extra; k++) s.settlers.push(makeSettler(s, rng, s.day - (18 + k) * DAYS_PER_YEAR, 1, 1));
  s.res = { ...s.res, food: 120, wood: 100 };
  invalidate(s);
  return s;
}

/** Run until the pioneers arrive and light their hearth. */
function found(s: GameState) {
  const sites = findSites(s, 1);
  expect(sites.length).toBeGreaterThan(0);
  expect(launchPioneers(s, ctx(), 1, sites[0]).ok).toBe(true);
  for (let k = 0; k < 400 && s.towns.length < 2; k++) tick(s, ctx());
  expect(s.towns.length).toBe(2);
  return sites[0];
}

describe('a great world', () => {
  it('has oceans between several lands, in several climates, and a mild home', () => {
    for (const seed of [1, 42]) {
      const map = getMap(seed);
      expect(map.islandSize.filter((n) => n >= 250).length).toBeGreaterThanOrEqual(3);
      let sea = 0;
      const biomes = new Set<number>();
      for (let i = 0; i < map.terrain.length; i++) {
        if (map.ocean[i]) sea++;
        if (map.island[i] >= 0) biomes.add(map.biome[i]);
      }
      expect(sea).toBeGreaterThan(map.terrain.length * 0.3);
      expect(biomes.size).toBeGreaterThanOrEqual(3);
      expect(map.biome[map.start]).toBe(Biome.Temperate);
    }
  });
});

describe('pioneers', () => {
  it('find prime land along a path they can walk, away from other settlements', () => {
    const s = readyRealm(1);
    const map = getMap(1);
    const sites = findSites(s, 1);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const h = hearthOf(s);
      expect(site.path[0]).toBe(idx(h.x, h.y));
      expect(site.path[site.path.length - 1]).toBe(site.tile);
      for (let k = 1; k < site.path.length; k++) {
        const a = site.path[k - 1];
        const b = site.path[k];
        expect(Math.abs(tx(a) - tx(b)) + Math.abs(ty(a) - ty(b))).toBe(1);
        expect(s.explored[b]).toBe(1);
        expect([T.Water, T.Deep, T.Peak]).not.toContain(map.terrain[b]);
      }
      expect(Math.hypot(tx(site.tile) - h.x, ty(site.tile) - h.y)).toBeGreaterThanOrEqual(15);
    }
    // Ranked best first.
    for (let k = 1; k < sites.length; k++) expect(sites[k - 1].score).toBeGreaterThanOrEqual(sites[k].score);
  });

  it('blaze a trail and found a settlement where it ends', () => {
    const s = readyRealm(2);
    const before = s.settlers.length;
    const site = found(s);
    const town = s.towns[1];
    expect(idx(town.x, town.y)).toBe(site.tile);
    expect(s.settlers.length).toBeGreaterThanOrEqual(before - 1);
    expect(s.settlers.filter((p) => p.town === town.id).length).toBeGreaterThan(0);
    expect(s.settlers.every((p) => p.town !== 0)).toBe(true);
    expect(s.buildings.some((b) => b.type === 'campfire' && b.town === town.id)).toBe(true);
    expect(s.trails.length).toBeGreaterThan(5);
    // The trail joins the new settlement to the capital.
    expect(derived(s).towns.get(town.id)!.link).not.toBe('none');
    expect(s.explored[site.tile]).toBe(1);
  });
});

describe('trails', () => {
  it('keep their thinned woods, and stay passable once paved', () => {
    const s = readyRealm(2);
    found(s);
    const m = landMax(2);
    const wooded = s.trails.filter((i) => m.wood[i] > 0);
    for (let k = 0; k < 20; k++) tick(s, ctx());
    for (const i of wooded) if (s.trails.includes(i)) expect(s.land.wood[i]).toBeGreaterThan(0);
    for (const i of wooded) if (s.trails.includes(i)) expect(s.land.wood[i]).toBeLessThanOrEqual(m.wood[i] * TRAIL_WOOD + 1e-6);
    const pass = passableMask(s);
    const crossing = s.trails.filter((i) => pass[i] && [T.River, T.Mountain].includes(getMap(2).terrain[i]));
    layRoad(s, s.trails.slice());
    const after = passableMask(s);
    for (const i of crossing) expect(after[i]).toBe(1);
  });
});

describe('pioneers keep to free land', () => {
  it('will not set out for land that has since been settled, or from the wrong place', () => {
    const s = readyRealm(2);
    const sites = findSites(s, 1);
    found(s);
    const taken = sites.find((x) => Math.hypot(tx(x.tile) - s.towns[1].x, ty(x.tile) - s.towns[1].y) < 15);
    if (taken) expect(launchPioneers(s, ctx(), 1, taken).ok).toBe(false);
    const next = findSites(s, 1)[0];
    if (next) expect(launchPioneers(s, ctx(), s.towns[1].id, next).ok).toBe(false);
  });
});

describe('determinism', () => {
  it('plays out the same after saving and loading', () => {
    const a = newGame(4, 0, 0);
    for (let k = 0; k < 60; k++) tick(a, ctx());
    const b = deserialize(serialize(a))!;
    for (let k = 0; k < 200; k++) {
      tick(a, ctx());
      tick(b, ctx());
    }
    expect(serialize({ ...b, lastSave: 0 })).toBe(serialize({ ...a, lastSave: 0 }));
  });
});

describe('settlements', () => {
  it('grow through the tiers with their people, buildings and the age', () => {
    const s = newGame(3, 0, 0);
    expect(tierFor(s, s.towns[0])).toBe(0);
    const rng = new Rng(3);
    for (let k = 0; k < TIERS[2].pop; k++) s.settlers.push(makeSettler(s, rng, -20 * DAYS_PER_YEAR, 1, 1));
    // Without buildings or the second age it stays small.
    expect(tierFor(s, s.towns[0])).toBeLessThan(2);
    s.techs.push('era_village');
    for (let k = 0; k < TIERS[2].buildings; k++) s.buildings.push({ id: 900 + k, type: 'hut', x: 2 + (k % 10), y: 2 + Math.floor(k / 10), progress: 8, done: true, town: 1 });
    invalidate(s);
    expect(tierFor(s, s.towns[0])).toBe(2);
  });

  it('staff their workplaces with their own people, scarce work first', () => {
    const s = readyRealm(2);
    found(s);
    const town = s.towns[1];
    const d0 = derived(s);
    const adults = census(s).adults.get(town.id)!;
    expect(d0.towns.get(town.id)!.slots).toBeLessThanOrEqual(Math.max(adults, d0.towns.get(town.id)!.fullSlots));
    expect(d0.towns.get(town.id)!.slots).toBeLessThanOrEqual(adults);
  });

  it('draw settlers where there is work and room', () => {
    const s = readyRealm(2, 20);
    found(s);
    const town = s.towns[1];
    // Free homes and empty workplaces in the new settlement.
    const h = hearthOf(s, town.id);
    let placed = 0;
    for (let dy = -4; dy <= 4 && placed < 3; dy++)
      for (let dx = -4; dx <= 4 && placed < 3; dx++) {
        const x = h.x + dx;
        const y = h.y + dy;
        if (!inBounds(x, y) || Math.max(Math.abs(dx), Math.abs(dy)) < 2 || dx === 0 || dy === 0) continue;
        const i = idx(x, y);
        if (derived(s).occupied[i] || [T.Water, T.Deep, T.River, T.Mountain, T.Peak].includes(getMap(2).terrain[i])) continue;
        s.buildings.push({ id: s.nextBuildingId++, type: placed === 0 ? 'lodge' : 'hut', x, y, progress: 10, done: true, town: town.id });
        invalidate(s);
        placed++;
      }
    const before = census(s).residents.get(town.id)!;
    for (let k = 0; k < 30; k++) tick(s, ctx());
    expect(census(s).residents.get(town.id)!).toBeGreaterThan(before);
  });
});

describe('trade routes', () => {
  it('join two villages, bring knowledge and pave the trail', () => {
    const s = readyRealm(2, 20);
    found(s);
    s.techs.push('the_wheel');
    for (const t of s.towns) t.tier = 1;
    s.res.wood = 200;
    s.res.stone = 200;
    invalidate(s);
    const opt = routeOptions(s).find((o) => o.kind === 'land');
    expect(opt?.ok, opt?.reason).toBe(true);
    expect(openRoute(s, ctx(), s.towns[0].id, s.towns[1].id).ok).toBe(true);
    expect(tradeKnowledge(s)).toBeGreaterThan(0);
    expect(derived(s).towns.get(s.towns[1].id)!.link).toMatch(/road|route/);
    const trails = s.trails.length;
    s.jobTargets.builder = 6;
    for (let k = 0; k < 60; k++) tick(s, ctx());
    expect(s.trails.length).toBeLessThan(trails);
  });
});

describe('saving the realm', () => {
  it('round-trips settlements, trails, expeditions and routes', () => {
    const s = readyRealm(2);
    const sites = findSites(s, 1);
    launchPioneers(s, ctx(), 1, sites[0]);
    for (let k = 0; k < 5; k++) tick(s, ctx());
    const back = deserialize(serialize(s))!;
    expect(back.towns).toEqual(s.towns);
    expect(back.trails).toEqual(s.trails);
    expect(back.expeditions).toEqual(s.expeditions);
    expect(back.settlers.map((p) => p.town)).toEqual(s.settlers.map((p) => p.town));
    for (let k = 0; k < 300 && back.towns.length < 2; k++) tick(back, ctx());
    expect(back.towns.length).toBe(2);
  });
});

