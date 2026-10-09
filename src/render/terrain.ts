import { MAP_H, MAP_W } from '../game/data';
import { getMap, idx, inBounds, isWater, type WorldMap } from '../game/map';
import { hash2 } from '../game/rng';
import { F, T } from '../game/types';
import { makeCanvas, sprite } from './sprites';

export const TILE = 16;

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Ground colours per terrain per season [spring, summer, autumn, winter]. */
const GROUND: Record<number, string[]> = {
  [T.Deep]: ['#24508f', '#24508f', '#24508f', '#2a4d7a'],
  [T.Water]: ['#3576bf', '#3576bf', '#3576bf', '#5d8fc0'],
  [T.River]: ['#3f86cf', '#3f86cf', '#3f86cf', '#9cc4e4'],
  [T.Sand]: ['#dcc58b', '#e3cb8c', '#d6bb80', '#e6e3dc'],
  [T.Grass]: ['#5fae41', '#71b345', '#a5a046', '#e7ecf0'],
  [T.Meadow]: ['#73bd4a', '#86c04d', '#b7a84d', '#eef1f4'],
  [T.Forest]: ['#4b9539', '#5a9a3c', '#8c8a3c', '#dfe5ea'],
  [T.Dense]: ['#3b7c31', '#477f33', '#6f7333', '#d6dde3'],
  [T.Hills]: ['#5d9f41', '#6da443', '#9a9343', '#e2e7ec'],
  [T.Mountain]: ['#7f8a86', '#848b85', '#878579', '#d9dde3'],
  [T.Peak]: ['#8a9294', '#8a9294', '#8a9294', '#e9edf2'],
};

const SHORE = ['#e5d49c', '#e8d59c', '#ddc78f', '#f1efe9'];

export const TREE_PAL: Record<string, Record<string, string>>[] = [
  { oak: { l: '#9ce05d', L: '#5cae3e', d: '#2f7136', D: '#1d4227' }, pine: { l: '#6fbf4c', L: '#3f8a37', d: '#25603a', D: '#163a26' } },
  { oak: { l: '#86cf53', L: '#4f9a3a', d: '#2f6b35', D: '#1d4227' }, pine: { l: '#5aa846', L: '#357f35', d: '#225a33', D: '#163a26' } },
  { oak: { l: '#f4b84a', L: '#d9742c', d: '#a3442a', D: '#5e2a1d' }, pine: { l: '#5a9a46', L: '#357535', d: '#225030', D: '#163a26' } },
  { oak: { l: '#ffffff', L: '#b9b0a6', d: '#86786d', D: '#4e4140' }, pine: { l: '#ffffff', L: '#dfe8ec', d: '#2c6a3e', D: '#163a26' } },
];

function shade([r, g, b]: RGB, f: number): RGB {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return [c(r), c(g), c(b)];
}

const FOAM = hex('#cfe6f5');
const SHORE_RGB = SHORE.map(hex);

const seasonCache = new Map<string, HTMLCanvasElement>();

export function terrainCanvas(seed: number, season: number): HTMLCanvasElement {
  const key = `${seed}:${season}`;
  let c = seasonCache.get(key);
  if (!c) {
    // Keep at most a couple of maps' worth of seasons cached.
    if (seasonCache.size > 8) seasonCache.clear();
    c = renderTerrain(getMap(seed), season);
    seasonCache.set(key, c);
  }
  return c;
}

function renderTerrain(map: WorldMap, season: number): HTMLCanvasElement {
  const W = MAP_W * TILE;
  const H = MAP_H * TILE;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const data = img.data;
  const t = map.terrain;

  // Ground pass: per-pixel dithered colour.
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = idx(tx, ty);
      const ter = t[i];
      const base = hex(GROUND[ter][season]);
      const water = isWater(ter);
      for (let py = 0; py < TILE; py++) {
        for (let px = 0; px < TILE; px++) {
          const gx = tx * TILE + px;
          const gy = ty * TILE + py;
          const n = hash2(gx, gy, 7);
          let f = 1;
          if (water) {
            const wave = Math.sin((gx + gy * 0.6) * 0.45) + Math.sin(gx * 0.17 - gy * 0.31);
            f = 1 + wave * 0.025 + (n > 0.97 ? 0.12 : 0);
          } else {
            f = n > 0.9 ? 1.08 : n < 0.1 ? 0.92 : 1;
            if (ter === T.Mountain || ter === T.Peak) f *= 0.96 + 0.08 * hash2(gx >> 2, gy >> 2, 3);
          }
          // Shoreline: blend edges of land touching water with sand, and water edges with foam.
          let col = shade(base, f);
          const edgeDist = Math.min(px, py, TILE - 1 - px, TILE - 1 - py);
          if (edgeDist <= 2) {
            const nx = px <= 2 ? -1 : px >= TILE - 3 ? 1 : 0;
            const ny = py <= 2 ? -1 : py >= TILE - 3 ? 1 : 0;
            const check = (dx: number, dy: number) => {
              if (!dx && !dy) return false;
              const ax = tx + dx;
              const ay = ty + dy;
              return inBounds(ax, ay) && isWater(t[idx(ax, ay)]) !== water;
            };
            const touches = check(nx, 0) || check(0, ny) || (nx && ny && check(nx, ny));
            if (touches) {
              if (!water && edgeDist <= 1 && ter !== T.Sand) col = shade(SHORE_RGB[season], n > 0.5 ? 1 : 0.95);
              else if (water && edgeDist === 0 && ter !== T.River) col = FOAM;
              else if (water && edgeDist === 1) col = shade(base, 1.15);
            }
          }
          const o = (gy * W + gx) * 4;
          data[o] = col[0];
          data[o + 1] = col[1];
          data[o + 2] = col[2];
          data[o + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // Decoration pass, row by row so things further down overlap correctly.
  const pal = TREE_PAL[season];
  const oak = sprite('oak', pal.oak);
  const pine = sprite('pine', pal.pine);
  const bush = sprite('bush', pal.oak);
  const berries = sprite('berries', pal.oak);
  const hill = sprite('hill', season === 3 ? { l: '#ffffff', L: '#e6ebef', d: '#c6cfd6', D: '#9aa6b1' } : pal.oak);
  const mountain = sprite('mountain', season === 3 ? { g: '#dfe4ea', W: '#ffffff' } : {});
  const peak = sprite('peak');
  const rock = sprite('rock');
  const reeds = sprite('reeds', season === 3 ? { l: '#d8cdb9', L: '#b5a58a', d: '#8f7e66' } : season === 2 ? { l: '#d8b95a', L: '#b08e3a' } : {});
  const flowers = sprite('flowers');

  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = idx(tx, ty);
      const ter = t[i];
      const X = tx * TILE;
      const Y = ty * TILE;
      const h = (k: number) => hash2(tx, ty, k);
      switch (ter) {
        case T.Forest: {
          const n = 2 + (h(1) > 0.6 ? 1 : 0);
          const trees: [number, number, HTMLCanvasElement][] = [];
          for (let k = 0; k < n; k++) {
            const s = h(10 + k) > 0.55 ? oak : pine;
            trees.push([X + Math.floor(h(20 + k) * 9) - 1, Y + Math.floor(h(30 + k) * 8) - 6, s]);
          }
          trees.sort((a, b) => a[1] - b[1]);
          for (const [x, y, s] of trees) ctx.drawImage(s, x, y);
          break;
        }
        case T.Dense: {
          const trees: [number, number, HTMLCanvasElement][] = [];
          for (let k = 0; k < 4; k++) {
            const s = h(10 + k) > 0.75 ? oak : pine;
            trees.push([X + (k % 2) * 7 + Math.floor(h(20 + k) * 3) - 1, Y + Math.floor(k / 2) * 6 + Math.floor(h(30 + k) * 3) - 8, s]);
          }
          trees.sort((a, b) => a[1] - b[1]);
          for (const [x, y, s] of trees) ctx.drawImage(s, x, y);
          break;
        }
        case T.Hills:
          ctx.drawImage(hill, X, Y + 6);
          if (h(2) > 0.7) ctx.drawImage(rock, X + 2 + Math.floor(h(3) * 6), Y + 3);
          break;
        case T.Mountain:
          ctx.drawImage(mountain, X, Y - 3);
          break;
        case T.Peak:
          ctx.drawImage(peak, X, Y - 4);
          break;
        case T.Grass:
          if (h(4) > 0.86) ctx.drawImage(bush, X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
          else if (h(4) < 0.06) ctx.drawImage(rock, X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
          else if (h(4) < 0.12 && season < 2) ctx.drawImage(flowers, X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 12));
          break;
        case T.Meadow:
          if (season < 3) {
            for (let k = 0; k < 2; k++) if (h(40 + k) > 0.3) ctx.drawImage(flowers, X + Math.floor(h(50 + k) * 9), Y + Math.floor(h(60 + k) * 12));
          }
          break;
        case T.Sand:
          if (h(4) > 0.9) ctx.drawImage(rock, X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
          break;
        case T.River:
        case T.Water: {
          let landNear = false;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            if (inBounds(tx + dx, ty + dy) && !isWater(t[idx(tx + dx, ty + dy)])) landNear = true;
          }
          if (landNear && h(7) > 0.7) ctx.drawImage(reeds, X + Math.floor(h(8) * 10), Y + Math.floor(h(9) * 10));
          break;
        }
      }
      if (map.feature[i] === F.Berries) ctx.drawImage(season === 3 ? bush : berries, X + 4, Y + 8);
    }
  }
  return c;
}
