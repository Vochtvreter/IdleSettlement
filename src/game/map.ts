import { MAP_H, MAP_W, BUILDABLE } from './data';
import { hash2, Rng } from './rng';
import { F, T } from './types';

export interface WorldMap {
  w: number;
  h: number;
  seed: number;
  terrain: Uint8Array;
  feature: Uint8Array;
  /** 0..1 elevation, used for shading. */
  elev: Float32Array;
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
    cache.set(seed, m);
  }
  return m;
}

function generate(seed: number): WorldMap {
  // Retry with derived seeds until a map with a good starting site exists.
  for (let attempt = 0; attempt < 20; attempt++) {
    const m = tryGenerate(seed, attempt);
    if (m) return m;
  }
  return tryGenerate(seed, 99, true)!;
}

function tryGenerate(seed: number, attempt: number, force = false): WorldMap | null {
  const s = (seed * 31 + attempt * 7919) | 0;
  const rng = new Rng(s ^ 0x5bd1e995);
  const W = MAP_W;
  const H = MAP_H;
  const terrain = new Uint8Array(W * H);
  const feature = new Uint8Array(W * H);
  const elev = new Float32Array(W * H);
  const moist = new Float32Array(W * H);

  // A coast along one random side gives every map a sea and a hinterland.
  const coastSide = rng.int(0, 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      let e = fbm(x / 14, y / 14, s, 5);
      const nx = x / (W - 1);
      const ny = y / (H - 1);
      const edge = [nx, 1 - nx, ny, 1 - ny][coastSide];
      e -= Math.max(0, 0.22 - edge) * 1.6;
      // gentle overall edge falloff
      const dEdge = Math.min(nx, 1 - nx, ny, 1 - ny);
      e -= Math.max(0, 0.08 - dEdge) * 2.5;
      elev[i] = e;
      moist[i] = fbm(x / 9 + 100, y / 9 + 100, s + 77, 4);
    }
  }
  // Normalise elevation to 0..1
  let min = Infinity;
  let max = -Infinity;
  for (const e of elev) {
    min = Math.min(min, e);
    max = Math.max(max, e);
  }
  for (let i = 0; i < elev.length; i++) elev[i] = (elev[i] - min) / (max - min);

  for (let i = 0; i < W * H; i++) {
    const e = elev[i];
    const m = moist[i];
    let t: T;
    if (e < 0.3) t = T.Deep;
    else if (e < 0.37) t = T.Water;
    else if (e < 0.4) t = T.Sand;
    else if (e > 0.84) t = T.Peak;
    else if (e > 0.74) t = T.Mountain;
    else if (e > 0.66) t = T.Hills;
    else if (m > 0.6) t = T.Dense;
    else if (m > 0.5) t = T.Forest;
    else if (m < 0.38) t = T.Meadow;
    else t = T.Grass;
    terrain[i] = t;
  }

  // Rivers: trace downhill from high ground to water.
  const sources: number[] = [];
  for (let i = 0; i < W * H; i++) if (terrain[i] === T.Mountain || terrain[i] === T.Hills) sources.push(i);
  const riverCount = Math.min(5, Math.floor(sources.length / 40) + 2);
  for (let r = 0; r < riverCount && sources.length; r++) {
    let cur = sources[rng.int(0, sources.length - 1)];
    const seen = new Set<number>();
    for (let step = 0; step < 120; step++) {
      seen.add(cur);
      const x = cur % W;
      const y = Math.floor(cur / W);
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
        const ne = elev[ni] + rng.next() * 0.02;
        if (ne < bestE) {
          bestE = ne;
          best = ni;
        }
      }
      if (best < 0) break;
      cur = best;
    }
  }

  // Pick a start: open land with forest, water and hills nearby, not too far from centre.
  const dist = (a: number, b: number) => Math.hypot((a % W) - (b % W), Math.floor(a / W) - Math.floor(b / W));
  let start = -1;
  let bestScore = -Infinity;
  for (let y = 8; y < H - 8; y++) {
    for (let x = 8; x < W - 8; x++) {
      const i = idx(x, y);
      if (terrain[i] !== T.Grass && terrain[i] !== T.Meadow) continue;
      let forest = 0;
      let water = 0;
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
            if (t === T.River || t === T.Water) water++;
          }
          if (d <= 8 && t === T.Hills) hills++;
          if (d <= 4.5 && (t === T.Hills || t === T.Mountain)) hillsNear++;
          if (d <= 9 && (t === T.Mountain || t === T.Hills)) mountains++;
        }
      }
      const center = Math.hypot(x - W / 2, y - H / 2);
      let score = Math.min(forest, 12) * 2 + Math.min(water, 6) * 3 + Math.min(hills, 6) * 2 + Math.min(open, 20) - center * 0.6;
      if (forest < 5 || water < 1 || open < 12 || mountains < 2 || hillsNear < 1) score -= 100;
      score += rng.next();
      if (score > bestScore) {
        bestScore = score;
        start = i;
      }
    }
  }
  if (start < 0 || (bestScore < 0 && !force)) return null;

  // Clear the starting tile and its ring so the hearth always has room.
  const sx = start % W;
  const sy = Math.floor(start / W);
  terrain[start] = T.Grass;

  const land = (i: number) => BUILDABLE.has(terrain[i]);
  const placeFeature = (f: F, count: number, ok: (i: number) => boolean, minD: number, maxD = 999) => {
    let placed = 0;
    for (let tries = 0; tries < 4000 && placed < count; tries++) {
      const i = rng.int(0, W * H - 1);
      if (feature[i] || !ok(i)) continue;
      const d = dist(i, start);
      if (d < minD || d > maxD) continue;
      feature[i] = f;
      placed++;
    }
    return placed;
  };
  const near = (i: number, set: T[], r = 1) => {
    const x = i % W;
    const y = Math.floor(i / W);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (!inBounds(x + dx, y + dy)) continue;
        if (set.includes(terrain[idx(x + dx, y + dy)])) return true;
      }
    return false;
  };

  // Guarantee an ore vein reachable from the start.
  const oreOk = (i: number) => terrain[i] === T.Hills || (terrain[i] === T.Mountain && near(i, [T.Hills, T.Grass, T.Meadow, T.Forest]));
  if (placeFeature(F.Ore, 1, (i) => terrain[i] === T.Hills, 5, 14) === 0) placeFeature(F.Ore, 1, oreOk, 4, 24);
  placeFeature(F.Ore, 6, oreOk, 8);
  placeFeature(F.Berries, 3, (i) => (terrain[i] === T.Grass || terrain[i] === T.Meadow) && near(i, [T.Forest, T.Dense]), 2, 6);
  placeFeature(F.Berries, 10, (i) => (terrain[i] === T.Grass || terrain[i] === T.Meadow) && near(i, [T.Forest, T.Dense]), 7);
  placeFeature(F.Game, 2, (i) => terrain[i] === T.Forest || terrain[i] === T.Grass, 3, 8);
  placeFeature(F.Game, 9, (i) => terrain[i] === T.Forest || terrain[i] === T.Grass || terrain[i] === T.Meadow, 9);
  placeFeature(F.Fish, 8, (i) => terrain[i] === T.Water && near(i, [T.Sand, T.Grass, T.Meadow]), 3);
  placeFeature(F.Ruins, 5, (i) => land(i) && terrain[i] !== T.Dense, 9);
  placeFeature(F.Tribe, 3, (i) => terrain[i] === T.Grass || terrain[i] === T.Meadow, 11);
  placeFeature(F.Grove, 2, (i) => terrain[i] === T.Dense || terrain[i] === T.Forest, 10);
  placeFeature(F.Cache, 5, (i) => land(i), 7);

  // Make sure the immediate surroundings of the hearth are free of features.
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) feature[idx(sx + dx, sy + dy)] = F.None;

  return { w: W, h: H, seed, terrain, feature, elev, start };
}
