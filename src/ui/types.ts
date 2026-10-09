import type { TickContext } from '../game/sim';
import type { BuildingId, GameState, Rates } from '../game/types';
import type { MapView } from '../render/view';

/** The surface the UI uses to talk to the running game. */
export interface Game {
  state: GameState;
  view: MapView;
  rates: Rates;
  speed: number;
  paused: boolean;
  setSpeed(n: number): void;
  togglePause(): void;
  /** Call after mutating state from the UI so panels refresh immediately. */
  changed(): void;
  tickCtx(): TickContext;
  startPlacing(type: BuildingId | null): void;
  placeAt(tile: number): { ok: true } | { ok: false; reason: string };
  canPlaceAgain(type: BuildingId): boolean;
  loadState(state: GameState): void;
  newGame(opts?: { legacy?: number; seed?: number; name?: string }): void;
  continueGame(): void;
  save(): void;
  toTitle(): void;
  /** Modal dialogs pause the simulation while open. */
  modalOpen: boolean;
}
