import { MAP_H, MAP_W } from './data';
import { invalidate } from './derived';
import { packLand, unpackLand } from './land';
import { SAVE_VERSION } from './state';
import { emptyRates, tick, type TickContext } from './sim';
import type { FxEvent, GameState, ResourceId } from './types';
import { RESOURCES } from './types';

const KEY = 'hearthlands.save.v1';
const PREFS = 'hearthlands.prefs.v1';

export interface Prefs {
  sound: boolean;
  speed: number;
  /** Show the elder's guide tips. */
  tips: boolean;
}

const DEFAULT_PREFS: Prefs = { sound: true, speed: 1, tips: true };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Update some preferences, keeping the rest. */
export function savePrefs(p: Partial<Prefs>) {
  try {
    localStorage.setItem(PREFS, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    /* storage unavailable */
  }
}

/** Compact the explored array into a string for storage: runs of unknown and known land, in base 36. */
function packExplored(e: number[]) {
  const runs: string[] = [];
  let cur = 0;
  let len = 0;
  for (let i = 0; i < e.length; i++) {
    const v = e[i] ? 1 : 0;
    if (v === cur) len++;
    else {
      runs.push(len.toString(36));
      cur = v;
      len = 1;
    }
  }
  runs.push(len.toString(36));
  return 'r' + runs.join(',');
}

function unpackExplored(s: string) {
  const out = new Array(MAP_W * MAP_H).fill(0);
  if (s.startsWith('r')) {
    let at = 0;
    let v = 0;
    for (const run of s.slice(1).split(',')) {
      const n = parseInt(run, 36);
      if (v) out.fill(1, at, Math.min(out.length, at + n));
      at += n;
      v ^= 1;
    }
    return out;
  }
  // Older saves: four tiles to a hex digit.
  for (let i = 0; i < s.length; i++) {
    const v = parseInt(s[i], 16);
    for (let b = 0; b < 4; b++) if (i * 4 + b < out.length) out[i * 4 + b] = v & (1 << b) ? 1 : 0;
  }
  return out;
}

export function serialize(state: GameState): string {
  return JSON.stringify({ ...state, explored: packExplored(state.explored), land: packLand(state) });
}

/**
 * Saves from before the great world (version 5 and older) were made on a much smaller map that the
 * current generator no longer produces, so they cannot be carried over: they are declined and a new
 * settlement begins.
 */
export function isLegacySave(json: string) {
  try {
    const raw = JSON.parse(json);
    return !!raw && typeof raw === 'object' && typeof raw.version === 'number' && raw.version < SAVE_VERSION;
  } catch {
    return false;
  }
}

export function deserialize(json: string): GameState | null {
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== 'object' || raw.version !== SAVE_VERSION) return null;
    raw.explored = typeof raw.explored === 'string' ? unpackExplored(raw.explored) : raw.explored;
    for (const r of RESOURCES) if (typeof raw.res[r] !== 'number' || !isFinite(raw.res[r])) raw.res[r] = 0;
    raw.land = unpackLand(raw.seed, raw.land ?? {});
    raw.roads ??= [];
    raw.trails ??= [];
    raw.graded ??= [];
    raw.expeditions ??= [];
    raw.routes ??= [];
    raw.traffic ??= {};
    delete raw.exploreProgress;
    raw.landEpoch ??= 0;
    raw.eff ??= {};
    if (!Array.isArray(raw.towns) || !raw.towns.length) return null;
    return raw as GameState;
  } catch {
    return null;
  }
}

export function saveGame(state: GameState) {
  state.lastSave = Date.now();
  try {
    localStorage.setItem(KEY, serialize(state));
    return true;
  } catch {
    return false;
  }
}

export function loadGame(): GameState | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? deserialize(s) : null;
  } catch {
    return null;
  }
}

export function hasSave() {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function exportSave(state: GameState) {
  return btoa(unescape(encodeURIComponent(serialize(state))));
}

export function importSave(text: string): GameState | null {
  try {
    return deserialize(decodeURIComponent(escape(atob(text.trim()))));
  } catch {
    return null;
  }
}

export interface OfflineReport {
  awayMs: number;
  days: number;
  before: { pop: number; res: Record<ResourceId, number> };
  after: { pop: number; res: Record<ResourceId, number> };
  births: number;
  deaths: number;
  arrivals: number;
}

/** Offline progress runs at half speed, capped at 40 in-game years. */
export const OFFLINE_RATE = 0.5;
export const OFFLINE_MAX_DAYS = 1600;

export function offlineDays(awayMs: number) {
  return Math.min(OFFLINE_MAX_DAYS, Math.floor((awayMs / 1000) * OFFLINE_RATE));
}

export function simulateOffline(state: GameState, awayMs: number, maxDays = offlineDays(awayMs)): OfflineReport | null {
  const run = offlineRun(state, awayMs, maxDays);
  if (!run) return null;
  while (!run.step(Infinity));
  return run.report();
}

/**
 * Time away, a slice at a time, so a long absence can be caught up without freezing the page:
 * `step(n)` plays up to n more days and says whether it is done.
 */
export function offlineRun(state: GameState, awayMs: number, maxDays = offlineDays(awayMs)) {
  const days = maxDays;
  if (days < 5 || state.defeat) return null;
  const before = { pop: state.settlers.length, res: { ...state.res } };
  const b0 = state.stats.births;
  const d0 = state.stats.deaths;
  const i0 = state.stats.immigrants;
  const ctx: TickContext = { fx: [] as FxEvent[], rates: emptyRates(), offline: true };
  invalidate(state);
  let done = 0;
  let over = false;
  return {
    days,
    /** Share of the days played so far. */
    progress: () => done / days,
    step(n: number) {
      for (let k = 0; k < n && !over && done < days; k++) {
        ctx.fx.length = 0;
        tick(state, ctx);
        done++;
        if (state.defeat || state.victory) over = true;
      }
      return over || done >= days;
    },
    report: (): OfflineReport => ({
      awayMs,
      days,
      before,
      after: { pop: state.settlers.length, res: { ...state.res } },
      births: state.stats.births - b0,
      deaths: state.stats.deaths - d0,
      arrivals: state.stats.immigrants - i0,
    }),
  };
}
