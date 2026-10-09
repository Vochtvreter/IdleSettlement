import { describe, expect, it } from 'vitest';
import { DAYS_PER_YEAR, TIERS, TRAFFIC_PAVE, TRAFFIC_ROUTE, TRAFFIC_TRAIL } from '../src/game/data';
import { census, derived, invalidate } from '../src/game/derived';
import { hearthOf, landMax, passableMask, TRAIL_WOOD, layRoad } from '../src/game/land';
import { getMap, idx, inBounds, tx, ty } from '../src/game/map';
import { desirePath, findSites, launchPioneers, pairKey, routeOptions, siteFree, siteValues, tierFor, trafficFlow, tradeKnowledge } from '../src/game/realm';
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
  it('grow by themselves between two villages: carts once the way is busy, a paved road once it is busier', () => {
    const s = readyRealm(2, 20);
    found(s);
    s.techs.push('the_wheel');
    for (const t of s.towns) t.tier = 1;
    s.res.stone = 200;
    invalidate(s);
    expect(routeOptions(s).some((o) => o.kind === 'land')).toBe(false);
    const key = pairKey(s.towns[0].id, s.towns[1].id);
    s.traffic[key] = TRAFFIC_ROUTE - 1;
    for (let k = 0; k < 10 && !s.routes.length; k++) tick(s, ctx());
    expect(s.routes.length).toBe(1);
    expect(s.routes[0].kind).toBe('land');
    expect(tradeKnowledge(s)).toBeGreaterThan(0);
    expect(derived(s).towns.get(s.towns[1].id)!.link).toMatch(/road|route/);
    // Not busy enough to pave yet.
    const trails = s.trails.length;
    s.jobTargets.builder = 6;
    s.traffic[key] = TRAFFIC_ROUTE;
    for (let k = 0; k < 30; k++) tick(s, ctx());
    expect(s.routes[0].paved).toBe(0);
    s.traffic[key] = TRAFFIC_PAVE;
    for (let k = 0; k < 60; k++) tick(s, ctx());
    expect(s.trails.length).toBeLessThan(trails);
  });

  it('wear a trail between settlements that are not yet joined, preferring the ways already there', () => {
    const s = readyRealm(2, 20);
    found(s);
    const [A, B] = s.towns;
    // Forget the pioneers' trail: travellers must find their own way.
    s.trails = [];
    invalidate(s);
    const path = desirePath(s, A, B)!;
    expect(path[0]).toBe(idx(A.x, A.y));
    expect(path[path.length - 1]).toBe(idx(B.x, B.y));
    expect(trafficFlow(s, A, B)).toBeGreaterThan(0);
    s.traffic[pairKey(A.id, B.id)] = TRAFFIC_TRAIL - 1;
    for (let k = 0; k < 10; k++) tick(s, ctx());
    expect(s.trails.length).toBeGreaterThan(5);
    expect(s.routes.length).toBe(0);
  });
});

describe('scouting parties', () => {
  /** A young settlement with scouts and nobody deciding for them. */
  function scouting(seed: number, scouts: number) {
    const s = readyRealm(seed, 10);
    // Only the hearth's surroundings are known.
    const h = hearthOf(s);
    for (let i = 0; i < s.explored.length; i++) s.explored[i] = Math.hypot(tx(i) - h.x, ty(i) - h.y) <= 6 ? 1 : 0;
    s.stats.tilesExplored = s.explored.reduce((a, b) => a + b, 0);
    s.council.jobs = false;
    for (const j of Object.keys(s.jobTargets)) s.jobTargets[j as keyof typeof s.jobTargets] = 0;
    s.jobTargets.gatherer = 6;
    s.jobTargets.scout = scouts;
    s.res.food = 500;
    s.day = 2; // spring
    invalidate(s);
    return s;
  }

  it('set out together, make camp, and only bring what they saw home when they return', () => {
    const s = scouting(1, 2);
    for (let k = 0; k < 10 && !s.expeditions.length; k++) tick(s, ctx());
    const e = s.expeditions.find((x) => x.kind === 'scout')!;
    expect(e).toBeTruthy();
    expect(e.people.length).toBe(2);
    const known = s.stats.tilesExplored;
    let camped = false;
    let seen = 0;
    for (let k = 0; k < 80 && s.expeditions.includes(e); k++) {
      tick(s, ctx());
      if ((e.camp ?? 0) > 0) camped = true;
      seen = Math.max(seen, e.found?.length ?? 0);
      // Nobody at home knows what they see until they are back.
      if (s.expeditions.includes(e)) expect(s.stats.tilesExplored).toBe(known);
    }
    expect(s.expeditions.includes(e)).toBe(false);
    expect(camped).toBe(true);
    expect(seen).toBeGreaterThan(40);
    if (e.people.length && s.settlers.some((p) => e.people.includes(p.id))) expect(s.stats.tilesExplored).toBeGreaterThanOrEqual(known + seen);
  });

  it('starve far from home when the provisions run out, and their charts are lost with them', () => {
    const s = scouting(1, 2);
    for (let k = 0; k < 10 && !s.expeditions.length; k++) tick(s, ctx());
    const e = s.expeditions.find((x) => x.kind === 'scout')!;
    for (let k = 0; k < 4; k++) tick(s, ctx());
    // Held up for weeks, with nothing left to eat.
    e.food = -1;
    e.camp = 60;
    const known = s.stats.tilesExplored;
    const deaths = s.stats.deaths;
    for (let k = 0; k < 60 && s.expeditions.includes(e); k++) tick(s, ctx());
    expect(s.expeditions.includes(e)).toBe(false);
    expect(s.stats.deaths - deaths).toBeGreaterThanOrEqual(2);
    expect(s.log.some((l) => /never returned/.test(l.text))).toBe(true);
    expect(s.stats.tilesExplored).toBe(known);
  });

  it('may break camp to settle prime land far from home, sending one of them back with the news', () => {
    const s = readyRealm(1, 20);
    s.council.build = true;
    const home = s.towns[0];
    // The settlement knows only its own surroundings, so pioneers have nowhere to go.
    for (let i = 0; i < s.explored.length; i++) s.explored[i] = Math.hypot(tx(i) - home.x, ty(i) - home.y) <= 6 ? 1 : 0;
    s.stats.tilesExplored = s.explored.reduce((a, b) => a + b, 0);
    invalidate(s);
    const values = siteValues(s.seed);
    let site = -1;
    for (let i = 0; i < values.length; i++)
      if (values[i] >= 26 && Math.hypot(tx(i) - home.x, ty(i) - home.y) > 22 && siteFree(s, i) && (site < 0 || values[i] > values[site])) site = i;
    expect(site).toBeGreaterThanOrEqual(0);
    s.explored.fill(1);
    invalidate(s);
    const path = desirePath(s, home, { ...home, x: tx(site), y: ty(site) })!;
    for (let i = 0; i < s.explored.length; i++) s.explored[i] = Math.hypot(tx(i) - home.x, ty(i) - home.y) <= 6 ? 1 : 0;
    invalidate(s);
    expect(path).toBeTruthy();
    const party = s.settlers.filter((p) => p.town === home.id && p.job === null && p.born < s.day - 20 * DAYS_PER_YEAR).slice(0, 3);
    for (const p of party) p.job = 'scout';
    s.expeditions.push({ id: s.nextExpId++, kind: 'scout', from: home.id, path: [...path, ...path.slice(0, -1).reverse()], turn: path.length - 1, at: 0, step: 0, people: party.map((p) => p.id), started: s.day, food: 200, weary: 0, camp: 0, found: [] });
    const known = s.stats.tilesExplored;
    for (let k = 0; k < 200 && s.towns.length < 2; k++) tick(s, ctx());
    expect(s.towns.length).toBe(2);
    // On prime land along their way (perhaps before they reached the site they were making for).
    const at = idx(s.towns[1].x, s.towns[1].y);
    expect(path).toContain(at);
    expect(values[at]).toBeGreaterThanOrEqual(26);
    const runner = s.expeditions.find((e) => e.kind === 'scout')!;
    expect(runner.messenger).toBe(true);
    expect(runner.people.length).toBe(1);
    const trails = s.trails.length;
    for (let k = 0; k < 200 && s.expeditions.includes(runner); k++) tick(s, ctx());
    expect(s.trails.length).toBeGreaterThan(trails);
    expect(s.stats.tilesExplored).toBeGreaterThan(known);
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

