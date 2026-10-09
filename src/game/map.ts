import { MAP_H, MAP_W, BUILDABLE } from './data';
import { hash2, Rng } from './rng';
import { Biome, F, T } from './types';

export interface WorldMap {
  w: number;
  h: number;
  seed: number;
  terrain: Uint8Array;
  feature: Uint8Array;
  /** 0..1 elevation, used for shading. */
  elev: Float32Array;
  /** Climate of each tile. */
  biome: Uint8Array;
  /** Landmass each land tile belongs to (-1 for water). Rivers count as land. */
  island: Int32Array;
  /** Tiles per landmass. */
  islandSize: number[];
  /** Open sea, joined to the edge of the world: where galleys can sail. */
  ocean: Uint8Array;
  start: number;
}

export const idx = (x: number, y: number) => y * MAP_W + x;
export const tx = (i: number) => i % MAP_W;
export const ty = (i: number) => Math.floor(i / MAP_W);
export const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;

export const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
export const N8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export function isWater(t: number) {
  return t === T.Deep || t === T.Water || t === T.River;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(x: number, y: number, seed: number, octaves = 4) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const cache = new Map<number, WorldMap>();

export function getMap(seed: number): WorldMap {
  let m = cache.get(seed);
  if (!m) {
    m = generate(seed);
    // Worlds are large: keep only the few most recent.
    if (cache.size >= 6) cache.delete(cache.keys().next().value!);
    cache.set(seed, m);
  }
  return m;
}

/** Water galleys can sail: the open sea. */
export function isSea(map: WorldMap, i: number) {
  return map.ocean[i] === 1;
}

function generate(seed: number): WorldMap {
  // Retry with derived seeds until a world with a good starting site and other lands to reach exists.
  for (let attempt = 0; attempt < 20; attempt++) {
    const m = tryGenerate(seed, attempt);
    if (m) return m;
  }
  return tryGenerate(seed, 99, true)!;
}

interface Blob {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Share of land tiles below which a height counts as that band (for hills, mountains, peaks). */
function quantile(values: number[], q: number) {
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))];
}

function tryGenerate(seed: number, attempt: number, force = false): WorldMap | null {
  const s = (seed * 31 + attempt * 7919) | 0;
  const rng = new Rng(s ^ 0x5bd1e995);
  const W = MAP_W;
  const H = MAP_H;
  const n = W * H;
  const terrain = new Uint8Array(n);
  const feature = new Uint8Array(n);
  const elev = new Float32Array(n);
  const biome = new Uint8Array(n);
  const raw = new Float32Array(n);
  const height = new Float32Array(n);
  const moist = new Float32Array(n);
  const temp = new Float32Array(n);

  // --- continents: a large home continent in the mild middle latitudes, others to the north and south
  const blobs: Blob[] = [];
  const main: Blob = { cx: W * rng.range(0.4, 0.6), cy: H * rng.range(0.44, 0.56), rx: W * rng.range(0.12, 0.15), ry: H * rng.range(0.15, 0.19) };
  blobs.push(main);
  const fits = (b: Blob, pad: number) =>
    blobs.every((o) => {
      const dx = (b.cx - o.cx) / (b.rx + o.rx);
      const dy = (b.cy - o.cy) / (b.ry + o.ry);
      return Math.hypot(dx, dy) > pad;
    });
  const place = (count: number, rxr: [number, number], ryr: [number, number], band: [number, number] | null, pad: number) => {
    let placed = 0;
    for (let t = 0; t < 400 && placed < count; t++) {
      const b: Blob = {
        cx: W * rng.range(0.08, 0.92),
        cy: H * (band ? rng.range(band[0], band[1]) : rng.range(0.08, 0.92)),
        rx: W * rng.range(rxr[0], rxr[1]),
        ry: H * rng.range(ryr[0], ryr[1]),
      };
      if (!fits(b, pad)) continue;
      blobs.push(b);
      placed++;
    }
  };
  // Lands in the cold north, the hot south, and either side of home.
  place(3, [0.07, 0.12], [0.07, 0.12], [0.06, 0.24], 1.05);
  place(3, [0.07, 0.12], [0.07, 0.12], [0.76, 0.94], 1.05);
  place(4, [0.05, 0.09], [0.07, 0.13], null, 1.05);
  // Smaller lands and scattered isles, for colonies across the sea.
  place(8, [0.025, 0.045], [0.03, 0.06], null, 1.1);
  place(30, [0.008, 0.018], [0.01, 0.024], null, 1.15);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const wx = x + (fbm(x / 34, y / 34, s + 11, 3) - 0.5) * 34;
      const wy = y + (fbm(x / 34, y / 34, s + 12, 3) - 0.5) * 34;
      let mask = -1;
      for (const b of blobs) {
        const dx = (wx - b.cx) / b.rx;
        const dy = (wy - b.cy) / b.ry;
        mask = Math.max(mask, 1 - dx * dx - dy * dy);
      }
      // Keep a margin of sea at the edge of the world.
      const dEdge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (dEdge < 6) mask -= (6 - dEdge) * 0.25;
      const nz = fbm(x / 15, y / 15, s, 5);
      const e = Math.max(-1, mask) * 0.8 + (nz - 0.5) * 1.1;
      raw[i] = e;
      const ridge = 1 - Math.abs(2 * fbm(x / 22, y / 22, s + 5, 4) - 1);
      height[i] = Math.max(0, Math.min(1, e)) * 0.55 + ridge * ridge * ridge * 0.6 * Math.max(0, Math.min(1, mask * 2.5)) + (nz - 0.5) * 0.2;
      moist[i] = fbm(x / 13 + 100, y / 13 + 100, s + 77, 4);
      temp[i] = (y / (H - 1)) * 0.95 + (fbm(x / 40, y / 40, s + 9, 3) - 0.5) * 0.3;
    }
  }

  // --- land and sea
  const isLand = new Uint8Array(n);
  const landH: number[] = [];
  for (let i = 0; i < n; i++)
    if (raw[i] > 0) {
      isLand[i] = 1;
      landH.push(height[i]);
    }
  if (landH.length < n * 0.2) return null;
  const qHills = quantile(landH, 0.77);
  const qMount = quantile(landH, 0.9);
  const qPeak = quantile(landH, 0.965);

  // Distance from land, so the sea near the coast is shallow and the open ocean deep.
  const fromLand = new Int16Array(n).fill(-1);
  {
    const q: number[] = [];
    for (let i = 0; i < n; i++) if (isLand[i]) (fromLand[i] = 0), q.push(i);
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      if (fromLand[i] >= 4) continue;
      for (const [dx, dy] of N4) {
        const x = tx(i) + dx;
        const y = ty(i) + dy;
        if (!inBounds(x, y)) continue;
        const j = idx(x, y);
        if (fromLand[j] >= 0) continue;
        fromLand[j] = fromLand[i] + 1;
        q.push(j);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const tmp = temp[i] - (isLand[i] ? Math.max(0, height[i] - qHills) * 0.6 : 0);
    const b = tmp < 0.3 ? Biome.Boreal : tmp > 0.68 ? (moist[i] < 0.5 ? Biome.Arid : Biome.Tropical) : Biome.Temperate;
    biome[i] = b;
    if (!isLand[i]) {
      terrain[i] = fromLand[i] >= 0 && fromLand[i] <= 2 ? T.Water : T.Deep;
      elev[i] = Math.max(0, Math.min(0.39, 0.39 + raw[i] * 0.4));
      continue;
    }
    const hgt = height[i];
    elev[i] = 0.4 + 0.6 * Math.max(0, Math.min(1, (hgt - landH[0]) / Math.max(0.001, qPeak - landH[0])));
    const m = moist[i];
    let t: T;
    if (hgt > qPeak) t = T.Peak;
    else if (hgt > qMount) t = T.Mountain;
    else if (hgt > qHills) t = T.Hills;
    else if (b === Biome.Boreal) t = m > 0.56 ? T.Dense : m > 0.46 ? T.Forest : m < 0.37 ? T.Meadow : T.Grass;
    else if (b === Biome.Arid) t = m > 0.6 ? T.Forest : m > 0.47 ? T.Grass : m > 0.42 ? T.Meadow : T.Sand;
    else if (b === Biome.Tropical) t = m > 0.57 ? T.Dense : m > 0.5 ? T.Forest : m < 0.42 ? T.Grass : T.Meadow;
    else t = m > 0.6 ? T.Dense : m > 0.5 ? T.Forest : m < 0.38 ? T.Meadow : T.Grass;
    terrain[i] = t;
  }
  // Beaches where low land meets the sea.
  for (let i = 0; i < n; i++) {
    if (!isLand[i] || terrain[i] === T.Hills || terrain[i] === T.Mountain || terrain[i] === T.Peak) continue;
    const x = tx(i);
    const y = ty(i);
    let sea = false;
    for (const [dx, dy] of N8) if (inBounds(x + dx, y + dy) && !isLand[idx(x + dx, y + dy)]) sea = true;
    if (sea && (biome[i] === Biome.Arid || hash2(x, y, s + 3) < 0.55)) terrain[i] = T.Sand;
  }

  // --- rivers: traced downhill from the high ground to the sea
  const sources: number[] = [];
  for (let i = 0; i < n; i++) if (terrain[i] === T.Mountain || terrain[i] === T.Hills) sources.push(i);
  const riverCount = Math.max(6, Math.min(400, Math.floor(landH.length / 650)));
  for (let r = 0; r < riverCount && sources.length; r++) {
    let cur = sources[rng.int(0, sources.length - 1)];
    const seen = new Set<number>();
    for (let step = 0; step < 900; step++) {
      seen.add(cur);
      const x = tx(cur);
      const y = ty(cur);
      if (terrain[cur] === T.Water || terrain[cur] === T.Deep) break;
      if (terrain[cur] !== T.Mountain && terrain[cur] !== T.Peak) terrain[cur] = T.River;
      let best = -1;
      let bestE = Infinity;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (seen.has(ni)) continue;
        const ne = (isLand[ni] ? height[ni] : -1) + rng.next() * 0.03;
        if (ne < bestE) {
          bestE = ne;
          best = ni;
        }
      }
      if (best < 0) break;
      cur = best;
    }
  }
  // Rivers water the desert: oases of green along their banks.
  for (let i = 0; i < n; i++) {
    if (terrain[i] !== T.Sand || biome[i] !== Biome.Arid) continue;
    let river = false;
    for (const [dx, dy] of N8) if (inBounds(tx(i) + dx, ty(i) + dy) && terrain[idx(tx(i) + dx, ty(i) + dy)] === T.River) river = true;
    if (river) terrain[i] = hash2(tx(i), ty(i), s + 4) < 0.3 ? T.Forest : T.Grass;
  }

  // --- landmasses and the open ocean
  const island = new Int32Array(n).fill(-1);
  const islandSize: number[] = [];
  const water = (i: number) => terrain[i] === T.Water || terrain[i] === T.Deep;
  for (let i0 = 0; i0 < n; i0++) {
    if (water(i0) || island[i0] >= 0) continue;
    const id = islandSize.length;
    const q = [i0];
    island[i0] = id;
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      for (const [dx, dy] of N4) {
        const x = tx(i) + dx;
        const y = ty(i) + dy;
        if (!inBounds(x, y)) continue;
        const j = idx(x, y);
        if (island[j] >= 0 || water(j)) continue;
        island[j] = id;
        q.push(j);
      }
    }
    islandSize.push(q.length);
  }
  const ocean = new Uint8Array(n);
  {
    const q: number[] = [];
    for (let x = 0; x < W; x++)
      for (const y of [0, H - 1]) if (water(idx(x, y)) && !ocean[idx(x, y)]) (ocean[idx(x, y)] = 1), q.push(idx(x, y));
    for (let y = 0; y < H; y++)
      for (const x of [0, W - 1]) if (water(idx(x, y)) && !ocean[idx(x, y)]) (ocean[idx(x, y)] = 1), q.push(idx(x, y));
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      for (const [dx, dy] of N4) {
        const x = tx(i) + dx;
        const y = ty(i) + dy;
        if (!inBounds(x, y)) continue;
        const j = idx(x, y);
        if (ocean[j] || !water(j)) continue;
        ocean[j] = 1;
        q.push(j);
      }
    }
  }
  // Several lands worth sailing to.
  if (islandSize.filter((k) => k >= 250).length < 3 && !force) return null;

  // --- a start: open temperate land with forest, water and hills nearby, near the middle of home
  let start = -1;
  let bestScore = -Infinity;
  const mainR = Math.min(main.rx, main.ry) * 0.75;
  for (let y = Math.max(10, Math.floor(main.cy - mainR)); y < Math.min(H - 10, main.cy + mainR); y++) {
    for (let x = Math.max(10, Math.floor(main.cx - mainR)); x < Math.min(W - 10, main.cx + mainR); x++) {
      const i = idx(x, y);
      if (terrain[i] !== T.Grass && terrain[i] !== T.Meadow) continue;
      if (biome[i] !== Biome.Temperate) continue;
      let forest = 0;
      let wat = 0;
      let hills = 0;
      let open = 0;
      let mountains = 0;
      let hillsNear = 0;
      for (let dy = -9; dy <= 9; dy++) {
        for (let dx = -9; dx <= 9; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (!inBounds(xx, yy)) continue;
          const d = Math.hypot(dx, dy);
          const t = terrain[idx(xx, yy)];
          if (d <= 4) {
            if (t === T.Forest || t === T.Dense) forest++;
            if (t === T.Grass || t === T.Meadow) open++;
            if (t === T.River || t === T.Water) wat++;
          }
          if (d <= 8 && t === T.Hills) hills++;
          if (d <= 4.5 && (t === T.Hills || t === T.Mountain)) hillsNear++;
          if (d <= 9 && (t === T.Mountain || t === T.Hills)) mountains++;
        }
      }
      const center = Math.hypot(x - main.cx, y - main.cy);
      let score = Math.min(forest, 12) * 2 + Math.min(wat, 6) * 3 + Math.min(hills, 6) * 2 + Math.min(open, 20) - center * 0.25;
      if (forest < 5 || wat < 1 || open < 12 || mountains < 2 || hillsNear < 1) score -= 100;
      score += rng.next();
      if (score > bestScore) {
        bestScore = score;
        start = i;
      }
    }
  }
  if (start < 0 || (bestScore < 0 && !force)) return null;

  const sx = tx(start);
  const sy = ty(start);
  terrain[start] = T.Grass;
  // The founders clear a green around their fire.
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const i = idx(sx + dx, sy + dy);
      if (terrain[i] === T.Forest || terrain[i] === T.Dense) terrain[i] = T.Grass;
    }

  // --- features, spread over every land in proportion to its size
  const dist = (a: number, b: number) => Math.hypot(tx(a) - tx(b), ty(a) - ty(b));
  const land = (i: number) => BUILDABLE.has(terrain[i]) && terrain[i] !== T.Mountain;
  const placeFeature = (f: F, count: number, ok: (i: number) => boolean, minD: number, maxD = 9999) => {
    let placed = 0;
    // Near the start, try only the tiles close by.
    const local = maxD < 40;
    for (let tries = 0; tries < (local ? 4000 : 60000) && placed < count; tries++) {
      const i = local ? idx(sx + rng.int(-maxD, maxD), sy + rng.int(-maxD, maxD)) : rng.int(0, n - 1);
      if (i < 0 || i >= n || feature[i] || !ok(i)) continue;
      const d = dist(i, start);
      if (d < minD || d > maxD) continue;
      feature[i] = f;
      placed++;
    }
    return placed;
  };
  const near = (i: number, set: T[], r = 1) => {
    const x = tx(i);
    const y = ty(i);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (!inBounds(x + dx, y + dy)) continue;
        if (set.includes(terrain[idx(x + dx, y + dy)])) return true;
      }
    return false;
  };
  // Some climates are richer in some things than others.
  const likes = (i: number, w: Partial<Record<Biome, number>>) => hash2(tx(i), ty(i), s + 21) < (w[biome[i] as Biome] ?? 1);
  const scale = landH.length / 2600;
  const k = (c: number) => Math.max(1, Math.round(c * scale));

  const oreOk = (i: number) => (terrain[i] === T.Hills || (terrain[i] === T.Mountain && near(i, [T.Hills, T.Grass, T.Meadow, T.Forest, T.Sand]))) && likes(i, { [Biome.Arid]: 1, [Biome.Tropical]: 0.6, [Biome.Temperate]: 0.75 });
  if (placeFeature(F.Ore, 1, (i) => terrain[i] === T.Hills, 5, 14) === 0) placeFeature(F.Ore, 1, oreOk, 4, 24);
  placeFeature(F.Ore, k(6), oreOk, 8);
  const berryOk = (i: number) => (terrain[i] === T.Grass || terrain[i] === T.Meadow) && near(i, [T.Forest, T.Dense]) && likes(i, { [Biome.Boreal]: 0.5, [Biome.Arid]: 0.4 });
  placeFeature(F.Berries, 3, (i) => (terrain[i] === T.Grass || terrain[i] === T.Meadow) && near(i, [T.Forest, T.Dense]), 2, 6);
  placeFeature(F.Berries, k(10), berryOk, 7);
  placeFeature(F.Game, 2, (i) => terrain[i] === T.Forest || terrain[i] === T.Grass, 3, 8);
  placeFeature(F.Game, k(9), (i) => (terrain[i] === T.Forest || terrain[i] === T.Grass || terrain[i] === T.Meadow) && likes(i, { [Biome.Arid]: 0.5 }), 9);
  placeFeature(F.Fish, k(8), (i) => terrain[i] === T.Water && near(i, [T.Sand, T.Grass, T.Meadow]) && likes(i, { [Biome.Arid]: 0.6 }), 3);
  placeFeature(F.Ruins, k(5), (i) => land(i) && terrain[i] !== T.Dense, 9);
  placeFeature(F.Tribe, k(3), (i) => terrain[i] === T.Grass || terrain[i] === T.Meadow, 11);
  placeFeature(F.Grove, k(2), (i) => terrain[i] === T.Dense || terrain[i] === T.Forest, 10);
  placeFeature(F.Cache, k(5), (i) => land(i), 7);

  // Make sure the immediate surroundings of the hearth are free of features.
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) feature[idx(sx + dx, sy + dy)] = F.None;

  return { w: W, h: H, seed, terrain, feature, elev, biome, island, islandSize, ocean, start };
}
