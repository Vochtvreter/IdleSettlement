import { choose, demolishBuilding, cancelBuilding, setExploreTarget } from '../game/actions';
import { choiceAffordable } from '../game/events';
import {
  BUILDING_DEFS,
  DAYS_PER_SEASON,
  DAYS_PER_YEAR,
  ERAS,
  FEATURE_NAMES,
  JOB_DEFS,
  MAP_H,
  MAP_W,
  RESOURCE_DEFS,
  SEASONS,
  TECH_DEFS,
  TECH_ORDER,
  TERRAIN_NAMES,
} from '../game/data';
import { buildingMult, canPlace, derived } from '../game/derived';
import { getMap, tx, ty } from '../game/map';
import { objectiveProgress } from '../game/objectives';
import { exportSave, importSave, type OfflineReport } from '../game/save';
import { dayOfSeason, eraOf, hasTech, seasonIndex, year } from '../game/state';
import { buildWork, materialLimit, popSummary } from '../game/sim';
import { MILESTONES, milestoneUnlocks } from '../game/decisions';
import { pendingDecision } from './decide';
import type { BuildingId, FxEvent, GameState, LogEntry, ResourceId } from '../game/types';
import { F, RESOURCES } from '../game/types';
import { sfx, setSoundEnabled, soundEnabled } from './audio';
import { costEl, fmt, fmtRate, h, hideTip, img, RES_ICON, tip } from './dom';
import { Guide } from './guide';
import { BUILDING_ICON, Panels, resourceTip, seasonIcon } from './panels';
import type { Game } from './types';

export class UI {
  panels: Panels;
  guide: Guide;
  private resEls = new Map<ResourceId, { el: HTMLElement; amt: HTMLElement; rate: HTMLElement; last: number }>();
  private lastUpdate = 0;
  private lastLog: LogEntry | null = null;
  private toastCount = 0;
  private choiceSig = '';
  private objectiveIdx = -1;
  private inspectTile: number | null = null;
  private selected: number | null = null;
  private wasVictory = false;
  private wasDefeat = false;
  private modalStack: HTMLElement[] = [];
  private speedBtns: HTMLButtonElement[] = [];
  private shift = false;

  constructor(private game: Game) {
    this.panels = new Panels(game);
    this.guide = new Guide(game, this.panels);
    this.buildHud();
    this.bindGlobal();
  }

  /** Reset per-game UI memory (new game / load). */
  attach(state: GameState) {
    this.lastLog = state.log[state.log.length - 1] ?? null;
    this.wasVictory = state.victory;
    this.wasDefeat = state.defeat;
    this.objectiveIdx = -1;
    this.selected = null;
    this.inspectTile = null;
    this.choiceSig = '';
    this.buildResources();
    this.panels.reset();
    this.panels.setTab('decide');
    this.guide.attach(state);
    this.update(true);
  }

  showGameUi(on: boolean) {
    for (const id of ['hud', 'side', 'objective', 'zoom-ctl', 'side-toggle']) document.getElementById(id)!.classList.toggle('hidden', !on);
    if (!on) {
      this.guide.hide();
      document.getElementById('inspector')!.classList.add('hidden');
      document.getElementById('choice')!.classList.add('hidden');
      document.getElementById('place-banner')!.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------- HUD
  private buildHud() {
    (document.querySelector('.brand-flame') as HTMLElement).style.backgroundImage = 'url(./favicon.svg)';
    document.getElementById('settle-name')!.addEventListener('click', () => this.renameModal());
    const speed = document.getElementById('speed')!;
    const speeds: [number, string, string][] = [
      [0, '❚❚', 'Pause (Space)'],
      [1, '1×', 'Normal speed (1)'],
      [2, '2×', 'Fast (2)'],
      [5, '5×', 'Very fast (3)'],
    ];
    for (const [n, label, title] of speeds) {
      const b = h('button', { class: 'icon-btn', title }, label);
      b.dataset.speed = String(n);
      b.addEventListener('click', () => {
        sfx('click');
        if (n === 0) this.game.togglePause();
        else this.game.setSpeed(n);
        this.update(true);
      });
      this.speedBtns.push(b);
      speed.append(b);
    }
    document.getElementById('menu-btn')!.addEventListener('click', () => {
      sfx('click');
      this.menuModal();
    });
    document.getElementById('zoom-in')!.addEventListener('click', () => this.game.view.setZoom(this.game.view.cam.zoom + 1));
    document.getElementById('zoom-out')!.addEventListener('click', () => this.game.view.setZoom(this.game.view.cam.zoom - 1));
    document.getElementById('zoom-home')!.addEventListener('click', () => this.centerHearth());
    const toggle = document.getElementById('side-toggle')!;
    toggle.addEventListener('click', () => {
      const side = document.getElementById('side')!;
      const c = side.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed', c);
      document.getElementById('app')!.classList.toggle('sheet-collapsed', c);
      toggle.innerHTML = c ? '&#9664;' : '&#9654;';
      document.getElementById('zoom-ctl')!.classList.toggle('wide', c);
    });
    // Mobile: tapping the tab bar of a collapsed sheet expands it.
    document.getElementById('tabs')!.addEventListener('click', () => {
      const side = document.getElementById('side')!;
      if (side.classList.contains('collapsed')) toggle.click();
    });
  }

  private buildResources() {
    const wrap = document.getElementById('resources')!;
    wrap.replaceChildren();
    this.resEls.clear();
    for (const r of RESOURCES) {
      const amt = h('div', { class: 'amt' });
      const rate = h('div', { class: 'rate' });
      const el = tip(h('div', { class: 'res' }, img(RES_ICON[r], 2), h('div', { class: 'vals' }, amt, rate)), () => resourceTip(this.game, r));
      wrap.append(el);
      this.resEls.set(r, { el, amt, rate, last: this.game.state.res[r] });
    }
  }

  centerHearth() {
    const hearth = this.game.state.buildings.find((b) => b.type === 'campfire')!;
    this.game.view.centerOn(hearth.x + 0.5, hearth.y + 0.5);
  }

  private updateHud(s: GameState) {
    document.getElementById('settle-name')!.textContent = s.name;
    document.getElementById('era-badge')!.textContent = `${ERAS[eraOf(s)].name}${s.legacy ? ` · Legacy ${s.legacy}` : ''}`;
    const caps = derived(s).caps;
    for (const r of RESOURCES) {
      const e = this.resEls.get(r)!;
      const visible = r === 'food' || r === 'wood' || r === 'knowledge' || s.res[r] > 0 || (r === 'stone' && hasTech(s, 'stone_tools')) || (r === 'hides' && s.techs.length > 0) || (r === 'ore' && hasTech(s, 'mining')) || (r === 'tools' && hasTech(s, 'bronze'));
      e.el.classList.toggle('hidden', !visible);
      const cap = caps[r];
      e.amt.innerHTML = `${fmt(s.res[r])}${isFinite(cap) ? `<span class="cap">/${fmt(cap)}</span>` : ''}`;
      const net = Object.values(this.game.rates.prod[r]).reduce((a, b) => a + b, 0) - Object.values(this.game.rates.cons[r]).reduce((a, b) => a + b, 0);
      e.rate.textContent = `${fmtRate(net)}/d`;
      e.rate.className = 'rate ' + (net > 0.005 ? 'pos' : net < -0.005 ? 'neg' : '');
      e.el.classList.toggle('full', isFinite(cap) && s.res[r] >= cap - 0.5);
      e.el.classList.toggle('empty', (r === 'food' || r === 'wood') && s.res[r] < 1 && net < 0);
      if (s.res[r] - e.last > Math.max(10, e.last * 0.25)) {
        e.el.classList.remove('flash');
        void e.el.offsetWidth;
        e.el.classList.add('flash');
      }
      e.last = s.res[r];
    }
    const season = seasonIndex(s.day);
    const date = document.getElementById('date')!;
    const prog = (dayOfSeason(s.day) - 1) / DAYS_PER_SEASON;
    date.replaceChildren(
      img(seasonIcon(s.day), 2),
      h('div', { class: 'txt' }, h('div', { class: 'd1' }, `Year ${year(s.day)} · ${SEASONS[season]}`), h('div', { class: 'd2' }, `Day ${dayOfSeason(s.day)} of ${DAYS_PER_SEASON}`), h('div', { class: 'season-bar' }, h('i', { style: `width:${prog * 100}%` }))),
    );
    tip(date, `<h4>${SEASONS[season]}, Year ${year(s.day)}</h4>A year has four seasons of ${DAYS_PER_SEASON} days. At normal speed a day passes every second.<div class="sep"></div><span class="muted">Spring & summer: plenty. Autumn: best harvest. Winter: little food grows and everyone needs firewood.</span>`);
    for (const b of this.speedBtns) {
      const n = Number(b.dataset.speed);
      b.classList.toggle('active', n === 0 ? this.game.paused : !this.game.paused && this.game.speed === n);
    }
  }

  // ---------------------------------------------------------------- main update
  update(force = false) {
    const now = performance.now();
    if (!force && now - this.lastUpdate < 200) return;
    this.lastUpdate = now;
    const s = this.game.state;
    this.updateHud(s);
    this.panels.update();
    this.updateObjective(s);
    this.updateChoice(s);
    this.guide.update();
    this.updateInspector();
    this.updateBanner(s);
    this.checkLog(s);
    if (s.victory && !this.wasVictory) {
      this.wasVictory = true;
      this.victoryModal();
    }
    if (s.defeat && !this.wasDefeat) {
      this.wasDefeat = true;
      this.defeatModal();
    }
  }

  handleFx(fx: FxEvent[]) {
    for (const f of fx) {
      if (f.kind === 'era') this.eraBanner(f.era);
    }
  }

  // ---------------------------------------------------------------- objective
  private updateObjective(s: GameState) {
    const el = document.getElementById('objective')!;
    const i = s.objective;
    if (i !== this.objectiveIdx) {
      if (this.objectiveIdx >= 0 && i > this.objectiveIdx) {
        el.classList.remove('complete');
        void el.offsetWidth;
        el.classList.add('complete');
        sfx('discover');
        const unlocks = milestoneUnlocks(this.objectiveIdx);
        if (unlocks.length) this.toast(`Unlocked: ${unlocks.join(', ')}. See the Decide tab.`, 'discovery', 'i_flag', 6000);
      }
      this.objectiveIdx = i;
    }
    const pending = pendingDecision(s);
    const cta = pending
      ? h(
          'button',
          { class: 'cta', onclick: () => this.panels.setTab('decide') },
          img('i_flag', 1),
          pending.tech ? `Ready: ${pending.name}` : `Decide: ${pending.name}`,
        )
      : null;
    if (i >= MILESTONES.length) {
      el.replaceChildren(...[h('div', { class: 'lbl' }, h('span', null, 'SAGA COMPLETE'), h('span', null, '\u2605')), h('div', { class: 'txt' }, 'The Sunspire stands.'), h('div', { class: 'hint' }, 'Your legacy is secure. Keep growing, or begin a new saga from the menu.'), this.modsEl(s)].filter((x): x is HTMLDivElement => !!x));
      return;
    }
    const def = MILESTONES[i];
    const [cur, goal] = objectiveProgress(s, i);
    const unlocks = milestoneUnlocks(i);
    el.replaceChildren(
      ...[
        h('div', { class: 'lbl' }, h('span', null, `MILESTONE ${i + 1} / ${MILESTONES.length}`), h('span', null, goal > 1 && i !== 0 ? `${Math.min(cur, goal)} / ${goal}` : '')),
        h('div', { class: 'txt' }, def.text),
        h('div', { class: 'hint' }, def.hint),
        h('div', { class: 'meter' }, h('i', { style: `width:${Math.min(100, (cur / goal) * 100)}%` })),
        unlocks.length ? h('div', { class: 'reward' }, `Unlocks: ${unlocks.join(', ')}`) : null,
        cta,
        this.modsEl(s),
      ].filter((x): x is HTMLDivElement => !!x),
    );
  }

  private netRate(r: ResourceId) {
    const rt = this.game.rates;
    return Object.values(rt.prod[r]).reduce((a, b) => a + b, 0) - Object.values(rt.cons[r]).reduce((a, b) => a + b, 0);
  }

  private modsEl(s: GameState) {
    const foodNet = this.netRate('food');
    const daysLeft = foodNet < 0 ? Math.floor(s.res.food / -foodNet) : Infinity;
    const lowFood = s.hunger < 0.05 && daysLeft < 12;
    if (!s.modifiers.length && s.hunger < 0.05 && s.cold < 0.05 && !lowFood) return null;
    const wrap = h('div', { class: 'mods' });
    if (lowFood) wrap.append(tip(h('span', { class: 'mod bad' }, `Food runs out in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`), 'At the current rate your stores will be empty soon. Put more people on Gatherers, Hunters or Farmers.'));
    if (s.hunger > 0.05) wrap.append(tip(h('span', { class: 'mod bad' }, 'Starving!'), 'Food has run out. People will die unless you assign more food workers.'));
    if (s.cold > 0.05) wrap.append(tip(h('span', { class: 'mod bad' }, 'Freezing!'), 'Firewood has run out this winter. Assign woodcutters!'));
    for (const m of s.modifiers) {
      const bad = Object.entries(m.effects).some(([k, v]) => (k === 'morale' ? v < 0 : k === 'heating' ? v > 1 : v < 1));
      const days = m.until - s.day;
      const desc = Object.entries(m.effects)
        .map(([k, v]) => (k === 'morale' ? `Morale ${v > 0 ? '+' : ''}${v}` : k === 'heating' ? `Firewood need ×${v}` : k === 'births' ? `Births ×${v}` : `${JOB_DEFS[k as keyof typeof JOB_DEFS]?.plural ?? k} ×${v}`))
        .join(', ');
      wrap.append(tip(h('span', { class: 'mod' + (bad ? ' bad' : '') }, m.label), `<h4>${m.label}</h4>${desc}<div class="sep"></div><span class="muted">${days} days left</span>`));
    }
    return wrap;
  }

  // ---------------------------------------------------------------- choice
  private updateChoice(s: GameState) {
    const el = document.getElementById('choice')!;
    const c = s.choice;
    if (!c) {
      el.classList.add('hidden');
      this.choiceSig = '';
      return;
    }
    const sig = `${c.id}:${c.expires}:${c.options.map((o) => choiceAffordable(s, o)).join()}`;
    const left = c.expires - s.day;
    if (sig !== this.choiceSig) {
      if (!this.choiceSig) sfx('event');
      this.choiceSig = sig;
      const opts = c.options.map((o, i) => {
        const ok = choiceAffordable(s, o);
        const b = h('button', { class: 'btn' + (i === 0 ? ' primary' : ''), disabled: !ok }, h('span', null, o.label), h('span', { style: 'display:flex;gap:8px;align-items:center' }, o.cost ? h('span', { style: 'display:flex;gap:2px;align-items:center;font-size:11px' }, '−', costEl(s, o.cost)) : null, o.gain ? h('span', { style: 'display:flex;gap:2px;align-items:center;font-size:11px' }, '+', costEl({ ...s, res: { ...s.res, ...Object.fromEntries(RESOURCES.map((r) => [r, Infinity])) } }, o.gain)) : null));
        b.addEventListener('click', () => {
          choose(this.game.state, this.game.tickCtx(), i);
          sfx('click');
          this.game.changed();
        });
        return b;
      });
      el.replaceChildren(h('h3', null, c.title), h('p', null, c.text), h('div', { class: 'opts' }, ...opts), h('div', { class: 'timer' }));
      el.classList.remove('hidden');
    }
    const timer = el.querySelector('.timer');
    if (timer) timer.textContent = `If you do not decide within ${left} day${left === 1 ? '' : 's'}, your people will choose “${c.options[c.options.length - 1].label}”.`;
  }

  // ---------------------------------------------------------------- inspector
  hover(tile: number | null) {
    this.inspectTile = tile;
    this.updateInspector();
  }

  select(tile: number | null) {
    this.selected = tile;
    this.game.view.selectedTile = tile;
    this.updateInspector();
  }

  private updateInspector() {
    const el = document.getElementById('inspector')!;
    const s = this.game.state;
    const tile = this.inspectTile ?? this.selected;
    if (tile === null || this.game.modalOpen) {
      el.classList.add('hidden');
      return;
    }
    const map = getMap(s.seed);
    const x = tx(tile);
    const y = ty(tile);
    const explored = !!s.explored[tile];
    const b = s.buildings.find((bb) => bb.x === x && bb.y === y);
    const d = derived(s);
    const parts: (HTMLElement | null)[] = [];
    const sticky = tile === this.selected && this.inspectTile === null;
    if (!explored) {
      parts.push(h('div', { class: 'ih' }, img('i_scout', 3), h('div', null, h('div', { class: 'tt' }, 'Unexplored'), h('div', { class: 'ts' }, `${x}, ${y}`))));
      parts.push(h('div', { class: 'desc' }, s.exploreTarget === tile ? 'Your scouts are heading this way.' : 'Click to send your scouts toward this land. Assign Scouts in the People tab.'));
    } else if (b) {
      const def = BUILDING_DEFS[b.type];
      const p = b.done ? 1 : b.progress / buildWork(s, b.type);
      parts.push(h('div', { class: 'ih' }, img(BUILDING_ICON(s, b.type), 3), h('div', null, h('div', { class: 'tt' }, def.name), h('div', { class: 'ts' }, b.done ? TERRAIN_NAMES[map.terrain[tile]] : `Under construction · ${Math.round(p * 100)}%`))));
      parts.push(h('div', { class: 'desc' }, def.desc));
      if (def.housing) parts.push(h('div', { class: 'row' }, 'Housing', h('b', null, String(def.housing))));
      for (const [j, n] of Object.entries(def.slots ?? {})) parts.push(h('div', { class: 'row' }, `${JOB_DEFS[j as keyof typeof JOB_DEFS].name} slots`, h('b', null, String(n))));
      const mult = buildingMult(s, b);
      if (Math.abs(mult - 1) > 0.001) parts.push(h('div', { class: 'row' }, 'Location bonus', h('b', null, `+${Math.round((mult - 1) * 100)}%`)));
      for (const [r, n] of Object.entries(def.storage ?? {})) parts.push(h('div', { class: 'row' }, `${RESOURCE_DEFS[r as ResourceId].name} storage`, h('b', null, `+${n}`)));
      if (!b.done && def.materials) {
        const stalled = materialLimit(s, b.type) < 0.01;
        parts.push(h('div', { class: 'row' }, 'Materials', h('b', { style: stalled ? 'color:var(--bad)' : '' }, stalled ? 'waiting…' : 'flowing')));
      }
      if (sticky) {
        const acts = h('div', { class: 'acts' });
        if (!b.done) {
          const c = h('button', { class: 'btn small danger' }, 'Cancel (75% refund)');
          c.addEventListener('click', () => {
            cancelBuilding(s, b.id);
            this.select(null);
            this.game.changed();
          });
          acts.append(c);
        } else if (b.type !== 'campfire' && b.type !== 'monument') {
          const dm = h('button', { class: 'btn small danger' }, 'Demolish');
          dm.addEventListener('click', () => {
            if (dm.dataset.confirm) {
              demolishBuilding(s, b.id);
              this.select(null);
              sfx('place');
              this.game.changed();
            } else {
              dm.dataset.confirm = '1';
              dm.textContent = 'Click again to demolish';
            }
          });
          acts.append(dm);
        }
        if (acts.childNodes.length) parts.push(acts);
      }
    } else {
      const t = map.terrain[tile];
      const f = map.feature[tile];
      const claimed = s.claimed.includes(tile);
      const fname = f && !((f === F.Tribe || f === F.Cache) && claimed) ? FEATURE_NAMES[f] : '';
      parts.push(h('div', { class: 'ih' }, img(fname ? (f === F.Ore ? 'i_ore' : f === F.Berries ? 'berries' : f === F.Ruins ? 'ruins' : f === F.Grove ? 'grove' : 'i_star') : 'i_house', 3), h('div', null, h('div', { class: 'tt' }, fname || TERRAIN_NAMES[t]), h('div', { class: 'ts' }, `${fname ? TERRAIN_NAMES[t] + ' · ' : ''}${d.territory[tile] ? 'Your territory' : 'Wilderness'} · ${x}, ${y}`))));
      const featureDesc: Record<number, string> = {
        [F.Berries]: 'Berry thickets inside your territory let more gatherers work efficiently.',
        [F.Game]: 'Hunting lodges within 3 tiles get +30% per herd.',
        [F.Ore]: 'Build a Mine right here for double output.',
        [F.Ruins]: claimed ? 'The ruins have been studied.' : '',
        [F.Grove]: 'A sacred place. It lifts the spirits of your people.',
        [F.Fish]: 'Fishing waters inside your territory let more gatherers work efficiently.',
      };
      if (fname && featureDesc[f]) parts.push(h('div', { class: 'desc' }, featureDesc[f]));
      if (this.game.view.placing) {
        const c = canPlace(s, this.game.view.placing, tile);
        parts.push(h('div', { class: 'row' }, BUILDING_DEFS[this.game.view.placing].name, h('b', { style: c.ok ? '' : 'color:var(--bad)' }, c.ok ? (c.mult > 1.001 ? `OK · +${Math.round((c.mult - 1) * 100)}% bonus` : 'OK') : c.reason)));
      }
    }
    el.replaceChildren(...parts.filter(Boolean) as HTMLElement[]);
    el.classList.remove('hidden');
  }

  tileClick(tile: number, shiftHeld: boolean) {
    const s = this.game.state;
    const view = this.game.view;
    if (view.placing) {
      const type = view.placing;
      const res = this.game.placeAt(tile);
      if (res.ok) {
        sfx('place');
        if (!shiftHeld) this.game.startPlacing(null);
        else if (!this.game.canPlaceAgain(type)) this.game.startPlacing(null);
      } else {
        sfx('error');
        this.toast(res.reason, 'bad', 'i_skull', 2000);
      }
      return;
    }
    if (!s.explored[tile]) {
      setExploreTarget(s, tx(tile), ty(tile));
      sfx('click');
      const scouts = popSummary(s).jobs.scout;
      this.toast(scouts ? 'Your scouts will head toward the marked land.' : 'Marked for exploration — assign Scouts in the People tab.', 'info', 'i_scout', 2500);
      this.game.changed();
      return;
    }
    this.select(this.selected === tile ? null : tile);
  }

  private updateBanner(s: GameState) {
    const el = document.getElementById('place-banner')!;
    const t = this.game.view.placing;
    document.getElementById('app')!.classList.toggle('placing', !!t);
    if (!t) {
      el.classList.add('hidden');
      return;
    }
    const def = BUILDING_DEFS[t];
    el.replaceChildren(img(BUILDING_ICON(s, t), 2), h('div', null, h('div', null, `Place ${def.name}`, def.hint ? h('span', { style: 'color:var(--muted);font-size:12px' }, ` — ${def.hint}`) : null), h('div', { class: 'k' }, 'CLICK A GLOWING TILE · SHIFT-CLICK TO PLACE MORE · ESC / RIGHT-CLICK TO CANCEL')), costEl(s, def.cost));
    el.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- toasts & log
  private checkLog(s: GameState) {
    const log = s.log;
    let start = this.lastLog ? log.lastIndexOf(this.lastLog) + 1 : 0;
    if (this.lastLog && start === 0) start = Math.max(0, log.length - 3);
    const fresh = log.slice(start);
    this.lastLog = log[log.length - 1] ?? null;
    if (!fresh.length) return;
    let births = 0;
    let deaths = 0;
    for (const e of fresh) {
      if (e.kind === 'birth') births++;
      else if (e.kind === 'death') deaths++;
      else if (e.kind === 'discovery') {
        this.toast(e.text, 'discovery', 'i_star', 6000);
        sfx('discover');
      } else if (e.kind === 'build') {
        this.toast(e.text, 'good', 'i_hammer', 2500);
        sfx('build');
      } else if (e.kind === 'bad') {
        this.toast(e.text, 'bad', 'i_skull', 6000);
        sfx('event');
      } else if (e.kind === 'good') {
        this.toast(e.text, 'good', e.text.startsWith('Goal complete') ? 'i_star' : 'i_morale', 4500);
      }
    }
    if (births) sfx('birth');
    if (deaths) {
      sfx('death');
      if (deaths >= 3) this.toast(`${deaths} of your people have died.`, 'bad', 'i_skull', 4000);
    }
  }

  toast(text: string, kind: string, icon = 'i_star', ms = 4000) {
    const wrap = document.getElementById('toasts')!;
    while (wrap.childElementCount >= 4) wrap.firstElementChild!.remove();
    const t = h('div', { class: `toast ${kind}` }, img(icon, 2), h('span', null, text));
    wrap.append(t);
    this.toastCount++;
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 400);
    }, ms);
  }

  // ---------------------------------------------------------------- modals
  openModal(content: (HTMLElement | null)[], opts: { closable?: boolean; onClose?: () => void; wide?: boolean } = {}) {
    hideTip();
    const root = document.getElementById('modal-root')!;
    const modal = h('div', { class: 'modal panel', role: 'dialog', 'aria-modal': 'true', style: opts.wide ? 'width:min(680px,100%)' : '' }, ...content);
    const back = h('div', { class: 'modal-back' }, modal);
    const close = () => {
      back.remove();
      this.modalStack = this.modalStack.filter((m) => m !== back);
      this.game.modalOpen = this.modalStack.length > 0;
      opts.onClose?.();
    };
    (back as HTMLElement & { close?: () => void }).close = close;
    if (opts.closable !== false) back.addEventListener('pointerdown', (e) => e.target === back && close());
    root.append(back);
    this.modalStack.push(back);
    this.game.modalOpen = true;
    return close;
  }

  closeTopModal(): boolean {
    const top = this.modalStack[this.modalStack.length - 1] as (HTMLElement & { close?: () => void }) | undefined;
    if (!top) return false;
    top.close?.();
    return true;
  }

  closeAllModals() {
    while (this.closeTopModal());
  }

  /** Celebrate a new age without stopping the game. */
  eraBanner(era: number) {
    const e = ERAS[era];
    const s = this.game.state;
    const techs = TECH_ORDER.filter((t) => TECH_DEFS[t].era === era && TECH_DEFS[t].advancesTo === undefined).map((t) => TECH_DEFS[t].name);
    const buildings = (Object.keys(BUILDING_DEFS) as BuildingId[]).filter((b) => BUILDING_DEFS[b].tech && TECH_DEFS[BUILDING_DEFS[b].tech!].era === era).map((b) => BUILDING_DEFS[b].name);
    document.querySelector('.era-banner')?.remove();
    const banner = h(
      'div',
      { class: 'era-banner panel' },
      h('div', { class: 'kicker' }, `Year ${year(s.day)} \u00b7 A new age dawns`),
      h('div', { class: 'en' }, e.name),
      h('div', { class: 'eb' }, e.blurb),
      h('div', { class: 'unlocks' }, ...[...techs, ...buildings].map((t) => h('span', null, t))),
    );
    banner.addEventListener('click', () => banner.remove());
    document.getElementById('app')!.append(banner);
    setTimeout(() => {
      banner.classList.add('out');
      setTimeout(() => banner.remove(), 600);
    }, 7000);
    sfx('era');
  }

  private statsGrid(s: GameState) {
    const years = Math.floor(s.day / DAYS_PER_YEAR);
    const mins = Math.round(s.stats.playMs / 60000);
    const cell = (k: string, v: string) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    return h(
      'div',
      { class: 'stats-table' },
      cell('Years passed', String(years)),
      cell('Generations', String(s.stats.maxGen)),
      cell('Peak population', String(s.stats.peakPop)),
      cell('Births / Deaths', `${s.stats.births} / ${s.stats.deaths}`),
      cell('Newcomers welcomed', String(s.stats.immigrants)),
      cell('Land explored', `${Math.round((s.stats.tilesExplored / (MAP_W * MAP_H)) * 100)}%`),
      cell('Buildings raised', String(s.stats.buildingsBuilt)),
      cell('Time played', mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`),
    );
  }

  victoryModal() {
    const s = this.game.state;
    sfx('victory');
    let close = () => {};
    close = this.openModal(
      [
        h('div', { class: 'hero' }, h('img', { src: './favicon.svg', class: 'pix', style: 'width:96px;height:96px;filter:drop-shadow(0 0 20px rgba(255,200,80,.7))' })),
        h('div', { class: 'kicker', style: 'text-align:center' }, 'Victory'),
        h('h2', { style: 'text-align:center' }, 'The Sunspire Stands'),
        h('p', { style: 'text-align:center' }, `From eight wanderers around a fire, the people of ${s.name} have raised a wonder that will outlast the ages. Their story will be told for a thousand years.`),
        this.statsGrid(s),
        h(
          'div',
          { class: 'acts' },
          h('button', { class: 'btn', onclick: () => close() }, 'Keep playing'),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: () => {
                close();
                this.game.newGame({ legacy: s.legacy + 1 });
              },
            },
            `New saga (Legacy ${s.legacy + 1}: +${(s.legacy + 1) * 10}% output)`,
          ),
        ),
      ],
      { closable: false },
    );
  }

  defeatModal() {
    const s = this.game.state;
    let close = () => {};
    close = this.openModal(
      [
        h('div', { class: 'kicker' }, 'The end'),
        h('h2', null, 'The Fire Goes Out'),
        h('p', null, `The last of the people of ${s.name} are gone. Perhaps others will find the ashes of your hearth one day, and remember.`),
        this.statsGrid(s),
        h('p', { style: 'font-size:13px;color:var(--muted)' }, 'Tip: keep enough food for winter, stock firewood, and build homes so families can grow.'),
        h(
          'div',
          { class: 'acts' },
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                close();
                this.game.toTitle();
              },
            },
            'Title screen',
          ),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: () => {
                close();
                this.game.newGame({ legacy: s.legacy });
              },
            },
            'Try again',
          ),
        ),
      ],
      { closable: false },
    );
  }

  offlineModal(r: OfflineReport) {
    const s = this.game.state;
    const mins = Math.round(r.awayMs / 60000);
    const away = mins >= 120 ? `${Math.floor(mins / 60)} hours` : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} minutes`;
    const rows = RESOURCES.filter((k) => Math.abs(r.after.res[k] - r.before.res[k]) >= 1).map((k) => {
      const dlt = r.after.res[k] - r.before.res[k];
      return h('div', { class: 'stat' }, h('div', { class: 'k', style: 'display:flex;gap:4px;align-items:center' }, img(RES_ICON[k], 1), RESOURCE_DEFS[k].name), h('div', { class: 'v', style: `color:${dlt >= 0 ? 'var(--good)' : 'var(--bad)'}` }, `${dlt >= 0 ? '+' : ''}${fmt(dlt)}`));
    });
    let close = () => {};
    close = this.openModal([
      h('div', { class: 'kicker' }, 'While you were away'),
      h('h2', null, `${Math.round((r.days / DAYS_PER_YEAR) * 10) / 10} years passed`),
      h('p', null, `You were gone for ${away}. Life in ${s.name} went on without you.`),
      h(
        'div',
        { class: 'stats-table' },
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Population'), h('div', { class: 'v' }, `${r.before.pop} → ${r.after.pop}`)),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Births · Deaths · Arrivals'), h('div', { class: 'v' }, `${r.births} · ${r.deaths} · ${r.arrivals}`)),
        ...rows,
      ),
      h('p', { style: 'font-size:12px;color:var(--muted)' }, 'Time away passes at half speed, up to 12 years.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', onclick: () => close() }, 'Welcome back')),
    ]);
  }

  renameModal() {
    const s = this.game.state;
    const input = h('input', { value: s.name, maxlength: 24 }) as HTMLInputElement;
    let close = () => {};
    const ok = () => {
      const v = input.value.trim();
      if (v) s.name = v.slice(0, 24);
      close();
      this.game.changed();
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    close = this.openModal([h('h2', null, 'Name your settlement'), h('div', { class: 'field' }, h('label', null, 'NAME'), input), h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, 'Rename'))]);
    setTimeout(() => input.select(), 30);
  }

  menuModal() {
    const s = this.game.state;
    let close = () => {};
    const soundBtn = h('button', { class: 'btn' }, `Sound: ${soundEnabled() ? 'On' : 'Off'}`);
    soundBtn.addEventListener('click', () => {
      setSoundEnabled(!soundEnabled());
      soundBtn.textContent = `Sound: ${soundEnabled() ? 'On' : 'Off'}`;
      this.game.save();
    });
    const tipsLabel = () => `Elder's tips: ${this.guide.enabled ? 'On' : 'Off'}`;
    const tipsBtn = h('button', { class: 'btn', title: 'Short tips that introduce each part of the game as it comes up' }, tipsLabel());
    tipsBtn.addEventListener('click', () => {
      this.guide.setEnabled(!this.guide.enabled);
      tipsBtn.textContent = tipsLabel();
    });
    const restart = h('button', { class: 'btn danger' }, 'Abandon this settlement');
    restart.addEventListener('click', () => {
      if (!restart.dataset.confirm) {
        restart.dataset.confirm = '1';
        restart.textContent = 'Are you sure? Click again';
        return;
      }
      close();
      this.game.newGame({ legacy: s.legacy });
    });
    close = this.openModal([
      h('div', { class: 'kicker' }, `${s.name} · Year ${year(s.day)}`),
      h('h2', null, 'Menu'),
      h(
        'div',
        { class: 'menu-list' },
        h('button', { class: 'btn primary', onclick: () => close() }, 'Resume'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              this.game.save();
              this.toast('Game saved.', 'good', 'i_star', 1800);
              close();
            },
          },
          'Save game',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              close();
              this.howToModal();
            },
          },
          'How to play',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              close();
              this.saveTransferModal();
            },
          },
          'Export / import save',
        ),
        soundBtn,
        tipsBtn,
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              close();
              this.game.save();
              this.game.toTitle();
            },
          },
          'Save & quit to title',
        ),
        restart,
      ),
    ]);
  }

  saveTransferModal() {
    const area = h('textarea', { spellcheck: false }) as HTMLTextAreaElement;
    area.value = exportSave(this.game.state);
    let close = () => {};
    const status = h('div', { style: 'font-size:12px;color:var(--muted);min-height:16px' });
    close = this.openModal([
      h('h2', null, 'Export / import'),
      h('p', { style: 'font-size:14px' }, 'Copy this text to back up your settlement, or paste a save to load it.'),
      h('div', { class: 'field' }, h('label', null, 'SAVE DATA'), area),
      status,
      h(
        'div',
        { class: 'acts' },
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(area.value);
                status.textContent = 'Copied to clipboard.';
              } catch {
                area.select();
                status.textContent = 'Select the text and copy it manually.';
              }
            },
          },
          'Copy',
        ),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              const st = importSave(area.value);
              if (!st) {
                status.textContent = 'That save could not be read.';
                status.style.color = 'var(--bad)';
                return;
              }
              close();
              this.game.loadState(st);
            },
          },
          'Load pasted save',
        ),
        h('button', { class: 'btn', onclick: () => close() }, 'Close'),
      ),
    ]);
  }

  howToModal(onClose?: () => void) {
    let close = () => {};
    close = this.openModal(
      [
        h('div', { class: 'kicker' }, 'Guide'),
        h('h2', null, 'How to play'),
        h(
          'div',
          { class: 'howto' },
          h('p', null, 'Lead a band of eight wanderers from a single campfire to a thriving civilisation, and raise the Sunspire — a wonder for the ages.'),
          h('h3', null, '1 · You decide, the council acts'),
          h('ul', null, h('li', null, 'The game runs by itself: your council assigns work, raises buildings and pursues discoveries every day — even while you are away.'), h('li', null, 'Your job is to set the direction in the Decide tab. Nothing ever waits for you, but good decisions make your people thrive.'), h('li', null, 'New tabs and decisions open up as your settlement grows, and the elder explains each one when it appears. Tips can be turned off in the menu.')),
          h('h3', null, '2 · Choose your path'),
          h('ul', null, h('li', null, 'Start by choosing your people\u2019s Founding Way.'), h('li', null, 'When your settlement is ready for a new age, a Crossroads opens: pick one of three permanent paths to enter it. Five ages lead from Embers to Wonders.')),
          h('h3', null, '3 · Steer with focus and policies'),
          h('ul', null, h('li', null, 'Council Focus decides what comes first: growth, industry, knowledge or exploration.'), h('li', null, 'Policies are trade-offs — rations, working hours, families, strangers and more. They can be changed once per season.'), h('li', null, 'Milestones unlock new policies and council settings as your settlement grows.')),
          h('h3', null, '4 · Survive the seasons'),
          h('ul', null, h('li', null, 'Winter brings little food and bitter cold. The council stockpiles; raise the winter reserve if people go hungry.')),
          h('h3', null, '5 · Explore and build'),
          h('ul', null, h('li', null, 'Click any dark area of the map to send scouts there. Ruins, caches, wanderer camps and sacred groves await.'), h('li', null, 'Want a building somewhere specific? Commission it in the Build tab and click a glowing tile.'), h('li', null, 'Raise the Sunspire to win. Events and choices pop up along the way; they decide themselves if you ignore them.')),
          h('h3', null, 'Controls'),
          h(
            'ul',
            null,
            h('li', null, 'Drag to pan · scroll / pinch to zoom · ', h('span', { class: 'kbd' }, 'WASD'), ' pan'),
            h('li', null, h('span', { class: 'kbd' }, 'Space'), ' pause · ', h('span', { class: 'kbd' }, '1'), h('span', { class: 'kbd' }, '2'), h('span', { class: 'kbd' }, '3'), ' speed · ', h('span', { class: 'kbd' }, 'H'), ' home · ', h('span', { class: 'kbd' }, 'Esc'), ' cancel / menu'),
            h('li', null, 'Shift-click: commission several buildings in a row'),
          ),
          h('p', { style: 'color:var(--muted);font-size:13px' }, 'Your game saves automatically. While you are away, time passes at half speed (up to 12 years).'),
        ),
        h('div', { class: 'acts' }, h('button', { class: 'btn primary', onclick: () => close() }, 'Got it')),
      ],
      { onClose },
    );
  }

  // ---------------------------------------------------------------- input
  private bindGlobal() {
    window.addEventListener('keydown', (e) => {
      this.shift = e.shiftKey;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (document.getElementById('title-screen')!.childElementCount && !document.getElementById('title-screen')!.classList.contains('gone')) return;
      if (e.key === 'Escape') {
        if (this.closeTopModal()) return;
        if (this.game.view.placing) {
          this.game.startPlacing(null);
          return;
        }
        if (this.selected !== null) {
          this.select(null);
          return;
        }
        this.menuModal();
        return;
      }
      if (this.game.modalOpen) return;
      if (e.key === ' ') {
        e.preventDefault();
        this.game.togglePause();
        this.update(true);
      } else if (e.key === '1') this.game.setSpeed(1);
      else if (e.key === '2') this.game.setSpeed(2);
      else if (e.key === '3') this.game.setSpeed(5);
      else if (e.key === 'h' || e.key === 'H') this.centerHearth();
      else if (e.key === 'e' || e.key === 'E') this.panels.setTab('decide');
      else if (e.key === 'p' || e.key === 'P') this.panels.setTab('people');
      else if (e.key === 'b' || e.key === 'B') this.panels.setTab('build');
      else if (e.key === 'r' || e.key === 'R') this.panels.setTab('research');
      else if (e.key === 'c' || e.key === 'C') this.panels.setTab('log');
      this.update(true);
    });
    window.addEventListener('keyup', (e) => (this.shift = e.shiftKey));
  }

  get shiftHeld() {
    return this.shift;
  }
}
