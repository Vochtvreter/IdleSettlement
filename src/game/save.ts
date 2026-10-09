import { MAP_H, MAP_W } from './data';
import { invalidate } from './derived';
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

/** Compact the explored array into a string for storage. */
function packExplored(e: number[]) {
  let s = '';
  for (let i = 0; i < e.length; i += 4) s += ((e[i] ? 1 : 0) | (e[i + 1] ? 2 : 0) | (e[i + 2] ? 4 : 0) | (e[i + 3] ? 8 : 0)).toString(16);
  return s;
}

function unpackExplored(s: string) {
  const out = new Array(MAP_W * MAP_H).fill(0);
  for (let i = 0; i < s.length; i++) {
    const v = parseInt(s[i], 16);
    for (let b = 0; b < 4; b++) if (i * 4 + b < out.length) out[i * 4 + b] = v & (1 << b) ? 1 : 0;
  }
  return out;
}

export function serialize(state: GameState): string {
  return JSON.stringify({ ...state, explored: packExplored(state.explored) });
}

export function deserialize(json: string): GameState | null {
  try {
    const raw = JSON.parse(json);
    if (!raw || typeof raw !== 'object' || raw.version !== SAVE_VERSION) return null;
    raw.explored = typeof raw.explored === 'string' ? unpackExplored(raw.explored) : raw.explored;
    for (const r of RESOURCES) if (typeof raw.res[r] !== 'number' || !isFinite(raw.res[r])) raw.res[r] = 0;
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

/** Offline progress runs at half speed, capped at 12 in-game years. */
export const OFFLINE_RATE = 0.5;
export const OFFLINE_MAX_DAYS = 480;

export function offlineDays(awayMs: number) {
  return Math.min(OFFLINE_MAX_DAYS, Math.floor((awayMs / 1000) * OFFLINE_RATE));
}

export function simulateOffline(state: GameState, awayMs: number, maxDays = offlineDays(awayMs)): OfflineReport | null {
  const days = maxDays;
  if (days < 5 || state.defeat) return null;
  const before = { pop: state.settlers.length, res: { ...state.res } };
  const b0 = state.stats.births;
  const d0 = state.stats.deaths;
  const i0 = state.stats.immigrants;
  const ctx: TickContext = { fx: [] as FxEvent[], rates: emptyRates(), offline: true };
  invalidate(state);
  for (let i = 0; i < days; i++) {
    ctx.fx.length = 0;
    tick(state, ctx);
    if (state.defeat || state.victory) break;
  }
  return {
    awayMs,
    days,
    before,
    after: { pop: state.settlers.length, res: { ...state.res } },
    births: state.stats.births - b0,
    deaths: state.stats.deaths - d0,
    arrivals: state.stats.immigrants - i0,
  };
}
