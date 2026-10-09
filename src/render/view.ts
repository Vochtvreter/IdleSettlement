import { BUILDING_DEFS, FEATURE_NAMES, MAP_H, MAP_W, TIERS } from '../game/data';
import { canPlace, derived } from '../game/derived';
import { fellLeft, hearthOf, landMax, sizeOf, siteStage, tilesOf } from '../game/land';
import { getMap, idx, inBounds, isWater, tx, ty } from '../game/map';
import { townTitle } from '../game/realm';
import { glimpsed } from '../game/scouting';
import { hash2 } from '../game/rng';
import { eraOf, seasonIndex } from '../game/state';
import type { Building, BuildingId, FxEvent, GameState } from '../game/types';
import { F } from '../game/types';
import { Actors, jobColor } from './actors';
import { makeCanvas, sprite } from './sprites';
import { CHUNK, climateSeason, ForestLayer, OVERVIEW_PX, overviewCanvas, terrainChunk, TILE, TREE_PAL } from './terrain';

/** Zoom levels: below 1 the world is shown from the overview map. */
export const ZOOMS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6];
/** Zoom level index (1-based) for a pixel scale. */
export const zoomFor = (scale: number) => ZOOMS.indexOf(scale) + 1;

const FARM_PAL = [
  { U: '#7a5230', '1': '#86cf53' },
  { U: '#6d4a2b', '1': '#3f8f35' },
  { U: '#7a5230', '1': '#e9c046' },
  { U: '#e3e8ec', '1': '#c9c1b5' },
];

export interface ViewCallbacks {
  onTileClick: (tile: number, button: number) => void;
  onHover: (tile: number | null) => void;
  onCancel: () => void;
}

export class MapView {
  readonly ctx: CanvasRenderingContext2D;
  cam = { x: 0, y: 0, zoom: 3 };
  placing: BuildingId | null = null;
  hoverTile: number | null = null;
  selectedTile: number | null = null;
  actors: Actors;
  private dpr = 1;
  private time = 0;
  private fog = makeCanvas(MAP_W, MAP_H);
  private fogKey = '';
  private placeKey = '';
  private placeValid = new Map<number, number>();
  private borderKey = '';
  private netKey = '';
  private forest = new ForestLayer();
  /** Per tile: 1 road, 2 village green, 3 bridge, 4 building, 5 trail. */
  private net = new Uint8Array(MAP_W * MAP_H);
  private border: [number, number, number, number][] = [];
  private lastSeason = -1;
  private seasonFade = 1;
  private prevSeason = 0;
  private syncStamp = 0;
  private syncTimer = 0;
  private birdTimer = 8;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean; button: number } | null = null;
  private pinch: { d: number; zoom: number } | null = null;
  private keys = new Set<string>();

  private mini: HTMLCanvasElement | null = null;
  private miniTimer = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private getState: () => GameState,
    private getSpeed: () => number,
    private cb: ViewCallbacks,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.actors = new Actors(getState);
    this.bindInput();
    this.bindMinimap();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
  }

  resetFor(state: GameState) {
    this.actors.reset();
    this.fogKey = '';
    this.placeKey = '';
    this.borderKey = '';
    this.netKey = '';
    this.lastSeason = -1;
    const h = state.buildings.find((b) => b.type === 'campfire')!;
    this.centerOn(h.x + 0.5, h.y + 0.5);
    this.syncTimer = 0;
  }

  centerOn(x: number, y: number) {
    this.cam.x = x * TILE;
    this.cam.y = y * TILE;
    this.clampCam();
  }

  get scale() {
    const z = ZOOMS[this.cam.zoom - 1] * this.dpr;
    return z >= 1 ? Math.max(1, Math.round(z)) : z;
  }

  /** Whether the full detail (chunks, sprites, people) is drawn, or only the overview map. */
  get detailed() {
    return ZOOMS[this.cam.zoom - 1] >= 1;
  }

  setZoom(z: number, ax?: number, ay?: number) {
    const nz = Math.max(1, Math.min(ZOOMS.length, z));
    if (nz === this.cam.zoom) return;
    // Keep the world point under the anchor stable.
    const before = ax !== undefined && ay !== undefined ? this.screenToWorld(ax, ay) : null;
    this.cam.zoom = nz;
    if (before) {
      const after = this.screenToWorld(ax!, ay!);
      this.cam.x += before[0] - after[0];
      this.cam.y += before[1] - after[1];
    }
    this.clampCam();
  }

  private resize() {
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.clampCam();
  }

  private clampCam() {
    const W = MAP_W * TILE;
    const H = MAP_H * TILE;
    const vw = this.canvas.width / this.scale;
    const vh = this.canvas.height / this.scale;
    const mx = Math.max(0, (vw - W) / 2) + Math.min(vw * 0.25, 12 * TILE);
    const my = Math.max(0, (vh - H) / 2) + Math.min(vh * 0.25, 12 * TILE);
    this.cam.x = Math.max(vw / 2 - mx, Math.min(W - vw / 2 + mx, this.cam.x));
    this.cam.y = Math.max(vh / 2 - my, Math.min(H - vh / 2 + my, this.cam.y));
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    const s = this.scale;
    const px = sx * this.dpr;
    const py = sy * this.dpr;
    return [(px - this.canvas.width / 2) / s + this.cam.x, (py - this.canvas.height / 2) / s + this.cam.y];
  }

  tileAt(sx: number, sy: number): number | null {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const x = Math.floor(wx / TILE);
    const y = Math.floor(wy / TILE);
    return inBounds(x, y) ? idx(x, y) : null;
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.cam.zoom };
        this.drag = null;
        return;
      }
      this.drag = { x: e.offsetX, y: e.offsetY, cx: this.cam.x, cy: this.cam.y, moved: false, button: e.button };
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const z = Math.round(this.pinch.zoom * (d / this.pinch.d));
        this.setZoom(z, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (this.drag) {
        const dx = e.offsetX - this.drag.x;
        const dy = e.offsetY - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) > 5) this.drag.moved = true;
        if (this.drag.moved) {
          const s = this.scale / this.dpr;
          this.cam.x = this.drag.cx - dx / s;
          this.cam.y = this.drag.cy - dy / s;
          this.clampCam();
          c.style.cursor = 'grabbing';
        }
      }
      const t = this.tileAt(e.offsetX, e.offsetY);
      if (t !== this.hoverTile) {
        this.hoverTile = t;
        this.cb.onHover(t);
      }
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        this.drag = null;
        return;
      }
      if (this.drag && !this.drag.moved) {
        const t = this.tileAt(e.offsetX, e.offsetY);
        if (this.drag.button === 2) this.cb.onCancel();
        else if (t !== null) this.cb.onTileClick(t, this.drag.button);
      }
      this.drag = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hoverTile = null;
        this.cb.onHover(null);
      }
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.setZoom(this.cam.zoom + (e.deltaY < 0 ? 1 : -1), e.offsetX, e.offsetY);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === '+' || e.key === '=') this.setZoom(this.cam.zoom + 1);
      if (e.key === '-' || e.key === '_') this.setZoom(this.cam.zoom - 1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** The part of the world the minimap shows: the known world with a margin, in tiles. */
  private miniWin = { x: 0, y: 0, w: MAP_W, h: MAP_H };
  private miniKey = '';

  /** Frame the known world (the world is far too large to show whole), keeping the minimap's shape. */
  private updateMiniWindow(state: GameState) {
    const key = `${state.seed}:${state.stats.tilesExplored}`;
    if (key === this.miniKey) return;
    this.miniKey = key;
    let x0 = MAP_W;
    let y0 = MAP_H;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      for (let x = 0; x < MAP_W; x++)
        if (state.explored[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
    }
    if (x1 < x0) return;
    const pad = 12;
    let w = Math.max(80, x1 - x0 + 1 + pad * 2);
    let h = Math.max(60, y1 - y0 + 1 + pad * 2);
    // Keep the minimap's 4:3 shape.
    if (w / h > MAP_W / MAP_H) h = w * (MAP_H / MAP_W);
    else w = h * (MAP_W / MAP_H);
    w = Math.min(MAP_W, w);
    h = Math.min(MAP_H, h);
    const cx = (x0 + x1 + 1) / 2;
    const cy = (y0 + y1 + 1) / 2;
    this.miniWin = { x: Math.max(0, Math.min(MAP_W - w, cx - w / 2)), y: Math.max(0, Math.min(MAP_H - h, cy - h / 2)), w, h };
  }

  /** The minimap: the known world, the settlements, and where the camera looks. Click or drag to move. */
  private bindMinimap() {
    const m = document.getElementById('minimap') as HTMLCanvasElement | null;
    if (!m) return;
    this.mini = m;
    m.width = 400;
    m.height = 300;
    let down = false;
    const go = (e: PointerEvent) => {
      const r = m.getBoundingClientRect();
      const w = this.miniWin;
      this.centerOn(w.x + ((e.clientX - r.left) / r.width) * w.w, w.y + ((e.clientY - r.top) / r.height) * w.h);
      this.miniTimer = 0;
    };
    m.addEventListener('pointerdown', (e) => {
      down = true;
      m.setPointerCapture(e.pointerId);
      go(e);
    });
    m.addEventListener('pointermove', (e) => down && go(e));
    m.addEventListener('pointerup', () => (down = false));
    m.addEventListener('pointercancel', () => (down = false));
  }

  private drawMinimap(state: GameState, dt: number) {
    const m = this.mini;
    if (!m || m.classList.contains('hidden')) return;
    this.miniTimer -= dt;
    if (this.miniTimer > 0) return;
    this.miniTimer = 0.3;
    this.updateMiniWindow(state);
    const win = this.miniWin;
    const S = m.width / win.w;
    const ctx = m.getContext('2d')!;
    ctx.fillStyle = '#0e0b16';
    ctx.fillRect(0, 0, m.width, m.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(overviewCanvas(state.seed, seasonIndex(state.day)), win.x * OVERVIEW_PX, win.y * OVERVIEW_PX, win.w * OVERVIEW_PX, win.h * OVERVIEW_PX, 0, 0, m.width, m.height);
    this.updateFog(state);
    ctx.drawImage(this.fog, win.x, win.y, win.w, win.h, 0, 0, m.width, m.height);
    const X = (x: number) => (x - win.x) * S;
    const Y = (y: number) => (y - win.y) * S;
    const dot = Math.max(1, S);
    ctx.fillStyle = '#d9b46c';
    for (const i of state.roads) ctx.fillRect(X(tx(i)), Y(ty(i)), dot, dot);
    for (const t of state.towns) {
      const r = (1 + t.tier) * Math.max(1, S * 0.6);
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(X(t.x + 0.5) - r - 1, Y(t.y + 0.5) - r - 1, 2 * r + 2, 2 * r + 2);
      ctx.fillStyle = t === state.towns[0] ? '#ffd25e' : '#f6f2ea';
      ctx.fillRect(X(t.x + 0.5) - r, Y(t.y + 0.5) - r, 2 * r, 2 * r);
    }
    for (const e of state.expeditions) {
      const i = e.path[e.at];
      ctx.fillStyle = e.kind === 'scout' ? '#3fb6a8' : '#ff7a4a';
      ctx.fillRect(X(tx(i) + 0.5) - 2, Y(ty(i) + 0.5) - 2, 4, 4);
    }
    const s = this.scale;
    const vw = this.canvas.width / s / TILE;
    const vh = this.canvas.height / s / TILE;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(X(this.cam.x / TILE - vw / 2)) + 0.5, Math.round(Y(this.cam.y / TILE - vh / 2)) + 0.5, Math.round(vw * S), Math.round(vh * S));
  }

  handleFx(fx: FxEvent[]) {
    const state = this.getState();
    const a = this.actors;
    for (const f of fx) {
      switch (f.kind) {
        case 'birth': {
          const homes = state.buildings.filter((b) => b.done && (b.type === 'hut' || b.type === 'house' || b.type === 'campfire'));
          const h = homes[Math.floor(Math.random() * homes.length)];
          if (h) a.emit({ kind: 'heart', x: h.x + 0.5, y: h.y + 0.1, vx: 0, vy: -0.35, life: 2.2, size: 1 });
          break;
        }
        case 'death': {
          const w = a.walkers.get(f.settler);
          if (w) a.emit({ kind: 'spirit', x: w.x, y: w.y - 0.4, vx: 0, vy: -0.3, life: 2.5, size: 1 });
          break;
        }
        case 'built': {
          const b = state.buildings.find((x) => x.id === f.building);
          if (!b) break;
          const [w, hh] = sizeOf(b.type);
          for (let k = 0; k < 14 * w; k++) a.emit({ kind: 'dust', x: b.x + w / 2 + (Math.random() - 0.5) * 0.9 * w, y: b.y + hh - 0.1, vx: (Math.random() - 0.5) * 1.2, vy: -Math.random() * 0.6, life: 0.6 + Math.random() * 0.5, size: 1 + Math.random() * 1.5 });
          for (let k = 0; k < 6; k++) a.emit({ kind: 'star', x: b.x + w / 2, y: b.y + 0.3, vx: (Math.random() - 0.5) * 2, vy: -1 - Math.random(), life: 0.9, size: 1 });
          break;
        }
        case 'discover': {
          const x = tx(f.tile) + 0.5;
          const y = ty(f.tile) + 0.5;
          for (let k = 0; k < 12; k++) {
            const ang = (k / 12) * Math.PI * 2;
            a.emit({ kind: 'star', x, y, vx: Math.cos(ang) * 1.5, vy: Math.sin(ang) * 1.5, life: 1, size: 1 });
          }
          const name = FEATURE_NAMES[getMap(state.seed).feature[f.tile]];
          if (name) a.emit({ kind: 'text', x, y: y - 0.6, vx: 0, vy: -0.25, life: 3, size: 1, text: name, color: '#ffe08a' });
          break;
        }
        case 'found':
        case 'tier': {
          const t = state.towns.find((x) => x.id === f.town);
          if (!t) break;
          a.emit({ kind: 'beam', x: t.x + 0.5, y: t.y + 0.6, vx: 0, vy: 0, life: 3, size: 1 });
          a.emit({ kind: 'text', x: t.x + 0.5, y: t.y - 1, vx: 0, vy: -0.2, life: 4, size: 1, text: f.kind === 'found' ? `${t.name} founded` : `${t.name}: ${TIERS[f.tier].name}`, color: '#ffe08a' });
          for (let k = 0; k < 20; k++) {
            const ang = Math.random() * Math.PI * 2;
            a.emit({ kind: 'star', x: t.x + 0.5, y: t.y + 0.3, vx: Math.cos(ang) * 2.5, vy: Math.sin(ang) * 2.5 - 1, life: 1.2, size: 1 });
          }
          break;
        }
        case 'era': {
          const h = hearthOf(state);
          a.emit({ kind: 'beam', x: h.x + 0.5, y: h.y + 0.6, vx: 0, vy: 0, life: 3, size: 1 });
          for (let k = 0; k < 30; k++) {
            const ang = Math.random() * Math.PI * 2;
            a.emit({ kind: 'star', x: h.x + 0.5, y: h.y + 0.3, vx: Math.cos(ang) * 3, vy: Math.sin(ang) * 3 - 1, life: 1.4, size: 1 });
          }
          break;
        }
      }
    }
  }

  frame(dt: number) {
    const state = this.getState();
    this.time += dt;
    // Keyboard panning
    const pan = (420 * dt) / (this.scale / this.dpr);
    if (this.keys.has('arrowleft') || this.keys.has('a')) this.cam.x -= pan;
    if (this.keys.has('arrowright') || this.keys.has('d')) this.cam.x += pan;
    if (this.keys.has('arrowup') || this.keys.has('w')) this.cam.y -= pan;
    if (this.keys.has('arrowdown') || this.keys.has('s')) this.cam.y += pan;
    if (this.keys.size) this.clampCam();

    this.syncTimer -= dt;
    if (this.syncTimer <= 0) {
      this.syncTimer = 0.25;
      this.actors.focus = [this.cam.x / TILE, this.cam.y / TILE];
      this.actors.syncSettlers(state, ++this.syncStamp);
      this.actors.syncAnimals(state);
    }
    const speed = this.getSpeed();
    this.actors.update(speed === 0 ? 0 : dt, Math.max(1, speed));
    this.emitAmbient(state, dt, speed);
    this.render(state);
    this.drawMinimap(state, dt);
  }

  private emitAmbient(state: GameState, dt: number, speed: number) {
    const a = this.actors;
    if (speed === 0) return;
    const season = seasonIndex(state.day);
    const vx0 = this.cam.x / TILE - this.canvas.width / this.scale / TILE / 2 - 2;
    const vx1 = this.cam.x / TILE + this.canvas.width / this.scale / TILE / 2 + 2;
    const vy0 = this.cam.y / TILE - this.canvas.height / this.scale / TILE / 2 - 2;
    const vy1 = this.cam.y / TILE + this.canvas.height / this.scale / TILE / 2 + 3;
    for (const b of state.buildings) {
      if (!b.done || b.x < vx0 || b.x > vx1 || b.y < vy0 || b.y > vy1) continue;
      if (b.type === 'campfire' && Math.random() < dt * 4) a.emit({ kind: 'smoke', x: b.x + 0.5 + (Math.random() - 0.5) * 0.15, y: b.y + 0.35, vx: 0.05, vy: -0.45, life: 2.2, size: 1.2 });
      if (b.type === 'campfire' && Math.random() < dt * 6) a.emit({ kind: 'spark', x: b.x + 0.5 + (Math.random() - 0.5) * 0.2, y: b.y + 0.5, vx: (Math.random() - 0.5) * 0.4, vy: -0.8 - Math.random(), life: 0.6, size: 1 });
      if (b.type === 'smithy' && Math.random() < dt * 2.5) a.emit({ kind: 'smoke', x: b.x + 0.75, y: b.y - 0.05, vx: 0.08, vy: -0.4, life: 2.5, size: 1.2 });
      if ((b.type === 'house' || b.type === 'manor' || (b.type === 'hut' && eraOf(state) >= 2)) && season === 3 && Math.random() < dt * 0.8) a.emit({ kind: 'smoke', x: b.x + 0.72, y: b.y + 0.05, vx: 0.06, vy: -0.35, life: 2, size: 1 });
    }
    // Weather in the visible area.
    const vw = this.canvas.width / this.scale / TILE;
    const vh = this.canvas.height / this.scale / TILE;
    const x0 = this.cam.x / TILE - vw / 2;
    const y0 = this.cam.y / TILE - vh / 2;
    const area = vw * vh;
    if (season === 3 && Math.random() < dt * area * 0.06) a.emit({ kind: 'snow', x: x0 + Math.random() * vw, y: y0 - 0.5 + Math.random() * vh * 0.3, vx: 0.15, vy: 0.5 + Math.random() * 0.3, life: 3 + Math.random() * 3, size: 1 });
    if (season === 2 && Math.random() < dt * area * 0.012) a.emit({ kind: 'leaf', x: x0 + Math.random() * vw, y: y0 + Math.random() * vh * 0.5, vx: 0.2, vy: 0.35, life: 4, size: 1, color: Math.random() < 0.5 ? '#e0703a' : '#eaa53a' });
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 12 + Math.random() * 20;
      if (season !== 3) a.spawnBirds(x0 - 2, x0 + vw + 2, y0 + Math.random() * vh);
    }
  }

  // ------------------------------------------------------------ rendering

  private updateFog(state: GameState) {
    // Land scouting parties have seen but not yet brought home shows through a thinner fog.
    const seen = glimpsed(state);
    const key = `${state.seed}:${state.stats.tilesExplored}:${seen.length}`;
    if (key === this.fogKey) return;
    this.fogKey = key;
    const ctx = this.fog.getContext('2d')!;
    const img = ctx.createImageData(MAP_W, MAP_H);
    for (let i = 0; i < MAP_W * MAP_H; i++) {
      img.data[i * 4] = 14;
      img.data[i * 4 + 1] = 11;
      img.data[i * 4 + 2] = 22;
      img.data[i * 4 + 3] = state.explored[i] ? 0 : 255;
    }
    for (const i of seen) img.data[i * 4 + 3] = 150;
    ctx.putImageData(img, 0, 0);
  }

  private updatePlacement(state: GameState) {
    if (!this.placing) return;
    const d = derived(state);
    const key = `${this.placing}:${state.buildings.length}:${d.sites.length}:${state.stats.tilesExplored}:${state.nextBuildingId}:${state.landEpoch}:${state.roads.length}:${state.trails.length}:${state.towns.map((t) => t.tier).join()}:${eraOf(state)}`;
    if (key === this.placeKey) return;
    this.placeKey = key;
    this.placeValid.clear();
    for (const i of d.terrTiles) {
      const c = canPlace(state, this.placing, i, d);
      if (c.ok) this.placeValid.set(i, c.mult);
    }
  }

  private updateBorder(state: GameState) {
    const d = derived(state);
    const key = `${state.buildings.length}:${state.buildings.filter((b) => b.done).length}:${state.towns.map((t) => t.tier).join()}:${eraOf(state)}`;
    if (key === this.borderKey) return;
    this.borderKey = key;
    const t = d.territory;
    const segs: [number, number, number, number][] = [];
    for (let y = 0; y < MAP_H; y++)
      for (let x = 0; x < MAP_W; x++) {
        if (!t[idx(x, y)]) continue;
        const X = x * TILE;
        const Y = y * TILE;
        if (y === 0 || !t[idx(x, y - 1)]) segs.push([X, Y, X + TILE, Y]);
        if (y === MAP_H - 1 || !t[idx(x, y + 1)]) segs.push([X, Y + TILE, X + TILE, Y + TILE]);
        if (x === 0 || !t[idx(x - 1, y)]) segs.push([X, Y, X, Y + TILE]);
        if (x === MAP_W - 1 || !t[idx(x + 1, y)]) segs.push([X + TILE, Y, X + TILE, Y + TILE]);
      }
    this.border = segs;
  }

  private render(state: GameState) {
    const ctx = this.ctx;
    const s = this.scale;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const ox = Math.round(W / 2 - this.cam.x * s);
    const oy = Math.round(H / 2 - this.cam.y * s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1f4677';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.imageSmoothingEnabled = false;

    // View bounds in tiles
    const vx0 = Math.floor(-ox / s / TILE) - 2;
    const vy0 = Math.floor(-oy / s / TILE) - 2;
    const vx1 = Math.ceil((W - ox) / s / TILE) + 2;
    const vy1 = Math.ceil((H - oy) / s / TILE) + 3;
    const visible = (x: number, y: number) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;

    // Seasons cross-fade.
    const season = seasonIndex(state.day);
    if (season !== this.lastSeason) {
      this.prevSeason = this.lastSeason < 0 ? season : this.lastSeason;
      this.seasonFade = this.lastSeason < 0 ? 1 : 0;
      this.lastSeason = season;
    }
    this.seasonFade = Math.min(1, this.seasonFade + 0.02);
    const map = getMap(state.seed);
    const d = derived(state);

    if (!this.detailed) {
      // Far out: the overview map, the network and the settlements.
      this.drawOverview(state, season);
    } else {
      // Ground, chunk by chunk as it comes into view (a few new chunks a frame; the overview fills in meanwhile).
      const budget = { n: 3 };
      const cx0 = Math.max(0, Math.floor(vx0 / CHUNK));
      const cy0 = Math.max(0, Math.floor(vy0 / CHUNK));
      const cx1 = Math.min(Math.ceil(MAP_W / CHUNK) - 1, Math.floor(vx1 / CHUNK));
      const cy1 = Math.min(Math.ceil(MAP_H / CHUNK) - 1, Math.floor(vy1 / CHUNK));
      const over = overviewCanvas(state.seed, season);
      const drawGroundChunks = (sea: number) => {
        for (let cy = cy0; cy <= cy1; cy++)
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = terrainChunk(state, sea, cx, cy, budget);
            const X = cx * CHUNK * TILE;
            const Y = cy * CHUNK * TILE;
            if (c) ctx.drawImage(c, X, Y);
            else ctx.drawImage(over, cx * CHUNK * OVERVIEW_PX, cy * CHUNK * OVERVIEW_PX, CHUNK * OVERVIEW_PX, CHUNK * OVERVIEW_PX, X, Y, CHUNK * TILE, CHUNK * TILE);
          }
      };
      if (this.seasonFade < 1) {
        drawGroundChunks(this.prevSeason);
        ctx.globalAlpha = this.seasonFade;
      }
      drawGroundChunks(season);
      ctx.globalAlpha = 1;

      // Water sparkles
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let y = Math.max(0, vy0); y < Math.min(MAP_H, vy1); y++)
        for (let x = Math.max(0, vx0); x < Math.min(MAP_W, vx1); x++) {
          const i = idx(x, y);
          if (!isWater(map.terrain[i])) continue;
          const h = hash2(x, y, 11);
          const t = (this.time * 0.6 + h * 10) % 4;
          if (t < 0.5) {
            const px = x * TILE + Math.floor(h * 12) + 2;
            const py = y * TILE + Math.floor(hash2(x, y, 12) * 12) + 2;
            ctx.fillRect(px, py, t < 0.25 ? 2 : 1, 1);
          }
        }

      // Roads, trails, the village greens, bridges and worked hillsides lie on the ground under everything else.
      this.drawGround(state, vx0, vy0, vx1, vy1);
      // Then the woods as they stand today.
      const drawForests = (sea: number) => {
        for (let cy = cy0; cy <= cy1; cy++)
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = this.forest.canvas(state, sea, cx, cy, d.occupied, d.siteMask);
            if (c) ctx.drawImage(c, cx * CHUNK * TILE, cy * CHUNK * TILE);
          }
      };
      if (this.seasonFade < 1) {
        drawForests(this.prevSeason);
        ctx.globalAlpha = this.seasonFade;
      }
      drawForests(season);
      ctx.globalAlpha = 1;
    }

    // Territory border
    this.updateBorder(state);
    ctx.save();
    ctx.strokeStyle = this.placing ? 'rgba(255,214,120,0.9)' : 'rgba(255,214,120,0.35)';
    ctx.lineWidth = this.detailed ? 1 : 1 / s;
    ctx.setLineDash(this.detailed ? [3, 2] : []);
    ctx.lineDashOffset = -this.time * 4;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of this.border) {
      if (x2 / TILE < vx0 || x1 / TILE > vx1 || y2 / TILE < vy0 || y1 / TILE > vy1) continue;
      ctx.moveTo(x1 + 0.5, y1 + 0.5);
      ctx.lineTo(x2 + 0.5, y2 + 0.5);
    }
    ctx.stroke();
    ctx.restore();

    // Placement overlay: every tile where the building's top-left corner could go.
    if (this.placing && this.detailed) {
      this.updatePlacement(state);
      const pulse = 0.18 + Math.sin(this.time * 4) * 0.06;
      for (const [i, mult] of this.placeValid) {
        const x = tx(i);
        const y = ty(i);
        if (!visible(x, y)) continue;
        ctx.fillStyle = mult > 1.001 ? `rgba(255,220,90,${pulse + 0.08})` : `rgba(140,255,140,${pulse})`;
        ctx.fillRect(x * TILE + 1, y * TILE + 1, TILE - 2, TILE - 2);
      }
    }

    if (this.detailed) {
      // Dynamic layer sorted by y
      type Item = { y: number; draw: () => void };
      const items: Item[] = [];
      const claimed = new Set(state.claimed);
      for (let y = Math.max(0, vy0); y < Math.min(MAP_H, vy1); y++)
        for (let x = Math.max(0, vx0); x < Math.min(MAP_W, vx1); x++) {
          const i = idx(x, y);
          const f = map.feature[i];
          if (!f || f === F.Berries || f === F.Game || f === F.Fish) continue;
          if (!state.explored[i]) continue;
          if ((f === F.Tribe || f === F.Cache) && claimed.has(i)) continue;
          if (f === F.Ore && (state.land.ore[i] <= 0 || d.buildingAt[i])) continue;
          items.push({ y: y + 0.9, draw: () => this.drawFeature(f, x, y) });
        }
      for (const b of state.buildings) {
        const [w, h] = sizeOf(b.type);
        if (!visible(b.x, b.y) && !visible(b.x + w - 1, b.y + h - 1)) continue;
        if (b.type === 'bridge') continue;
        items.push({ y: b.y + h - 0.05, draw: () => this.drawBuilding(state, b) });
      }
      for (const w of this.actors.walkers.values()) {
        if (!visible(Math.floor(w.x), Math.floor(w.y))) continue;
        items.push({ y: w.y, draw: () => this.drawWalker(w, state) });
      }
      for (const a of this.actors.animals) {
        if (a.kind === 'bird') continue;
        if (!visible(Math.floor(a.x), Math.floor(a.y))) continue;
        if (!state.explored[idx(Math.min(MAP_W - 1, Math.max(0, Math.floor(a.x))), Math.min(MAP_H - 1, Math.max(0, Math.floor(a.y))))]) continue;
        items.push({ y: a.y, draw: () => this.drawAnimal(a.kind, a.x, a.y, a.phase, a.facing) });
      }
      for (const it of this.travellers(state)) if (visible(Math.floor(it.x), Math.floor(it.y))) items.push({ y: it.y, draw: it.draw });
      items.sort((a, b) => a.y - b.y);
      for (const it of items) it.draw();

      // Particles
      this.drawParticles();
    } else {
      for (const it of this.travellers(state)) it.draw();
    }

    // Fog
    this.updateFog(state);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fog, 0, 0, MAP_W * TILE, MAP_H * TILE);
    ctx.imageSmoothingEnabled = false;
    // Scouting parties out in the unknown are drawn above the fog, so you can follow them.
    for (const it of this.travellers(state, true).sort((a, b) => a.y - b.y)) it.draw();

    // Birds fly above the fog
    if (this.detailed) for (const a of this.actors.animals) if (a.kind === 'bird') this.drawAnimal('bird', a.x, a.y, a.phase, a.facing);

    // Exploration flag
    if (state.exploreTarget !== null) {
      const x = tx(state.exploreTarget) * TILE + 6;
      const y = ty(state.exploreTarget) * TILE + 2;
      const wave = Math.round(Math.sin(this.time * 6));
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(x, y, 1, 13);
      ctx.fillStyle = '#ffd25e';
      ctx.fillRect(x + 1, y, 6, 4 + wave);
      ctx.fillStyle = '#e0703a';
      ctx.fillRect(x + 1, y + 2, 6, 1);
      ctx.strokeStyle = `rgba(255,210,94,${0.4 + 0.3 * Math.sin(this.time * 3)})`;
      ctx.strokeRect(x - 5.5, y + 9.5, 12, 6);
    }

    // Candidate sites while choosing where pioneers go.
    if (this.siteChoices.length) {
      for (const [k, c] of this.siteChoices.entries()) {
        const x = tx(c.tile) * TILE;
        const y = ty(c.tile) * TILE;
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 4 + k);
        ctx.strokeStyle = k === 0 ? `rgba(255,224,138,${0.6 + pulse * 0.4})` : `rgba(157,255,157,${0.4 + pulse * 0.4})`;
        ctx.lineWidth = Math.max(1, 1.5 / s);
        ctx.strokeRect(x - TILE * 2 + 0.5, y - TILE * 2 + 0.5, TILE * 5 - 1, TILE * 5 - 1);
        if (k === this.siteHover) {
          ctx.strokeStyle = 'rgba(255,224,138,0.8)';
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          c.path.forEach((p, n) => (n ? ctx.lineTo(tx(p) * TILE + 8, ty(p) * TILE + 8) : ctx.moveTo(tx(p) * TILE + 8, ty(p) * TILE + 8)));
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Hover / selection / ghost
    const outline = (x: number, y: number, w: number, h: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, 1 / s);
      ctx.strokeRect(x * TILE + 0.5, y * TILE + 0.5, w * TILE - 1, h * TILE - 1);
    };
    const footprintOf = (t: number) => {
      const b = state.buildings.find((bb) => bb.id === d.buildingAt[t]);
      if (b) {
        const [w, h] = sizeOf(b.type);
        return [b.x, b.y, w, h] as const;
      }
      return [tx(t), ty(t), 1, 1] as const;
    };
    if (this.selectedTile !== null) outline(...footprintOf(this.selectedTile), '#ffd25e');
    if (this.hoverTile !== null && this.detailed) {
      if (this.placing) {
        const ok = this.placeValid.has(this.hoverTile);
        const x = tx(this.hoverTile);
        const y = ty(this.hoverTile);
        const [w, h] = sizeOf(this.placing);
        ctx.globalAlpha = 0.75;
        this.drawBuildingSprite(state, this.placing, x, y, 1);
        ctx.globalAlpha = 1;
        outline(x, y, w, h, ok ? '#9dff9d' : '#ff6b6b');
        const mult = this.placeValid.get(this.hoverTile);
        if (mult !== undefined && mult > 1.001) {
          this.pixelText(`+${Math.round((mult - 1) * 100)}%`, x * TILE + (w * TILE) / 2, y * TILE - 6, '#ffe08a');
        } else if (!ok) {
          const r = canPlace(state, this.placing, this.hoverTile);
          if (!r.ok) this.pixelText(r.reason, x * TILE + (w * TILE) / 2, y * TILE - 6, '#ff9b9b');
        }
      } else {
        outline(...footprintOf(this.hoverTile), 'rgba(255,255,255,0.55)');
      }
    }

    // Settlement names, in screen space so they read at every zoom.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawLabels(state, s, ox, oy);
  }

  /** Candidate sites for pioneers, shown while the player picks one (set by the UI). */
  siteChoices: { tile: number; path: number[] }[] = [];
  siteHover = -1;

  /** The far view: the overview map, roads and trails as lines, and every settlement as a marker. */
  private drawOverview(state: GameState, season: number) {
    const ctx = this.ctx;
    const over = overviewCanvas(state.seed, season);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(over, 0, 0, MAP_W * TILE, MAP_H * TILE);
    ctx.fillStyle = 'rgba(184,147,95,0.95)';
    for (const i of state.roads) ctx.fillRect(tx(i) * TILE + 4, ty(i) * TILE + 4, 8, 8);
    ctx.fillStyle = 'rgba(150,110,64,0.85)';
    for (const i of state.trails) ctx.fillRect(tx(i) * TILE + 5, ty(i) * TILE + 5, 6, 6);
    for (const b of state.buildings) {
      if (b.type === 'campfire') continue;
      const [w, h] = sizeOf(b.type);
      ctx.fillStyle = b.done ? (b.type === 'farm' ? '#d9b84a' : b.type === 'pasture' ? '#9bd06a' : '#8a5a3a') : 'rgba(255,214,120,0.8)';
      ctx.fillRect(b.x * TILE + 2, b.y * TILE + 2, w * TILE - 4, h * TILE - 4);
    }
    for (const t of state.towns) {
      const r = (2 + t.tier) * TILE * 0.5;
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(t.x * TILE + 8 - r / 2 - 4, t.y * TILE + 8 - r / 2 - 4, r + 8, r + 8);
      ctx.fillStyle = t === state.towns[0] ? '#ffd25e' : '#f2efe6';
      ctx.fillRect(t.x * TILE + 8 - r / 2, t.y * TILE + 8 - r / 2, r, r);
    }
  }

  /** Pioneers on the road, galleys at sea and the caravans and ships of the trade routes. */
  private travellers(state: GameState, scouts = false): { x: number; y: number; draw: () => void }[] {
    const out: { x: number; y: number; draw: () => void }[] = [];
    const map = getMap(state.seed);
    const at = (path: number[], pos: number): [number, number, number] => {
      const k = Math.max(0, Math.min(path.length - 1, Math.floor(pos)));
      const n = Math.min(path.length - 1, k + 1);
      const f = Math.max(0, Math.min(1, pos - k));
      const x = tx(path[k]) + (tx(path[n]) - tx(path[k])) * f + 0.5;
      const y = ty(path[k]) + (ty(path[n]) - ty(path[k])) * f + 0.6;
      return [x, y, tx(path[n]) - tx(path[k])];
    };
    for (const e of state.expeditions) {
      if (!e.path.length || (e.kind === 'scout') !== scouts) continue;
      if (e.kind === 'scout') {
        const camped = (e.camp ?? 0) > 0;
        const [x, y, dir] = at(e.path, e.at + (camped ? 0 : Math.min(0.95, e.step / 0.5)));
        out.push({ x, y, draw: () => (camped ? this.drawCamp(x, y, e.people.length) : this.drawParty(x, y, e.people.length, dir, true)) });
        continue;
      }
      const [x, y, dir] = at(e.path, e.at + Math.min(0.95, e.step));
      const sea = map.ocean[e.path[Math.min(e.path.length - 1, e.at + 1)]] === 1 || map.ocean[e.path[e.at]] === 1;
      out.push({ x, y, draw: () => (sea ? this.drawShip(x, y, dir) : this.drawParty(x, y, e.people.length, dir)) });
    }
    for (const r of scouts ? [] : state.routes) {
      if (r.path.length < 2) continue;
      const L = r.path.length - 1;
      const speed = r.kind === 'sea' ? 2.2 : 0.9;
      const raw = (this.time * speed + r.id * 7.3) % (2 * L);
      const pos = raw > L ? 2 * L - raw : raw;
      const [x, y, dir0] = at(r.path, pos);
      const dir = raw > L ? -dir0 : dir0;
      out.push({ x, y, draw: () => (r.kind === 'sea' ? this.drawShip(x, y, dir) : this.drawCart(x, y, dir)) });
    }
    return out;
  }

  private flipDraw(spr: HTMLCanvasElement, px: number, py: number, facing: number) {
    const ctx = this.ctx;
    if (facing < 0) {
      ctx.save();
      ctx.translate(px, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(spr, -Math.floor(spr.width / 2), py - spr.height);
      ctx.restore();
    } else ctx.drawImage(spr, px - Math.floor(spr.width / 2), py - spr.height);
  }

  private drawShip(x: number, y: number, dir: number) {
    const ctx = this.ctx;
    const px = Math.round(x * TILE);
    const py = Math.round(y * TILE) + 4;
    const spr = sprite(Math.floor(this.time * 3) % 2 ? 'galley0' : 'galley1');
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(px - 12 - (dir < 0 ? -20 : 0), py - 2, 6, 1);
    this.flipDraw(spr, px, py, dir < 0 ? -1 : 1);
  }

  private drawCart(x: number, y: number, dir: number) {
    const ctx = this.ctx;
    const px = Math.round(x * TILE);
    const py = Math.round(y * TILE);
    ctx.fillStyle = 'rgba(10,8,20,0.22)';
    ctx.fillRect(px - 7, py - 1, 14, 2);
    this.flipDraw(sprite('cart'), px, py, dir < 0 ? -1 : 1);
  }

  /** A scouting party in camp for the night: a tent and a small fire. */
  private drawCamp(x: number, y: number, n: number) {
    const ctx = this.ctx;
    const px = Math.round(x * TILE);
    const py = Math.round(y * TILE);
    const tents = sprite('tents');
    ctx.drawImage(tents, 0, 0, n > 1 ? tents.width : 8, tents.height, px - 8, py - tents.height, n > 1 ? tents.width : 8, tents.height);
    const flicker = Math.floor(this.time * 8) % 3;
    ctx.fillStyle = '#5d3b2a';
    ctx.fillRect(px + 7, py - 1, 4, 1);
    ctx.fillStyle = flicker ? '#ffb347' : '#ff7a4a';
    ctx.fillRect(px + 8, py - 3 - (flicker === 2 ? 1 : 0), 2, 2);
    ctx.fillStyle = '#ffe08a';
    ctx.fillRect(px + 8, py - 2, 1, 1);
  }

  /** A party on the road: a few walkers, pioneers behind a standard. */
  private drawParty(x: number, y: number, n: number, dir: number, scouts = false) {
    const ctx = this.ctx;
    const px = Math.round(x * TILE);
    const py = Math.round(y * TILE);
    const step = Math.floor(this.time * 6) % 2;
    const shirts = ['#3fb6a8', '#a8743c', '#c0533a', '#7bc950', '#8b6cd9'];
    for (let k = Math.min(n, 4) - 1; k >= 0; k--) {
      const sx = px - dir * k * 4 + (k % 2 ? 1 : 0);
      const sy = py + (k % 2) * 2;
      ctx.fillStyle = 'rgba(10,8,20,0.25)';
      ctx.fillRect(sx - 3, sy - 1, 6, 2);
      this.flipDraw(sprite(step ? 'person1' : 'person2', { S: scouts ? '#3fb6a8' : shirts[k % shirts.length], A: '#5d3b2a', U: '#4b3b5a' }), sx, sy, dir < 0 ? -1 : 1);
    }
    if (!scouts) ctx.drawImage(sprite('flag'), px + (dir < 0 ? -9 : 3), py - 16);
  }

  private drawLabels(state: GameState, s: number, ox: number, oy: number) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of state.towns) {
      const X = Math.round((t.x * TILE + 8) * s + ox);
      const Y = Math.round((t.y * TILE - (this.detailed ? 26 : 4)) * s + oy - (this.detailed ? 0 : 14 * dpr));
      if (X < -100 || Y < -40 || X > this.canvas.width + 100 || Y > this.canvas.height + 40) continue;
      const name = t.name;
      const sub = townTitle(state, t);
      ctx.font = `${Math.round(11 * dpr)}px "Pixelify Sans", monospace`;
      const w1 = ctx.measureText(name).width;
      ctx.font = `${Math.round(8 * dpr)}px Silkscreen, monospace`;
      const w2 = ctx.measureText(sub).width;
      const w = Math.max(w1, w2) + 10 * dpr;
      ctx.fillStyle = 'rgba(14,11,22,0.78)';
      ctx.fillRect(X - w / 2, Y - 11 * dpr, w, 22 * dpr);
      ctx.fillStyle = t === state.towns[0] ? '#ffd25e' : '#f6f2ea';
      ctx.font = `${Math.round(11 * dpr)}px "Pixelify Sans", monospace`;
      ctx.fillText(name, X, Y - 4 * dpr);
      ctx.fillStyle = '#c9b98f';
      ctx.font = `${Math.round(8 * dpr)}px Silkscreen, monospace`;
      ctx.fillText(sub, X, Y + 6 * dpr);
    }
    ctx.restore();
  }

  /** Which tiles carry roads, trails, the greens, bridges and buildings (what a road may join up with). */
  private updateNet(state: GameState) {
    const key = `${state.roads.length}:${state.trails.length}:${state.buildings.length}:${state.nextBuildingId}`;
    if (key === this.netKey) return;
    this.netKey = key;
    const net = this.net;
    net.fill(0);
    const map = getMap(state.seed);
    for (const i of state.trails) net[i] = 5;
    for (const i of state.roads) net[i] = 1;
    for (const h of state.buildings) {
      if (h.type !== 'campfire') continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!inBounds(h.x + dx, h.y + dy)) continue;
          const i = idx(h.x + dx, h.y + dy);
          const t = map.terrain[i];
          if (!isWater(t) && t !== 8 && t !== 9) net[i] = 2;
        }
    }
    for (const b of state.buildings) for (const i of tilesOf(b)) net[i] = b.type === 'bridge' ? 3 : b.type === 'campfire' ? 2 : 4;
  }

  private drawGround(state: GameState, vx0: number, vy0: number, vx1: number, vy1: number) {
    const ctx = this.ctx;
    this.updateNet(state);
    const net = this.net;
    const season = seasonIndex(state.day);
    const era = eraOf(state);
    const paved = era >= 3;
    const fill = season === 3 ? (paved ? '#cfcac2' : '#cdbfa8') : paved ? '#b3ab9d' : '#b8935f';
    const edge = season === 3 ? '#a59a8a' : paved ? '#7f786c' : '#8a6a42';
    const x0 = Math.max(0, vx0);
    const y0 = Math.max(0, vy0);
    const x1 = Math.min(MAP_W, vx1);
    const y1 = Math.min(MAP_H, vy1);
    const linked = (x: number, y: number) => inBounds(x, y) && net[idx(x, y)] > 0;

    // The village greens: packed earth around each hearth.
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (net[idx(x, y)] !== 2) continue;
        const X = x * TILE;
        const Y = y * TILE;
        ctx.fillStyle = fill;
        ctx.fillRect(X, Y, TILE, TILE);
        ctx.fillStyle = edge;
        const green = (xx: number, yy: number) => inBounds(xx, yy) && net[idx(xx, yy)] === 2;
        if (!green(x, y - 1)) ctx.fillRect(X, Y, TILE, 1);
        if (!green(x, y + 1)) ctx.fillRect(X, Y + TILE - 1, TILE, 1);
        if (!green(x - 1, y)) ctx.fillRect(X, Y, 1, TILE);
        if (!green(x + 1, y)) ctx.fillRect(X + TILE - 1, Y, 1, TILE);
      }

    // Trails: a rough, narrow track of trodden earth, wandering a little from tile to tile.
    const trailCol = season === 3 ? 'rgba(170,150,120,0.9)' : 'rgba(140,104,62,0.85)';
    const trailLight = season === 3 ? 'rgba(220,210,190,0.8)' : 'rgba(196,160,104,0.8)';
    for (let y = y0 - 1; y <= y1; y++)
      for (let x = x0 - 1; x <= x1; x++) {
        if (!inBounds(x, y) || net[idx(x, y)] !== 5) continue;
        const jx = Math.floor(hash2(x, y, 41) * 3) - 1;
        const jy = Math.floor(hash2(x, y, 42) * 3) - 1;
        const cx = x * TILE + 7 + jx;
        const cy = y * TILE + 8 + jy;
        const seg = (nx: number, ny: number) => {
          if (!linked(nx, ny)) return;
          const tx2 = nx * TILE + 7 + (net[idx(nx, ny)] === 5 ? Math.floor(hash2(nx, ny, 41) * 3) - 1 : 0);
          const ty2 = ny * TILE + 8 + (net[idx(nx, ny)] === 5 ? Math.floor(hash2(nx, ny, 42) * 3) - 1 : 0);
          const steps = 8;
          for (let k = 0; k <= steps; k++) {
            if ((k + x + y) % 3 === 2) continue; // broken, not a made road
            const px = Math.round(cx + ((tx2 - cx) * k) / steps / 2);
            const py = Math.round(cy + ((ty2 - cy) * k) / steps / 2);
            ctx.fillStyle = trailCol;
            ctx.fillRect(px, py, 2, 2);
            ctx.fillStyle = trailLight;
            ctx.fillRect(px, py, 1, 1);
          }
        };
        seg(x + 1, y);
        seg(x - 1, y);
        seg(x, y + 1);
        seg(x, y - 1);
      }

    // Roads: a track 6px wide, joined to every neighbouring road, bridge, building, trail or green.
    const roads: number[] = [];
    for (const i of state.roads) {
      const x = tx(i);
      const y = ty(i);
      if (x >= x0 - 1 && x <= x1 && y >= y0 - 1 && y <= y1) roads.push(i);
    }
    for (const pass of [0, 1]) {
      ctx.fillStyle = pass ? fill : edge;
      const g = pass ? 0 : 1;
      for (const i of roads) {
        const x = tx(i);
        const y = ty(i);
        const X = x * TILE + 5;
        const Y = y * TILE + 5;
        ctx.fillRect(X - g, Y - g, 6 + 2 * g, 6 + 2 * g);
        if (linked(x, y - 1)) ctx.fillRect(X - g, y * TILE, 6 + 2 * g, 5);
        if (linked(x, y + 1)) ctx.fillRect(X - g, Y + 6, 6 + 2 * g, 5);
        if (linked(x - 1, y)) ctx.fillRect(x * TILE, Y - g, 5, 6 + 2 * g);
        if (linked(x + 1, y)) ctx.fillRect(X + 6, Y - g, 5, 6 + 2 * g);
      }
    }
    ctx.fillStyle = edge;
    for (const i of roads) {
      const x = tx(i);
      const y = ty(i);
      for (let k = 0; k < 3; k++) {
        const hh = hash2(x * 7 + k, y * 13, 5);
        if (hh > (paved ? 0.2 : 0.6)) ctx.fillRect(x * TILE + 5 + Math.floor(hash2(x, y, 20 + k) * 6), y * TILE + 5 + Math.floor(hash2(x, y, 30 + k) * 6), 1, 1);
      }
    }

    // Bridges across rivers.
    for (const b of state.buildings) {
      if (b.type !== 'bridge' || b.x < x0 - 1 || b.x > x1 || b.y < y0 - 1 || b.y > y1) continue;
      this.drawBridge(state, b, paved);
    }

    // Hillsides cut back by quarrying.
    const stone = landMax(state.seed).stone;
    const cutPal = season === 3 ? { W: '#ffffff', g: '#d4d9de' } : undefined;
    const cut1 = sprite('cut1', cutPal);
    const cut2 = sprite('cut2', cutPal);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = idx(x, y);
        if (!stone[i] || net[i] === 4) continue;
        const frac = state.land.stone[i] / stone[i];
        if (frac > 0.9) continue;
        const spr = frac > 0.4 ? cut1 : cut2;
        ctx.drawImage(spr, x * TILE + Math.floor((TILE - spr.width) / 2), y * TILE + 9 - Math.floor(spr.height / 2));
      }
  }

  private drawBridge(state: GameState, b: Building, paved: boolean) {
    const ctx = this.ctx;
    const map = getMap(state.seed);
    const water = (x: number, y: number) => !inBounds(x, y) || (isWater(map.terrain[idx(x, y)]) && this.net[idx(x, y)] !== 3);
    // Span the way the banks lie: toward the sides with land (or more bridge).
    const landLR = (water(b.x - 1, b.y) ? 0 : 1) + (water(b.x + 1, b.y) ? 0 : 1);
    const landUD = (water(b.x, b.y - 1) ? 0 : 1) + (water(b.x, b.y + 1) ? 0 : 1);
    const horizontal = landLR >= landUD;
    const p = b.done ? 1 : Math.max(0.1, b.progress / BUILDING_DEFS.bridge.work);
    const deck = paved ? '#bdb5a8' : '#9a6436';
    const plank = paved ? '#8f887c' : '#6e4426';
    const rail = paved ? '#77706a' : '#5e3a22';
    const X = b.x * TILE;
    const Y = b.y * TILE;
    ctx.save();
    if (!horizontal) {
      ctx.translate(X + TILE / 2, Y + TILE / 2);
      ctx.rotate(Math.PI / 2);
      ctx.translate(-X - TILE / 2, -Y - TILE / 2);
    }
    const len = Math.round(TILE * p);
    ctx.fillStyle = 'rgba(10,20,40,0.28)';
    ctx.fillRect(X, Y + 12, len, 2);
    ctx.fillStyle = deck;
    ctx.fillRect(X, Y + 4, len, 8);
    ctx.fillStyle = plank;
    for (let k = 1; k < len; k += 3) ctx.fillRect(X + k, Y + 4, 1, 8);
    ctx.fillStyle = rail;
    ctx.fillRect(X, Y + 3, len, 1);
    ctx.fillRect(X, Y + 12, len, 1);
    for (const px of [1, 7, 13]) if (px < len) ctx.fillRect(X + px, Y + 1, 2, 3);
    ctx.restore();
    if (!b.done) {
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(X + 2, Y - 4, 14, 3);
      ctx.fillStyle = '#ffd25e';
      ctx.fillRect(X + 3, Y - 3, Math.round(12 * p), 1);
    }
  }

  private pixelText(text: string, x: number, y: number, color: string) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '7px Silkscreen, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 6;
    ctx.fillStyle = 'rgba(14,11,22,0.85)';
    ctx.fillRect(Math.round(x - w / 2), y - 5, Math.round(w), 10);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  private drawFeature(f: number, x: number, y: number) {
    const ctx = this.ctx;
    const X = x * TILE;
    const Y = y * TILE;
    switch (f) {
      case F.Ruins:
        ctx.drawImage(sprite('ruins'), X + 1, Y + 4);
        break;
      case F.Tribe:
        ctx.drawImage(sprite('tents'), X, Y + 9);
        break;
      case F.Grove: {
        ctx.drawImage(sprite('grove', TREE_PAL[1].oak), X + 1, Y - 2);
        if (Math.sin(this.time * 2 + x) > 0.6) {
          ctx.fillStyle = '#fff4b0';
          ctx.fillRect(X + 3 + ((this.time * 3) % 10), Y + 2, 1, 1);
        }
        break;
      }
      case F.Cache:
        ctx.drawImage(sprite('cache'), X + 3, Y + 8);
        break;
      case F.Ore: {
        ctx.drawImage(sprite('ore'), X + 9, Y + 9);
        if ((this.time + x * 0.37) % 2 < 0.2) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(X + 10, Y + 9, 1, 1);
        }
        break;
      }
    }
  }

  /** Homes look like the place they stand in: huts in a camp, timber houses in a town, tall townhouses in a city. */
  private buildingSpriteName(state: GameState, type: BuildingId, town?: number): string {
    const tier = state.towns.find((t) => t.id === town)?.tier ?? 0;
    if (type === 'hut') return eraOf(state) >= 2 || tier >= 2 ? 'hut1' : 'hut0';
    if (type === 'house') return tier >= 3 ? 'house2' : 'house';
    if (type === 'shrine') return 'temple';
    return type;
  }

  /** Draw a building's picture over its footprint, rising from the ground as it is built (progress 0..1). */
  private drawBuildingSprite(state: GameState, type: BuildingId, x: number, y: number, progress: number, town?: number) {
    const ctx = this.ctx;
    const [w, h] = sizeOf(type);
    const X = x * TILE;
    const Y = y * TILE;
    const season = seasonIndex(state.day);
    const sea = climateSeason(getMap(state.seed).biome[idx(x, y)], season);
    const rise = (spr: HTMLCanvasElement, px: number, by: number) => {
      // Rising silhouette: draw the bottom portion according to progress.
      if (progress >= 1) return ctx.drawImage(spr, px, by - spr.height);
      const hh = Math.max(1, Math.round(spr.height * progress));
      ctx.drawImage(spr, 0, spr.height - hh, spr.width, hh, px, by - hh, spr.width, hh);
    };
    const bottom = Y + h * TILE;
    switch (type) {
      case 'monument': {
        this.drawMonument(x + (w - 1) / 2, y + h - 1, progress);
        return;
      }
      case 'farm': {
        // Furrowed fields over the whole footprint.
        const pal = FARM_PAL[sea];
        const rows = Math.max(1, Math.round((h * TILE - 4) * Math.min(1, progress)));
        ctx.fillStyle = '#1a1423';
        ctx.fillRect(X + 1, bottom - rows - 3, w * TILE - 2, rows + 2);
        ctx.fillStyle = pal.U;
        ctx.fillRect(X + 2, bottom - rows - 2, w * TILE - 4, rows);
        ctx.fillStyle = pal['1'];
        for (let yy = bottom - rows - 1; yy < bottom - 2; yy += 2) for (let xx = X + 3; xx < X + w * TILE - 3; xx += 2) ctx.fillRect(xx, yy, 1, 1);
        if (progress >= 1) {
          // A scarecrow keeps watch.
          ctx.fillStyle = '#5e3a22';
          ctx.fillRect(X + w * TILE - 9, bottom - 14, 1, 9);
          ctx.fillRect(X + w * TILE - 11, bottom - 11, 5, 1);
          ctx.fillStyle = '#e9c046';
          ctx.fillRect(X + w * TILE - 10, bottom - 16, 3, 2);
        }
        return;
      }
      case 'pasture': {
        // A fenced paddock with a shelter in one corner.
        if (progress >= 0.3) {
          ctx.fillStyle = '#5e3a22';
          ctx.fillRect(X + 1, Y + 6, w * TILE - 2, 1);
          ctx.fillRect(X + 1, bottom - 2, w * TILE - 2, 1);
          ctx.fillRect(X + 1, Y + 6, 1, h * TILE - 8);
          ctx.fillRect(X + w * TILE - 2, Y + 6, 1, h * TILE - 8);
          ctx.fillStyle = '#86532e';
          for (let xx = X + 1; xx < X + w * TILE; xx += 5) {
            ctx.fillRect(xx, Y + 4, 1, 3);
            ctx.fillRect(xx, bottom - 4, 1, 3);
          }
        }
        rise(sprite('pasture'), X + w * TILE - 16, Y + TILE + 2);
        return;
      }
      case 'quarry':
        rise(sprite('cut2'), X + 3, Y + 10);
        rise(sprite('quarry'), X + 2, bottom);
        rise(sprite('rock'), X + w * TILE - 10, bottom - 2);
        return;
      case 'lumber':
        rise(sprite('lumber'), X, bottom);
        rise(sprite('logs'), X + TILE + 4, bottom - 1);
        return;
      case 'storehouse':
        rise(sprite('storehouse'), X, bottom);
        rise(sprite('crates'), X + TILE + 4, bottom - 1);
        return;
      case 'smithy':
        rise(sprite('smithy'), X, bottom);
        rise(sprite('logs'), X + TILE + 3, bottom - 1);
        return;
      case 'library':
        rise(sprite('library'), X, bottom);
        rise(sprite('library'), X + TILE, bottom);
        return;
      default: {
        const name = this.buildingSpriteName(state, type, town);
        const spr = sprite(name);
        rise(spr, X + Math.floor((w * TILE - spr.width) / 2), bottom);
      }
    }
  }

  private drawBuilding(state: GameState, b: Building) {
    const ctx = this.ctx;
    const def = BUILDING_DEFS[b.type];
    const [w, h] = sizeOf(b.type);
    const X = b.x * TILE;
    const Y = b.y * TILE;
    // Shadow
    ctx.fillStyle = 'rgba(10,8,20,0.22)';
    ctx.fillRect(X + 2, Y + h * TILE - 2, w * TILE - 3, 2);
    if (!b.done) {
      const stage = siteStage(state, b);
      const total = def.work > 0 ? def.work : 1;
      const p = stage === 'building' ? b.progress / total : 0;
      if (stage === 'building') {
        ctx.globalAlpha = 0.9;
        this.drawBuildingSprite(state, b.type, b.x, b.y, Math.max(0.08, p), b.town);
        ctx.globalAlpha = 1;
      }
      // Rock still to be levelled shows as rubble; felling shows on the trees themselves.
      if (stage === 'levelling') for (const i of tilesOf(b)) ctx.drawImage(sprite('rock'), tx(i) * TILE + 2 + Math.floor(hash2(i, 1, 3) * 6), ty(i) * TILE + 7);
      if (b.type !== 'monument') for (let k = 0; k < w; k++) ctx.drawImage(sprite('site'), X + k * TILE, Y + (h - 1) * TILE);
      // Progress bar: green while felling, grey while levelling, gold while building.
      const prepTotal = b.prepTotal ?? 0;
      const prepLeft = fellLeft(state, b) + (b.prep ?? 0);
      const frac = stage === 'building' ? p : prepTotal > 0 ? 1 - prepLeft / prepTotal : 0;
      const bw = w * TILE - 4;
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(X + 2, Y - 4, bw + 2, 3);
      ctx.fillStyle = stage === 'felling' ? '#7bc950' : stage === 'levelling' ? '#c3cad4' : '#ffd25e';
      ctx.fillRect(X + 3, Y - 3, Math.round(bw * Math.max(0, Math.min(1, frac))), 1);
      return;
    }
    if (b.spent) {
      // Worked out: the pit is abandoned and weathering.
      ctx.globalAlpha = 0.55;
      this.drawBuildingSprite(state, b.type, b.x, b.y, 1, b.town);
      ctx.globalAlpha = 1;
      ctx.drawImage(sprite('rock'), X + 1, Y + h * TILE - 6);
      return;
    }
    this.drawBuildingSprite(state, b.type, b.x, b.y, 1, b.town);
    if (b.type === 'campfire') {
      this.drawFlames(X + 8, Y + 11);
      // A well on the green once a camp becomes a village.
      const t = state.towns.find((x) => x.id === b.town);
      if (t && t.tier >= 1 && inBounds(b.x + 1, b.y - 1)) ctx.drawImage(sprite('well'), X + TILE + 4, Y - 2);
    }
    if (b.type === 'smithy' && Math.sin(this.time * 9) > -0.2) {
      ctx.fillStyle = 'rgba(255,190,80,0.35)';
      ctx.fillRect(X + 3, Y + 9, 5, 3);
    }
  }

  private drawFlames(cx: number, by: number) {
    const ctx = this.ctx;
    const t = this.time;
    // glow
    const g = 0.18 + 0.05 * Math.sin(t * 13);
    ctx.fillStyle = `rgba(255,170,60,${g})`;
    ctx.fillRect(cx - 7, by - 5, 14, 8);
    ctx.fillStyle = `rgba(255,170,60,${g * 0.6})`;
    ctx.fillRect(cx - 10, by - 3, 20, 5);
    const cols = [
      [-2, '#e06c2e'],
      [-1, '#f7d55c'],
      [0, '#fff3c4'],
      [1, '#f7d55c'],
      [2, '#e06c2e'],
    ] as const;
    for (const [dx, col] of cols) {
      const h = Math.max(1, Math.round((4 - Math.abs(dx) * 1.2) + Math.sin(t * 17 + dx * 2.3) * 1.3 + Math.sin(t * 7 + dx) * 0.8));
      ctx.fillStyle = '#c43d2f';
      ctx.fillRect(cx + dx, by - h - 1, 1, h + 1);
      ctx.fillStyle = col;
      ctx.fillRect(cx + dx, by - h, 1, h);
    }
  }

  private drawMonument(x: number, y: number, progress: number) {
    const ctx = this.ctx;
    const cx = Math.round(x * TILE + 8);
    const base = y * TILE + TILE;
    const H = 58;
    const shown = Math.round(H * Math.min(1, progress));
    const done = progress >= 1;
    // Glow when complete
    if (done) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 2);
      const grd = ctx.createRadialGradient(cx, base - H, 2, cx, base - H, 40);
      grd.addColorStop(0, `rgba(255,236,150,${0.55 + pulse * 0.25})`);
      grd.addColorStop(1, 'rgba(255,236,150,0)');
      ctx.fillStyle = grd;
      ctx.fillRect(cx - 40, base - H - 40, 80, 80);
    }
    for (let i = 0; i < shown; i++) {
      const yy = base - 1 - i;
      const t = i / H;
      const half = Math.max(1, Math.round(11 - t * 9 - (i < 6 ? -2 : 0)));
      // outline
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(cx - half - 1, yy, half * 2 + 2, 1);
      // stone body with banding
      const band = i % 9 === 0;
      ctx.fillStyle = band ? '#b07a45' : '#e7dfd0';
      ctx.fillRect(cx - half, yy, half, 1);
      ctx.fillStyle = band ? '#86532e' : '#bdb3a2';
      ctx.fillRect(cx, yy, half, 1);
      if (!band && i > 8 && i % 9 === 4 && half > 3) {
        ctx.fillStyle = '#2a2030';
        ctx.fillRect(cx - 1, yy - 1, 2, 3);
      }
    }
    if (done) {
      ctx.fillStyle = '#1a1423';
      ctx.fillRect(cx - 3, base - H - 6, 6, 6);
      ctx.fillStyle = Math.sin(this.time * 6) > 0 ? '#fff3c4' : '#f7d55c';
      ctx.fillRect(cx - 2, base - H - 5, 4, 4);
    } else {
      // scaffolding
      ctx.fillStyle = '#86532e';
      const top = base - shown - 4;
      ctx.fillRect(cx - 13, top, 1, base - top);
      ctx.fillRect(cx + 12, top, 1, base - top);
      for (let yy = base - 6; yy > top; yy -= 8) ctx.fillRect(cx - 13, yy, 26, 1);
    }
  }

  private drawWalker(w: import('./actors').Walker, state: GameState) {
    const ctx = this.ctx;
    const moving = !w.working && w.wait <= 0 && Math.hypot(w.tx - w.x, w.ty - w.y) > 0.05;
    const step = Math.floor(w.phase * 6) % 2;
    let name: string;
    if (w.kind === 'child') name = moving ? (step ? 'child1' : 'child0') : 'child0';
    else if (moving) name = step ? 'person1' : 'person2';
    else if (w.working && w.kind === 'adult' && w.job && !w.returning && ['woodcutter', 'quarrier', 'miner', 'farmer', 'builder', 'smith'].includes(w.job)) name = Math.floor(w.phase * 3) % 2 ? 'personWork' : 'person0';
    else name = 'person0';
    const shirt = w.kind === 'adult' ? jobColor(w.job) : w.kind === 'child' ? '#d9a066' : '#8b7f9a';
    const hair = w.kind === 'elder' ? '#e6e2da' : w.hair;
    const spr = sprite(name, { S: shirt, A: hair, U: w.pants });
    const px = Math.round(w.x * TILE);
    const py = Math.round(w.y * TILE);
    ctx.globalAlpha = w.alpha;
    ctx.fillStyle = 'rgba(10,8,20,0.25)';
    ctx.fillRect(px - 3, py - 1, 6, 2);
    if (w.facing < 0) {
      ctx.save();
      ctx.translate(px, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(spr, -Math.floor(spr.width / 2), py - spr.height);
      ctx.restore();
    } else {
      ctx.drawImage(spr, px - Math.floor(spr.width / 2), py - spr.height);
    }
    // Carried goods on the way back
    if (w.returning && moving && w.kind === 'adult') {
      const carry: Record<string, string> = { woodcutter: '#86532e', gatherer: '#c43d2f', hunter: '#842a2a', quarrier: '#9aa0a8', miner: '#4a4f5c', farmer: '#e9c046' };
      const col = w.job ? carry[w.job] : undefined;
      if (col) {
        ctx.fillStyle = '#1a1423';
        ctx.fillRect(px - 2, py - spr.height - 3, 4, 3);
        ctx.fillStyle = col;
        ctx.fillRect(px - 1, py - spr.height - 2, 2, 1);
      }
    }
    ctx.globalAlpha = 1;
    void state;
  }

  private drawAnimal(kind: string, x: number, y: number, phase: number, facing: number) {
    const ctx = this.ctx;
    const px = Math.round(x * TILE);
    const py = Math.round(y * TILE);
    let spr: HTMLCanvasElement;
    switch (kind) {
      case 'deer':
        spr = sprite(Math.floor(phase * 4) % 2 ? 'deer0' : 'deer1');
        break;
      case 'sheep':
        spr = sprite('sheep');
        break;
      case 'bird':
        spr = sprite(Math.floor(phase * 5) % 2 ? 'bird0' : 'bird1');
        ctx.globalAlpha = 0.85;
        ctx.drawImage(spr, px, py - 30);
        ctx.fillStyle = 'rgba(10,8,20,0.15)';
        ctx.fillRect(px + 1, py + 2, 3, 1);
        ctx.globalAlpha = 1;
        return;
      case 'fish': {
        const t = (phase * 0.8) % 5;
        if (t > 1) return;
        const arc = Math.sin(t * Math.PI) * 6;
        spr = sprite('fish');
        ctx.drawImage(spr, px - 2 + Math.round(t * 6), py - Math.round(arc));
        if (t < 0.15 || t > 0.85) {
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.fillRect(px - 2 + Math.round(t * 6), py + 2, 3, 1);
        }
        return;
      }
      default:
        return;
    }
    ctx.fillStyle = 'rgba(10,8,20,0.2)';
    ctx.fillRect(px - 3, py - 1, 7, 2);
    if (facing < 0) {
      ctx.save();
      ctx.translate(px, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(spr, -Math.floor(spr.width / 2), py - spr.height);
      ctx.restore();
    } else ctx.drawImage(spr, px - Math.floor(spr.width / 2), py - spr.height);
  }

  private drawParticles() {
    const ctx = this.ctx;
    for (const p of this.actors.particles) {
      const a = Math.max(0, Math.min(1, p.life / p.max));
      const X = p.x * TILE;
      const Y = p.y * TILE;
      switch (p.kind) {
        case 'smoke': {
          ctx.fillStyle = `rgba(200,195,210,${0.35 * a})`;
          const s = Math.round(p.size * 2);
          ctx.fillRect(Math.round(X - s / 2), Math.round(Y - s / 2), s, s);
          break;
        }
        case 'spark':
          ctx.fillStyle = `rgba(255,${180 + Math.floor(a * 60)},80,${a})`;
          ctx.fillRect(Math.round(X), Math.round(Y), 1, 1);
          break;
        case 'dust':
          ctx.fillStyle = `rgba(214,190,150,${0.6 * a})`;
          ctx.fillRect(Math.round(X), Math.round(Y), Math.ceil(p.size), Math.ceil(p.size));
          break;
        case 'star':
          ctx.fillStyle = `rgba(255,236,140,${a})`;
          ctx.fillRect(Math.round(X), Math.round(Y), 1, 1);
          if (a > 0.5) {
            ctx.fillRect(Math.round(X) - 1, Math.round(Y), 3, 1);
            ctx.fillRect(Math.round(X), Math.round(Y) - 1, 1, 3);
          }
          break;
        case 'heart':
          ctx.globalAlpha = a;
          ctx.drawImage(sprite('i_heart'), Math.round(X - 6), Math.round(Y - 6));
          ctx.globalAlpha = 1;
          break;
        case 'spirit': {
          ctx.fillStyle = `rgba(220,230,255,${0.7 * a})`;
          const wob = Math.round(Math.sin(p.life * 6));
          ctx.fillRect(Math.round(X) - 1 + wob, Math.round(Y) - 2, 3, 3);
          ctx.fillRect(Math.round(X) + wob, Math.round(Y) + 1, 1, 2);
          break;
        }
        case 'snow':
          ctx.fillStyle = `rgba(255,255,255,${0.9 * Math.min(1, a * 3)})`;
          ctx.fillRect(Math.round(X), Math.round(Y), 1, 1);
          break;
        case 'leaf':
          ctx.fillStyle = p.color!;
          ctx.globalAlpha = Math.min(1, a * 3);
          ctx.fillRect(Math.round(X), Math.round(Y), 2, 1);
          ctx.globalAlpha = 1;
          break;
        case 'text':
          ctx.globalAlpha = Math.min(1, a * 2);
          this.pixelText(p.text!, X, Y, p.color ?? '#fff');
          ctx.globalAlpha = 1;
          break;
        case 'beam': {
          const grd = ctx.createLinearGradient(0, Y - 200, 0, Y);
          grd.addColorStop(0, 'rgba(255,230,140,0)');
          grd.addColorStop(1, `rgba(255,230,140,${0.6 * a})`);
          ctx.fillStyle = grd;
          ctx.fillRect(X - 5, Y - 200, 10, 200);
          break;
        }
      }
    }
  }
}
