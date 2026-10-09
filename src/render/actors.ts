import { ADULT_AGE, DAYS_PER_YEAR, ELDER_AGE, JOB_DEFS } from '../game/data';
import { getMap, idx, inBounds, isWater, tx, ty } from '../game/map';
import { hash2 } from '../game/rng';
import type { Building, GameState, JobId, Settler } from '../game/types';
import { F, T } from '../game/types';

/** Visual-only agents. They never affect the simulation. */
export interface Walker {
  id: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  /** seconds remaining in current pause */
  wait: number;
  working: boolean;
  /** true when heading back to drop off */
  returning: boolean;
  phase: number;
  facing: 1 | -1;
  kind: 'adult' | 'child' | 'elder';
  job: JobId | null;
  hair: string;
  pants: string;
  alpha: number;
  leaving: boolean;
  seen: number;
}

export interface Animal {
  kind: 'deer' | 'sheep' | 'fish' | 'bird';
  x: number;
  y: number;
  tx: number;
  ty: number;
  hx: number;
  hy: number;
  wait: number;
  phase: number;
  facing: 1 | -1;
  life: number;
  vx?: number;
  vy?: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  kind: 'smoke' | 'spark' | 'heart' | 'spirit' | 'dust' | 'star' | 'text' | 'snow' | 'leaf' | 'beam';
  size: number;
  color?: string;
  text?: string;
}

const HAIR = ['#5d3b2a', '#2a1d18', '#a8652f', '#d8b25a', '#7a3b24', '#3b2d3f'];
const PANTS = ['#4b3b5a', '#5a4632', '#3c4a5e', '#6b4d36'];
const MAX_WALKERS = 180;

export class Actors {
  walkers = new Map<number, Walker>();
  animals: Animal[] = [];
  particles: Particle[] = [];
  private animalKey = '';

  constructor(private getState: () => GameState) {}

  reset() {
    this.walkers.clear();
    this.animals = [];
    this.particles = [];
    this.animalKey = '';
  }

  private hearth(state: GameState): Building {
    return state.buildings.find((b) => b.type === 'campfire') ?? state.buildings[0];
  }

  private pickBuilding(state: GameState, types: string[], seed: number): Building | null {
    const list = state.buildings.filter((b) => b.done && types.includes(b.type));
    if (!list.length) return null;
    return list[seed % list.length];
  }

  private randomTileNear(state: GameState, cx: number, cy: number, r: number, ok: (t: number, i: number) => boolean): [number, number] | null {
    const map = getMap(state.seed);
    for (let k = 0; k < 24; k++) {
      const x = cx + Math.round((Math.random() * 2 - 1) * r);
      const y = cy + Math.round((Math.random() * 2 - 1) * r);
      if (!inBounds(x, y)) continue;
      const i = idx(x, y);
      if (!state.explored[i]) continue;
      if (ok(map.terrain[i], i)) return [x, y];
    }
    return null;
  }

  /** Decide where a walker goes next. Returns tile coordinates (floats, centre-ish). */
  private nextTarget(state: GameState, w: Walker): [number, number] {
    const map = getMap(state.seed);
    const h = this.hearth(state);
    const jitter = (x: number, y: number, j = 0.35): [number, number] => [x + 0.5 + (Math.random() * 2 - 1) * j, y + 0.6 + (Math.random() * 2 - 1) * j];
    const land = (t: number) => !isWater(t) && t !== T.Mountain && t !== T.Peak;
    const home = this.pickBuilding(state, ['hut', 'house'], w.id) ?? h;

    if (w.kind === 'child') {
      const base = Math.random() < 0.5 ? home : h;
      const t = this.randomTileNear(state, base.x, base.y, 2, land);
      return t ? jitter(t[0], t[1], 0.45) : jitter(base.x, base.y + 1);
    }
    if (w.kind === 'elder') {
      return Math.random() < 0.7 ? jitter(h.x + (Math.random() < 0.5 ? -1 : 1), h.y, 0.4) : jitter(home.x, home.y + 0.3, 0.3);
    }
    const job = w.job;
    const goHome = w.returning;
    const site = (types: string[]) => this.pickBuilding(state, types, w.id);
    const near = (b: Building | null, r: number, ok: (t: number, i: number) => boolean) => {
      const base = b ?? h;
      const t = this.randomTileNear(state, base.x, base.y, r, ok);
      return t ? jitter(t[0], t[1]) : jitter(base.x, base.y + 1);
    };
    switch (job) {
      case 'gatherer': {
        if (goHome) return jitter(h.x, h.y + 1, 0.6);
        return near(h, 5, (t, i) => land(t) && (map.feature[i] === F.Berries || t === T.Grass || t === T.Meadow || t === T.Forest));
      }
      case 'hunter': {
        const lodge = site(['lodge']);
        if (goHome) return lodge ? jitter(lodge.x, lodge.y + 0.6) : jitter(h.x, h.y + 1);
        return near(lodge, 6, (t) => t === T.Forest || t === T.Dense || t === T.Grass);
      }
      case 'woodcutter': {
        const camp = site(['lumber']);
        if (goHome) return camp ? jitter(camp.x, camp.y + 0.5) : jitter(h.x, h.y + 1);
        return near(camp, 3, (t) => t === T.Forest || t === T.Dense);
      }
      case 'farmer': {
        const farm = site(['farm']) ?? h;
        return jitter(farm.x, farm.y + 0.2, 0.45);
      }
      case 'quarrier': {
        const q = site(['quarry']) ?? h;
        if (goHome) return jitter(q.x, q.y + 0.6);
        return near(q, 1, (t) => t === T.Hills || t === T.Mountain || land(t));
      }
      case 'miner': {
        const m = site(['mine']) ?? h;
        if (goHome) {
          const s = site(['smithy', 'storehouse']) ?? h;
          return jitter(s.x, s.y + 0.6);
        }
        return jitter(m.x, m.y + 0.6, 0.2);
      }
      case 'smith': {
        const s = site(['smithy']) ?? h;
        return jitter(s.x, s.y + 0.6, 0.35);
      }
      case 'scholar': {
        const l = site(['library']) ?? h;
        return jitter(l.x, l.y + 0.7, 0.45);
      }
      case 'healer': {
        if (goHome) {
          const herb = site(['herbalist']) ?? h;
          return jitter(herb.x, herb.y + 0.6);
        }
        const hut = this.pickBuilding(state, ['hut', 'house'], Math.floor(Math.random() * 97)) ?? h;
        return jitter(hut.x, hut.y + 0.6);
      }
      case 'scout': {
        if (goHome) return jitter(h.x, h.y + 1, 0.6);
        // Head toward the edge of the known world.
        const target = state.exploreTarget ?? null;
        const ax = target !== null ? tx(target) : h.x;
        const ay = target !== null ? ty(target) : h.y;
        for (let k = 0; k < 40; k++) {
          const ang = Math.random() * Math.PI * 2;
          const r = target !== null ? Math.random() * 6 : 6 + Math.random() * 14;
          const x = Math.round(ax + Math.cos(ang) * r);
          const y = Math.round(ay + Math.sin(ang) * r);
          if (!inBounds(x, y)) continue;
          const i = idx(x, y);
          if (state.explored[i] && land(map.terrain[i])) return jitter(x, y);
        }
        return jitter(h.x, h.y + 1);
      }
      case 'builder': {
        const s = state.buildings.find((b) => !b.done);
        if (s && !goHome) return jitter(s.x, s.y + 0.6, 0.45);
        const store = site(['storehouse']) ?? h;
        return jitter(store.x, store.y + 0.8, 0.5);
      }
      default: {
        const t = this.randomTileNear(state, h.x, h.y, 3, land);
        return t ? jitter(t[0], t[1], 0.4) : jitter(h.x, h.y + 1);
      }
    }
  }

  private kindOf(state: GameState, s: Settler): Walker['kind'] {
    const age = (state.day - s.born) / DAYS_PER_YEAR;
    return age < ADULT_AGE ? 'child' : age >= ELDER_AGE ? 'elder' : 'adult';
  }

  syncSettlers(state: GameState, stamp: number) {
    const h = this.hearth(state);
    const pop = state.settlers;
    const show = pop.length <= MAX_WALKERS ? pop : pop.filter((s) => hash2(s.id, 1) < MAX_WALKERS / pop.length);
    for (const s of show) {
      let w = this.walkers.get(s.id);
      const kind = this.kindOf(state, s);
      if (!w) {
        const home = this.pickBuilding(state, ['hut', 'house'], s.id) ?? h;
        w = {
          id: s.id,
          x: home.x + 0.5 + (Math.random() - 0.5) * 0.6,
          y: home.y + 0.8,
          tx: home.x + 0.5,
          ty: home.y + 1,
          speed: 1.2 + Math.random() * 0.5,
          wait: Math.random() * 2,
          working: false,
          returning: false,
          phase: Math.random() * 10,
          facing: 1,
          kind,
          job: s.job,
          hair: HAIR[s.id % HAIR.length],
          pants: PANTS[(s.id >> 2) % PANTS.length],
          alpha: 0,
          leaving: false,
          seen: stamp,
        };
        this.walkers.set(s.id, w);
      }
      w.seen = stamp;
      if (w.job !== s.job || w.kind !== kind) {
        w.job = s.job;
        w.kind = kind;
        w.wait = 0;
        w.returning = false;
      }
    }
    for (const w of this.walkers.values()) if (w.seen !== stamp && !w.leaving) w.leaving = true;
  }

  syncAnimals(state: GameState) {
    const map = getMap(state.seed);
    const pastures = state.buildings.filter((b) => b.type === 'pasture' && b.done);
    const key = `${state.stats.tilesExplored}:${pastures.length}`;
    if (key === this.animalKey) return;
    this.animalKey = key;
    this.animals = this.animals.filter((a) => a.kind === 'bird');
    for (let i = 0; i < map.feature.length; i++) {
      if (!state.explored[i]) continue;
      const f = map.feature[i];
      if (f === F.Game) {
        for (let k = 0; k < 3; k++) this.animals.push(this.spawn('deer', tx(i) + Math.random(), ty(i) + Math.random()));
      } else if (f === F.Fish) {
        this.animals.push(this.spawn('fish', tx(i) + 0.5, ty(i) + 0.5));
      }
    }
    for (const p of pastures) for (let k = 0; k < 3; k++) this.animals.push(this.spawn('sheep', p.x + 0.3 + Math.random() * 0.4, p.y + 0.6 + Math.random() * 0.3));
  }

  private spawn(kind: Animal['kind'], x: number, y: number): Animal {
    return { kind, x, y, tx: x, ty: y, hx: x, hy: y, wait: Math.random() * 4, phase: Math.random() * 10, facing: 1, life: 0 };
  }

  update(dt: number, gameSpeed: number) {
    const state = this.getState();
    const map = getMap(state.seed);
    const sp = Math.min(3, Math.max(1, gameSpeed));
    for (const w of this.walkers.values()) {
      w.alpha = Math.min(1, Math.max(0, w.alpha + (w.leaving ? -dt * 1.5 : dt * 2)));
      if (w.leaving && w.alpha <= 0) {
        this.walkers.delete(w.id);
        continue;
      }
      if (w.leaving) continue;
      w.phase += dt * sp;
      const dx = w.tx - w.x;
      const dy = w.ty - w.y;
      const dist = Math.hypot(dx, dy);
      if (w.wait > 0) {
        w.wait -= dt * sp;
        continue;
      }
      if (dist < 0.05) {
        // Arrived: work or rest for a while, then pick the next destination.
        if (!w.working) {
          w.working = true;
          const busy = w.kind === 'adult' && w.job && !w.returning;
          w.wait = busy ? 2 + Math.random() * 4 : 1 + Math.random() * 3;
          if (w.kind === 'elder') w.wait += 3;
        } else {
          w.working = false;
          if (w.kind === 'adult') w.returning = !w.returning;
          const [nx, ny] = this.nextTarget(state, w);
          w.tx = nx;
          w.ty = ny;
        }
        continue;
      }
      w.working = false;
      const speed = w.speed * (w.kind === 'elder' ? 0.6 : w.kind === 'child' ? 1.1 : 1) * sp;
      const step = Math.min(dist, speed * dt);
      w.x += (dx / dist) * step;
      w.y += (dy / dist) * step;
      if (Math.abs(dx) > 0.01) w.facing = dx > 0 ? 1 : -1;
    }

    for (const a of this.animals) {
      a.phase += dt;
      if (a.kind === 'bird') {
        a.x += a.vx! * dt;
        a.y += a.vy! * dt;
        a.life -= dt;
        continue;
      }
      if (a.kind === 'fish') continue;
      if (a.wait > 0) {
        a.wait -= dt;
        continue;
      }
      const dx = a.tx - a.x;
      const dy = a.ty - a.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.05) {
        a.wait = 1 + Math.random() * 5;
        const r = a.kind === 'sheep' ? 0.35 : 1.6;
        for (let k = 0; k < 8; k++) {
          const nx = a.hx + (Math.random() * 2 - 1) * r;
          const ny = a.hy + (Math.random() * 2 - 1) * r;
          const ix = Math.floor(nx);
          const iy = Math.floor(ny);
          if (!inBounds(ix, iy)) continue;
          if (a.kind === 'deer' && isWater(map.terrain[idx(ix, iy)])) continue;
          a.tx = nx;
          a.ty = ny;
          break;
        }
        continue;
      }
      const sp2 = (a.kind === 'deer' ? 0.9 : 0.3) * dt;
      a.x += (dx / d) * Math.min(d, sp2);
      a.y += (dy / d) * Math.min(d, sp2);
      if (Math.abs(dx) > 0.01) a.facing = dx > 0 ? 1 : -1;
    }
    this.animals = this.animals.filter((a) => a.kind !== 'bird' || a.life > 0);

    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'smoke') {
        p.vx += (Math.random() - 0.4) * dt * 0.3;
        p.size += dt * 0.6;
      }
      if (p.kind === 'leaf') p.vx = Math.sin(p.life * 3 + p.y) * 0.6;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  emit(p: Omit<Particle, 'max'>) {
    if (this.particles.length > 900) return;
    this.particles.push({ ...p, max: p.life });
  }

  spawnBirds(w: number, h: number) {
    const fromLeft = Math.random() < 0.5;
    const y = Math.random() * h;
    const n = 3 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n; k++) {
      this.animals.push({
        kind: 'bird',
        x: fromLeft ? -2 - k * 0.6 : w + 2 + k * 0.6,
        y: y + (k % 2 ? 0.5 : -0.3) * k * 0.4,
        tx: 0,
        ty: 0,
        hx: 0,
        hy: 0,
        wait: 0,
        phase: Math.random() * 4,
        facing: fromLeft ? 1 : -1,
        life: (w + 8) / 2.5,
        vx: (fromLeft ? 1 : -1) * 2.5,
        vy: (Math.random() - 0.5) * 0.4,
      });
    }
  }
}

export function jobColor(job: JobId | null): string {
  return job ? JOB_DEFS[job].color : '#8d8577';
}
