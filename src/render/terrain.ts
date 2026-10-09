import { MAP_H, MAP_W } from '../game/data';
import { landMax } from '../game/land';
import { getMap, idx, inBounds, isWater, tx, ty, type WorldMap } from '../game/map';
import { hash2 } from '../game/rng';
import type { GameState } from '../game/types';
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
  const bush = sprite('bush', pal.oak);
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
        case T.Forest:
        case T.Dense:
          // Trees are drawn live from what the land still holds (see drawForest).
          break;
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
    }
  }
  return c;
}

// ------------------------------------------------------------------ live decoration

interface TreeSlot {
  x: number;
  y: number;
  pine: boolean;
  /** Felling order: higher slots are cut first and regrow last. */
  k: number;
}

const slotCache = new Map<number, Map<number, TreeSlot[]>>();

/** Fixed spots for the trees of each forest tile, as the baked map used to place them. */
export function treeSlots(seed: number): Map<number, TreeSlot[]> {
  let m = slotCache.get(seed);
  if (m) return m;
  m = new Map();
  const map = getMap(seed);
  for (let ty = 0; ty < MAP_H; ty++)
    for (let tx = 0; tx < MAP_W; tx++) {
      const i = idx(tx, ty);
      const ter = map.terrain[i];
      if (ter !== T.Forest && ter !== T.Dense) continue;
      const X = tx * TILE;
      const Y = ty * TILE;
      const h = (k: number) => hash2(tx, ty, k);
      const slots: TreeSlot[] = [];
      if (ter === T.Forest) {
        const n = 2 + (h(1) > 0.6 ? 1 : 0);
        for (let k = 0; k < n; k++) slots.push({ x: X + Math.floor(h(20 + k) * 9) - 1, y: Y + Math.floor(h(30 + k) * 8) - 6, pine: h(10 + k) <= 0.55, k });
      } else {
        for (let k = 0; k < 4; k++) slots.push({ x: X + (k % 2) * 7 + Math.floor(h(20 + k) * 3) - 1, y: Y + Math.floor(k / 2) * 6 + Math.floor(h(30 + k) * 3) - 8, pine: h(10 + k) <= 0.75, k });
      }
      slots.sort((a, b) => a.y - b.y);
      m.set(i, slots);
    }
  slotCache.set(seed, m);
  return m;
}

/**
 * Draw a forest tile as it stands now: full trees for the timber that is left, a sapling for the
 * stand that is growing back, and stumps where trees were felled.
 */
const treeSprites: { oak: HTMLCanvasElement; pine: HTMLCanvasElement; sap: [HTMLCanvasElement, HTMLCanvasElement]; seed: [HTMLCanvasElement, HTMLCanvasElement]; stump: HTMLCanvasElement }[] = [];

function treeSet(season: number) {
  let t = treeSprites[season];
  if (!t) {
    const pal = TREE_PAL[season];
    t = treeSprites[season] = {
      oak: sprite('oak', pal.oak),
      pine: sprite('pine', pal.pine),
      sap: [sprite('sapling', pal.oak), sprite('sapling', pal.pine)],
      seed: [sprite('seedling', pal.oak), sprite('seedling', pal.pine)],
      stump: sprite('stump', season === 3 ? { T: '#f4f1ec', t: '#dcd6cc' } : undefined),
    };
  }
  return t;
}

export function drawForest(ctx: CanvasRenderingContext2D, slots: TreeSlot[], frac: number, season: number) {
  const set = treeSet(season);
  const n = slots.length;
  const grown = Math.floor(frac * n + 1e-6);
  const partial = frac * n - grown;
  for (const s of slots) {
    const cx = s.x + 5;
    const by = s.y + (s.pine ? 13 : 12);
    if (s.k < grown) ctx.drawImage(s.pine ? set.pine : set.oak, s.x, s.y);
    else if (s.k === grown && partial > 0.15) {
      const sp = (partial > 0.55 ? set.sap : set.seed)[s.pine ? 1 : 0];
      ctx.drawImage(sp, cx - Math.floor(sp.width / 2), by - sp.height);
    } else if (frac < 0.999) ctx.drawImage(set.stump, cx - 2, by - set.stump.height);
  }
}

/**
 * Forests and berry thickets, painted once into a map-sized layer per season and touched up tile by
 * tile as trees are felled and regrow, so a whole forest costs a single draw per frame.
 */
export class ForestLayer {
  private layers = new Map<number, { c: HTMLCanvasElement; stage: Int16Array }>();
  private seed = -1;
  private tiles: number[] = [];

  /** What a tile should show, as a small number that changes only when its picture does. */
  private stageOf(state: GameState, i: number, season: number, occupied: Uint8Array) {
    if (occupied[i]) return 0;
    const m = landMax(state.seed);
    if (m.wood[i]) {
      const n = treeSlots(state.seed).get(i)!.length;
      const frac = state.land.wood[i] / m.wood[i];
      const grown = Math.floor(frac * n + 1e-6);
      const partial = frac * n - grown;
      const part = partial > 0.55 ? 2 : partial > 0.15 ? 1 : 0;
      return 1 + grown * 6 + part * 2 + (frac < 0.999 ? 1 : 0);
    }
    return season < 3 && state.land.life[i] > m.life[i] * 0.35 ? 2 : 1;
  }

  private drawTile(ctx: CanvasRenderingContext2D, state: GameState, i: number, season: number, stage: number) {
    if (!stage) return;
    const m = landMax(state.seed);
    if (m.wood[i]) {
      drawForest(ctx, treeSlots(state.seed).get(i)!, state.land.wood[i] / m.wood[i], season);
      return;
    }
    const pal = TREE_PAL[season].oak;
    ctx.drawImage(sprite(stage === 2 ? 'berries' : 'bush', pal), tx(i) * TILE + 4, ty(i) * TILE + 8);
  }

  canvas(state: GameState, season: number, occupied: Uint8Array): HTMLCanvasElement {
    if (state.seed !== this.seed) {
      this.seed = state.seed;
      this.layers.clear();
      const map = getMap(state.seed);
      this.tiles = [];
      for (let i = 0; i < MAP_W * MAP_H; i++) if (treeSlots(state.seed).has(i) || map.feature[i] === F.Berries) this.tiles.push(i);
    }
    let L = this.layers.get(season);
    if (!L) {
      L = { c: makeCanvas(MAP_W * TILE, MAP_H * TILE), stage: new Int16Array(MAP_W * MAP_H).fill(-1) };
      this.layers.set(season, L);
    }
    const changed: number[] = [];
    for (const i of this.tiles) {
      const st = this.stageOf(state, i, season, occupied);
      if (st !== L.stage[i]) {
        L.stage[i] = st;
        changed.push(i);
      }
    }
    if (!changed.length) return L.c;
    const ctx = L.c.getContext('2d')!;
    const stage = L.stage;
    if (changed.length > 200) {
      ctx.clearRect(0, 0, L.c.width, L.c.height);
      for (const i of this.tiles) this.drawTile(ctx, state, i, season, stage[i]);
      return L.c;
    }
    // Repaint just around each changed tile, clipped, redrawing its neighbours in map order.
    for (const i of changed) {
      const x = tx(i);
      const y = ty(i);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x * TILE - 2, y * TILE - 9, TILE + 4, TILE + 10);
      ctx.clip();
      ctx.clearRect(x * TILE - 2, y * TILE - 9, TILE + 4, TILE + 10);
      for (let yy = y - 1; yy <= y + 1; yy++)
        for (let xx = x - 1; xx <= x + 1; xx++) {
          if (!inBounds(xx, yy)) continue;
          const j = idx(xx, yy);
          if (stage[j] > 0) this.drawTile(ctx, state, j, season, stage[j]);
        }
      ctx.restore();
    }
    return L.c;
  }
}
