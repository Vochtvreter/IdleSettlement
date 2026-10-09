import { MAP_H, MAP_W } from '../game/data';
import { landMax } from '../game/land';
import { getMap, idx, inBounds, isWater, tx, ty, type WorldMap } from '../game/map';
import { hash2 } from '../game/rng';
import type { GameState } from '../game/types';
import { Biome, F, T } from '../game/types';
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

/** Ground colours that differ by climate (others fall back to the temperate ones). */
const BIOME_GROUND: Partial<Record<Biome, Partial<Record<number, string[]>>>> = {
  [Biome.Boreal]: {
    [T.Grass]: ['#6f9f5a', '#7aa95c', '#9b9a55', '#eef2f5'],
    [T.Meadow]: ['#86a866', '#93b06a', '#a9a05a', '#f2f4f6'],
    [T.Forest]: ['#4f8a45', '#588f48', '#6e8040', '#e6ebef'],
    [T.Dense]: ['#3d7240', '#447744', '#4f6c3a', '#dde3e8'],
    [T.Hills]: ['#6c9a55', '#76a058', '#8f9150', '#eef1f4'],
  },
  [Biome.Arid]: {
    [T.Sand]: ['#e3c98a', '#e9cd8c', '#ddbd7e', '#e0c58a'],
    [T.Grass]: ['#b3ad5c', '#bdb05a', '#c2a85a', '#b7a868'],
    [T.Meadow]: ['#c7b866', '#d0bb63', '#cdb063', '#c4b26f'],
    [T.Forest]: ['#8f9a48', '#979c47', '#9c9346', '#959a52'],
    [T.Dense]: ['#6f8a3c', '#768c3c', '#7c843b', '#748a44'],
    [T.Hills]: ['#b59a5e', '#bb9d5d', '#b5925a', '#b39a64'],
    [T.Mountain]: ['#a28a6e', '#a68c6d', '#a28668', '#a08a72'],
  },
  [Biome.Tropical]: {
    [T.Grass]: ['#4fae3e', '#58b442', '#62ad40', '#4ea83f'],
    [T.Meadow]: ['#63bd48', '#6cc24c', '#79b94a', '#62b84a'],
    [T.Forest]: ['#3f9536', '#459a38', '#4c9437', '#3f9236'],
    [T.Dense]: ['#2e7a2d', '#33802f', '#387a2e', '#2f792e'],
    [T.Hills]: ['#57a043', '#5fa646', '#6aa044', '#579e44'],
    [T.Sand]: ['#ead79e', '#eed99f', '#e6d197', '#ead79e'],
  },
};

/** The season as a climate shows it: the hot south has no snow, only a dry spell or the rains. */
export function climateSeason(biome: number, season: number) {
  if (season === 3 && biome === Biome.Arid) return 2;
  if (season === 3 && biome === Biome.Tropical) return 1;
  return season;
}

function groundColor(ter: number, biome: number, season: number): string {
  return (BIOME_GROUND[biome as Biome]?.[ter] ?? GROUND[ter])[season];
}

const GRADED = ['#a8885a', '#ad8b5b', '#a98657', '#d9d1c4'];

/** Terrain is painted in chunks of this many tiles square, as they come into view. */
export const CHUNK = 32;
const CHUNKS_X = Math.ceil(MAP_W / CHUNK);

const chunkCache = new Map<string, HTMLCanvasElement>();
const gradedMemo = { seed: -1, n: -1, perChunk: new Map<number, number>(), set: new Set<number>() };

function gradedInfo(state: GameState) {
  if (gradedMemo.seed !== state.seed || gradedMemo.n !== state.graded.length) {
    gradedMemo.seed = state.seed;
    gradedMemo.n = state.graded.length;
    gradedMemo.perChunk.clear();
    gradedMemo.set = new Set(state.graded);
    for (const i of state.graded) {
      const c = Math.floor(ty(i) / CHUNK) * CHUNKS_X + Math.floor(tx(i) / CHUNK);
      gradedMemo.perChunk.set(c, (gradedMemo.perChunk.get(c) ?? 0) + 1);
    }
  }
  return gradedMemo;
}

/**
 * One chunk of the world's ground as it looks in a season, or null if it is not painted yet and the
 * frame's painting budget is spent (the caller shows the overview instead).
 */
export function terrainChunk(state: GameState, season: number, cx: number, cy: number, budget: { n: number }): HTMLCanvasElement | null {
  const g = gradedInfo(state);
  const key = `${state.seed}:${season}:${cx}:${cy}:${g.perChunk.get(cy * CHUNKS_X + cx) ?? 0}`;
  let c = chunkCache.get(key);
  if (c) {
    // Most recently used last.
    chunkCache.delete(key);
    chunkCache.set(key, c);
    return c;
  }
  if (budget.n <= 0) return null;
  budget.n--;
  c = renderChunk(getMap(state.seed), season, cx, cy, g.set);
  if (chunkCache.size > 72) chunkCache.delete(chunkCache.keys().next().value!);
  chunkCache.set(key, c);
  return c;
}

function renderChunk(map: WorldMap, season: number, cx: number, cy: number, graded: Set<number>): HTMLCanvasElement {
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;
  const x1 = Math.min(MAP_W, x0 + CHUNK);
  const y1 = Math.min(MAP_H, y0 + CHUNK);
  const W = CHUNK * TILE;
  const H = CHUNK * TILE;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const data = img.data;
  const t = map.terrain;

  // Ground pass: per-pixel dithered colour.
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) {
      const i = idx(tx, ty);
      const ter = t[i];
      const bio = map.biome[i];
      const sea = climateSeason(bio, season);
      const flat = graded.has(i);
      const base = hex(flat ? GRADED[sea] : groundColor(ter, bio, sea));
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
            if (!flat && (ter === T.Mountain || ter === T.Peak)) f *= 0.96 + 0.08 * hash2(gx >> 2, gy >> 2, 3);
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
              if (!water && edgeDist <= 1 && ter !== T.Sand) col = shade(SHORE_RGB[sea], n > 0.5 ? 1 : 0.95);
              else if (water && edgeDist === 0 && ter !== T.River) col = FOAM;
              else if (water && edgeDist === 1) col = shade(base, 1.15);
            }
          }
          const o = ((gy - y0 * TILE) * W + (gx - x0 * TILE)) * 4;
          data[o] = col[0];
          data[o + 1] = col[1];
          data[o + 2] = col[2];
          data[o + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  // Decoration pass, row by row so things further down overlap correctly. Tiles just outside the
  // chunk are drawn too (clipped by the canvas) so sprites that spill over the edge stay whole.
  ctx.translate(-x0 * TILE, -y0 * TILE);
  for (let ty = Math.max(0, y0 - 1); ty < Math.min(MAP_H, y1 + 1); ty++) {
    for (let tx = Math.max(0, x0 - 1); tx < Math.min(MAP_W, x1 + 1); tx++) {
      const i = idx(tx, ty);
      if (graded.has(i)) continue;
      const ter = t[i];
      const bio = map.biome[i];
      const sea = climateSeason(bio, season);
      const pal = TREE_PAL[sea];
      const X = tx * TILE;
      const Y = ty * TILE;
      const h = (k: number) => hash2(tx, ty, k);
      switch (ter) {
        case T.Forest:
        case T.Dense:
          // Trees are drawn live from what the land still holds (see ForestLayer).
          break;
        case T.Hills:
          ctx.drawImage(sprite('hill', sea === 3 ? { l: '#ffffff', L: '#e6ebef', d: '#c6cfd6', D: '#9aa6b1' } : bio === Biome.Arid ? { l: '#d8bf7f', L: '#bfa266', d: '#9a7f4f', D: '#6e5a3a' } : pal.oak), X, Y + 6);
          if (h(2) > 0.7) ctx.drawImage(sprite('rock'), X + 2 + Math.floor(h(3) * 6), Y + 3);
          break;
        case T.Mountain:
          ctx.drawImage(sprite('mountain', sea === 3 ? { g: '#dfe4ea', W: '#ffffff' } : bio === Biome.Arid ? { g: '#b39a7a', G: '#8a7258', W: '#d8c6a4' } : {}), X, Y - 3);
          break;
        case T.Peak:
          ctx.drawImage(sprite('peak'), X, Y - 4);
          break;
        case T.Grass:
          if (bio === Biome.Arid) {
            if (h(4) > 0.9) ctx.drawImage(sprite('bush', { l: '#c9c06a', L: '#9d9a4c', d: '#757a3a', D: '#4f5428' }), X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
            else if (h(4) < 0.05) ctx.drawImage(sprite('rock'), X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
          } else if (h(4) > 0.86) ctx.drawImage(sprite('bush', pal.oak), X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
          else if (h(4) < 0.06) ctx.drawImage(sprite('rock'), X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
          else if (h(4) < 0.12 && sea < 2) ctx.drawImage(sprite('flowers'), X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 12));
          break;
        case T.Meadow:
          if (sea < 3 && bio !== Biome.Arid) {
            for (let k = 0; k < 2; k++) if (h(40 + k) > 0.3) ctx.drawImage(sprite('flowers'), X + Math.floor(h(50 + k) * 9), Y + Math.floor(h(60 + k) * 12));
          }
          break;
        case T.Sand:
          if (bio === Biome.Arid) {
            if (h(4) > 0.55) ctx.drawImage(sprite('dune'), X + Math.floor(h(5) * 5), Y + 3 + Math.floor(h(6) * 9));
            if (h(7) > 0.9) ctx.drawImage(sprite('cactus', { l: '#8fc25a', L: '#5f9a3e', d: '#3f7432', D: '#25482a' }), X + 4 + Math.floor(h(8) * 5), Y + 2);
          } else if (h(4) > 0.9) ctx.drawImage(sprite('rock'), X + Math.floor(h(5) * 8), Y + Math.floor(h(6) * 10));
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
          const reeds = sprite('reeds', sea === 3 ? { l: '#d8cdb9', L: '#b5a58a', d: '#8f7e66' } : sea === 2 ? { l: '#d8b95a', L: '#b08e3a' } : {});
          if (landNear && h(7) > 0.7) ctx.drawImage(reeds, X + Math.floor(h(8) * 10), Y + Math.floor(h(9) * 10));
          break;
        }
      }
    }
  }
  return c;
}

/** Overview colours for terrain, a little darker for woods and lighter for rock. */
const overviewCache = new Map<string, HTMLCanvasElement>();
export const OVERVIEW_PX = 4;

/** The whole world at a few pixels per tile, for zoomed-out views and the minimap. */
export function overviewCanvas(seed: number, season: number): HTMLCanvasElement {
  const key = `${seed}:${season}`;
  let c = overviewCache.get(key);
  if (c) return c;
  const map = getMap(seed);
  const P = OVERVIEW_PX;
  c = makeCanvas(MAP_W * P, MAP_H * P);
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++) {
      const i = idx(x, y);
      const ter = map.terrain[i];
      const bio = map.biome[i];
      const sea = climateSeason(bio, season);
      ctx.fillStyle = groundColor(ter, bio, sea);
      ctx.fillRect(x * P, y * P, P, P);
      const h = hash2(x, y, 9);
      if (ter === T.Forest || ter === T.Dense) {
        ctx.fillStyle = sea === 3 ? '#9fb0a6' : bio === Biome.Arid ? '#5f6f2e' : '#2a5e2c';
        ctx.fillRect(x * P + Math.floor(h * 2), y * P + 1, 2, 2);
        if (ter === T.Dense) ctx.fillRect(x * P + 2 - Math.floor(h * 2), y * P + 2, 2, 2);
      } else if (ter === T.Mountain || ter === T.Peak) {
        ctx.fillStyle = ter === T.Peak || sea === 3 ? '#ffffff' : '#c3c6c0';
        ctx.fillRect(x * P + 1, y * P, 2, 1);
        ctx.fillStyle = '#5c625e';
        ctx.fillRect(x * P, y * P + P - 1, P, 1);
      } else if (ter === T.Hills) {
        ctx.fillStyle = 'rgba(40,60,30,0.35)';
        ctx.fillRect(x * P, y * P + P - 1, P, 1);
      }
    }
  if (overviewCache.size > 8) overviewCache.clear();
  overviewCache.set(key, c);
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
 * stand that is growing back, and stumps where trees were felled. Pines in the cold north, palms in
 * the tropics.
 */
type TreeSet = { oak: HTMLCanvasElement; pine: HTMLCanvasElement; sap: [HTMLCanvasElement, HTMLCanvasElement]; seed: [HTMLCanvasElement, HTMLCanvasElement]; stump: HTMLCanvasElement };
const treeSprites = new Map<string, TreeSet>();

function treeSet(season: number, biome: number): TreeSet {
  const key = `${season}:${biome}`;
  let t = treeSprites.get(key);
  if (!t) {
    const sea = climateSeason(biome, season);
    const pal = TREE_PAL[sea];
    const tropical = biome === Biome.Tropical;
    const arid = biome === Biome.Arid;
    const dry = { l: '#b6c25e', L: '#879a42', d: '#5d7034', D: '#3a4824' };
    t = {
      oak: sprite(tropical ? 'palm' : 'oak', arid ? dry : pal.oak),
      pine: sprite(tropical ? 'palm' : 'pine', tropical ? pal.oak : pal.pine),
      sap: [sprite('sapling', pal.oak), sprite('sapling', pal.pine)],
      seed: [sprite('seedling', pal.oak), sprite('seedling', pal.pine)],
      stump: sprite('stump', sea === 3 ? { T: '#f4f1ec', t: '#dcd6cc' } : undefined),
    };
    treeSprites.set(key, t);
  }
  return t;
}

export function drawForest(ctx: CanvasRenderingContext2D, slots: TreeSlot[], frac: number, season: number, biome = 0) {
  const set = treeSet(season, biome);
  const n = slots.length;
  const grown = Math.floor(frac * n + 1e-6);
  const partial = frac * n - grown;
  for (const s of slots) {
    const cx = s.x + 5;
    const by = s.y + (s.pine ? 13 : 12);
    // The cold north grows only pines.
    const pine = s.pine || biome === Biome.Boreal;
    if (s.k < grown) ctx.drawImage(pine ? set.pine : set.oak, s.x, s.y + (biome === Biome.Tropical ? -3 : 0));
    else if (s.k === grown && partial > 0.15) {
      const sp = (partial > 0.55 ? set.sap : set.seed)[pine ? 1 : 0];
      ctx.drawImage(sp, cx - Math.floor(sp.width / 2), by - sp.height);
    } else if (frac < 0.999) ctx.drawImage(set.stump, cx - 2, by - set.stump.height);
  }
}

interface ForestChunk {
  c: HTMLCanvasElement;
  /** Forest and berry tiles in the chunk and a one-tile margin around it. */
  tiles: number[];
  stage: Int16Array;
}

/**
 * Forests and berry thickets, painted per chunk and season and touched up tile by tile as trees are
 * felled and regrow, so a whole forest costs a single draw per chunk per frame.
 */
export class ForestLayer {
  private chunks = new Map<string, ForestChunk>();
  private seed = -1;

  /** What a tile should show, as a small number that changes only when its picture does. */
  private stageOf(state: GameState, i: number, season: number, occupied: Uint8Array, sites: Uint8Array) {
    if (occupied[i] && !sites[i]) return 0;
    const m = landMax(state.seed);
    if (m.wood[i]) {
      const n = treeSlots(state.seed).get(i)!.length;
      const frac = state.land.wood[i] / m.wood[i];
      if (frac <= 0 && occupied[i]) return 0;
      const grown = Math.floor(frac * n + 1e-6);
      const partial = frac * n - grown;
      const part = partial > 0.55 ? 2 : partial > 0.15 ? 1 : 0;
      return 1 + grown * 6 + part * 2 + (frac < 0.999 ? 1 : 0);
    }
    if (occupied[i]) return 0;
    return season < 3 && state.land.life[i] > m.life[i] * 0.35 ? 2 : 1;
  }

  private drawTile(ctx: CanvasRenderingContext2D, state: GameState, i: number, season: number, stage: number) {
    if (!stage) return;
    const m = landMax(state.seed);
    const biome = getMap(state.seed).biome[i];
    if (m.wood[i]) {
      drawForest(ctx, treeSlots(state.seed).get(i)!, state.land.wood[i] / m.wood[i], season, biome);
      return;
    }
    const pal = TREE_PAL[climateSeason(biome, season)].oak;
    ctx.drawImage(sprite(stage === 2 ? 'berries' : 'bush', pal), tx(i) * TILE + 4, ty(i) * TILE + 8);
  }

  /** The forest of one chunk as it stands now. */
  canvas(state: GameState, season: number, cx: number, cy: number, occupied: Uint8Array, sites: Uint8Array): HTMLCanvasElement | null {
    if (state.seed !== this.seed) {
      this.seed = state.seed;
      this.chunks.clear();
    }
    const key = `${season}:${cx}:${cy}`;
    let L = this.chunks.get(key);
    if (!L) {
      const map = getMap(state.seed);
      const slots = treeSlots(state.seed);
      const tiles: number[] = [];
      for (let y = Math.max(0, cy * CHUNK - 1); y < Math.min(MAP_H, (cy + 1) * CHUNK + 1); y++)
        for (let x = Math.max(0, cx * CHUNK - 1); x < Math.min(MAP_W, (cx + 1) * CHUNK + 1); x++) {
          const i = idx(x, y);
          if (slots.has(i) || map.feature[i] === F.Berries) tiles.push(i);
        }
      if (!tiles.length) return null;
      L = { c: makeCanvas(CHUNK * TILE, CHUNK * TILE), tiles, stage: new Int16Array(tiles.length).fill(-1) };
      if (this.chunks.size > 96) this.chunks.delete(this.chunks.keys().next().value!);
      this.chunks.set(key, L);
    } else {
      this.chunks.delete(key);
      this.chunks.set(key, L);
    }
    const changed: number[] = [];
    const stageAt = new Map<number, number>();
    for (let k = 0; k < L.tiles.length; k++) {
      const i = L.tiles[k];
      const st = this.stageOf(state, i, season, occupied, sites);
      stageAt.set(i, st);
      if (st !== L.stage[k]) {
        L.stage[k] = st;
        changed.push(i);
      }
    }
    if (!changed.length) return L.c;
    const ctx = L.c.getContext('2d')!;
    ctx.save();
    ctx.translate(-cx * CHUNK * TILE, -cy * CHUNK * TILE);
    if (changed.length > 120) {
      ctx.clearRect(cx * CHUNK * TILE, cy * CHUNK * TILE, CHUNK * TILE, CHUNK * TILE);
      for (const i of L.tiles) this.drawTile(ctx, state, i, season, stageAt.get(i)!);
    } else {
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
            const st = stageAt.get(j);
            if (st) this.drawTile(ctx, state, j, season, st);
          }
        ctx.restore();
      }
    }
    ctx.restore();
    return L.c;
  }
}
