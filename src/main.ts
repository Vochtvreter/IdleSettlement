import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/silkscreen/400.css';
import './styles.css';

import { buildingAvailability, placeBuilding } from './game/actions';
import { ERAS } from './game/data';
import { invalidate } from './game/derived';
import { tx, ty } from './game/map';
import { clearSave, hasSave, loadGame, loadPrefs, offlineDays, saveGame, savePrefs, simulateOffline } from './game/save';
import { emptyRates, tick, type TickContext } from './game/sim';
import { eraOf, newGame, year } from './game/state';
import type { BuildingId, FxEvent, GameState, Rates } from './game/types';
import { MapView } from './render/view';
import { setSoundEnabled, sfx, soundEnabled } from './ui/audio';
import { h, initTooltips } from './ui/dom';
import type { Game } from './ui/types';
import { UI } from './ui/ui';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');

class GameApp implements Game {
  state: GameState;
  view: MapView;
  ui!: UI;
  rates: Rates = emptyRates();
  speed = 1;
  paused = false;
  modalOpen = false;
  mode: 'title' | 'game' = 'title';
  private acc = 0;
  private last = performance.now();
  private saveTimer = 0;
  private hiddenAt = 0;
  private pendingFx: FxEvent[] = [];
  private titleT = 0;

  constructor() {
    const prefs = loadPrefs();
    setSoundEnabled(prefs.sound);
    this.speed = prefs.speed || 1;
    this.state = loadGame() ?? newGame(randomSeed());
    const canvas = document.getElementById('map') as HTMLCanvasElement;
    this.view = new MapView(canvas, () => this.state, () => (this.mode === 'title' ? 1 : this.paused || this.modalOpen ? 0 : this.speed), {
      onTileClick: (tile) => {
        if (this.mode !== 'game' || this.modalOpen) return;
        this.ui.tileClick(tile, this.ui.shiftHeld);
      },
      onHover: (tile) => this.mode === 'game' && this.ui.hover(tile),
      onCancel: () => {
        if (this.view.placing) this.startPlacing(null);
        else this.ui.select(null);
      },
    });
    this.ui = new UI(this);
    initTooltips();
    this.view.resetFor(this.state);
    this.view.setZoom(window.innerWidth < 700 ? 2 : 4);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        if (this.mode === 'game') this.save();
      } else {
        this.last = performance.now();
        if (this.mode === 'game' && this.hiddenAt) {
          const away = Date.now() - this.hiddenAt;
          if (away > 60_000) this.catchUp(away);
        }
        this.hiddenAt = 0;
      }
    });
    window.addEventListener('pagehide', () => this.mode === 'game' && this.save());

    this.showTitle();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ Game API
  setSpeed(n: number) {
    this.speed = n;
    this.paused = false;
    savePrefs({ sound: soundEnabled(), speed: n });
  }

  togglePause() {
    this.paused = !this.paused;
  }

  changed() {
    invalidate(this.state);
    this.ui.update(true);
  }

  tickCtx(): TickContext {
    return { fx: this.pendingFx };
  }

  startPlacing(type: BuildingId | null) {
    this.view.placing = type;
    if (type) this.ui.select(null);
    this.ui.update(true);
  }

  placeAt(tile: number) {
    const type = this.view.placing;
    if (!type) return { ok: false as const, reason: 'Nothing selected' };
    const r = placeBuilding(this.state, type, tile, tx(tile), ty(tile));
    this.changed();
    return r;
  }

  canPlaceAgain(type: BuildingId) {
    return buildingAvailability(this.state, type).ok;
  }

  newGame(opts: { legacy?: number; seed?: number; name?: string } = {}) {
    this.ui.closeAllModals();
    const st = newGame(opts.seed ?? randomSeed(), opts.legacy ?? 0);
    if (opts.name) st.name = opts.name;
    this.enterGame(st);
    saveGame(st);
  }

  continueGame() {
    const st = loadGame();
    if (!st) return this.newGame();
    this.enterGame(st);
    const away = Date.now() - st.lastSave;
    if (away > 60_000) this.catchUp(away);
  }

  loadState(st: GameState) {
    this.enterGame(st);
    this.save();
  }

  save() {
    if (this.mode !== 'game') {
      savePrefs({ sound: soundEnabled(), speed: this.speed });
      return;
    }
    saveGame(this.state);
    savePrefs({ sound: soundEnabled(), speed: this.speed });
  }

  toTitle() {
    this.ui.closeAllModals();
    this.startPlacing(null);
    this.state = loadGame() ?? newGame(randomSeed());
    this.view.resetFor(this.state);
    this.view.setZoom(window.innerWidth < 700 ? 2 : 4);
    this.showTitle();
  }

  // ------------------------------------------------------------ internals
  private enterGame(st: GameState) {
    this.state = st;
    this.mode = 'game';
    this.acc = 0;
    this.paused = false;
    this.view.placing = null;
    this.view.resetFor(st);
    this.view.setZoom(window.innerWidth < 700 ? 2 : 3);
    this.previewRates();
    this.ui.showGameUi(true);
    this.ui.attach(st);
    const title = document.getElementById('title-screen')!;
    title.classList.add('gone');
    setTimeout(() => title.replaceChildren(), 650);
  }

  /** Run a throwaway tick on a copy so the HUD shows real rates immediately. */
  private previewRates() {
    try {
      const copy = structuredClone(this.state);
      const ctx: TickContext = { fx: [], rates: emptyRates() };
      tick(copy, ctx);
      this.rates = ctx.rates!;
    } catch {
      this.rates = emptyRates();
    }
  }

  private catchUp(awayMs: number) {
    if (offlineDays(awayMs) < 5) return;
    const report = simulateOffline(this.state, awayMs);
    this.previewRates();
    this.save();
    if (report) this.ui.offlineModal(report);
    this.ui.attach(this.state);
  }

  private step() {
    const ctx: TickContext = { fx: this.pendingFx, rates: emptyRates() };
    tick(this.state, ctx);
    this.rates = ctx.rates!;
  }

  private frame(now: number) {
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(dt, 0.1);
    if (this.mode === 'game') {
      if (!this.paused && !this.modalOpen && !this.state.defeat) {
        this.acc += dt * this.speed;
        let n = 0;
        while (this.acc >= 1 && n < 8) {
          this.step();
          this.acc -= 1;
          n++;
        }
        if (n === 8) this.acc = 0;
        this.state.stats.playMs += dt * 1000;
      }
      this.saveTimer += dt;
      if (this.saveTimer > 20) {
        this.saveTimer = 0;
        this.save();
      }
    } else {
      // Gentle drift over the camp behind the title screen.
      this.titleT += dt;
      const hearth = this.state.buildings.find((b) => b.type === 'campfire')!;
      this.view.centerOn(hearth.x + 0.5 + Math.sin(this.titleT * 0.08) * 4, hearth.y + 0.5 + Math.cos(this.titleT * 0.06) * 2);
    }
    if (this.pendingFx.length) {
      const fx = this.pendingFx.splice(0);
      this.view.handleFx(fx);
      if (this.mode === 'game') this.ui.handleFx(fx);
    }
    this.view.frame(dt);
    if (this.mode === 'game') this.ui.update();
    requestAnimationFrame((t) => this.frame(t));
  }

  private showTitle() {
    this.mode = 'title';
    this.ui.showGameUi(false);
    const title = document.getElementById('title-screen')!;
    title.classList.remove('gone');
    const saved = hasSave() ? loadGame() : null;
    const btns = h('div', { class: 'title-btns' });
    if (saved) {
      btns.append(
        h(
          'button',
          {
            class: 'btn primary big',
            onclick: () => {
              sfx('click');
              this.continueGame();
            },
          },
          'Continue',
        ),
        h('div', { class: 'save-info' }, `${saved.name} · Year ${year(saved.day)} · ${ERAS[eraOf(saved)].name} · ${saved.settlers.length} people${saved.victory ? ' · ★' : ''}`),
      );
    }
    const newBtn = h('button', { class: 'btn big' + (saved ? '' : ' primary') }, 'New Settlement');
    newBtn.addEventListener('click', () => {
      sfx('click');
      if (saved && !newBtn.dataset.confirm) {
        newBtn.dataset.confirm = '1';
        newBtn.textContent = 'Replace current save?';
        return;
      }
      if (saved) clearSave();
      const first = !saved;
      this.newGame({ legacy: saved?.victory ? saved.legacy + 1 : saved?.legacy ?? 0 });
      // The elder's tips introduce the game step by step; without them, show the full guide.
      if (first && !this.ui.guide.enabled) this.ui.howToModal();
    });
    btns.append(
      newBtn,
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            sfx('click');
            this.ui.howToModal();
          },
        },
        'How to Play',
      ),
    );
    title.replaceChildren(
      h(
        'div',
        { class: 'title-box' },
        h('img', { src: './favicon.svg', class: 'title-logo', alt: '' }),
        h('h1', { class: 'title-name' }, 'HEARTHLANDS'),
        h('div', { class: 'title-sub' }, 'From a single campfire to a wonder of the ages.'),
        btns,
        h('div', { class: 'title-foot' }, 'An idle settlement saga · saves automatically · ', DEV ? 'DEV MODE' : 'v1.0'),
      ),
    );
  }
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

const app = new GameApp();
if (DEV) {
  // Handy hooks for testing and screenshots.
  (window as unknown as Record<string, unknown>).hearth = app;
  window.addEventListener('keydown', (e) => {
    if (e.key === '4') app.setSpeed(20);
  });
}
