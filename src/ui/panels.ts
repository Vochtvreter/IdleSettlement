import { buildingAvailability, buildingUnlocked, cancelBuilding, research, setJobTarget, techStatus } from '../game/actions';
import {
  BUILD_ORDER,
  BUILDING_DEFS,
  DAYS_PER_YEAR,
  ERAS,
  JOB_DEFS,
  MAP_H,
  MAP_W,
  RESOURCE_DEFS,
  SEASONS,
  TECH_DEFS,
  TECH_ORDER,
} from '../game/data';
import { derived, jobUnlocked } from '../game/derived';
import { ageOf, eraOf, seasonIndex, year } from '../game/state';
import { buildMaterials, buildWork, careLevel, gathererCapacity, materialLimit, moraleTarget, popSummary, productivity, toolBonus } from '../game/sim';
import { councilWish } from '../game/council';
import { PIN_UNLOCK } from '../game/decisions';
import { tabRevealed, type Tab } from '../game/reveal';
import { buildDecide, decideSignature, pendingDecision } from './decide';
import type { BuildingId, GameState, JobId, LogEntry, ResourceId, TechId } from '../game/types';
import { JOBS } from '../game/types';
import { sfx } from './audio';
import { costEl, escapeHtml, fmt, fmtRate, h, img, RES_ICON, tip } from './dom';
import type { Game } from './types';

export const JOB_ICON: Record<JobId, string> = {
  gatherer: 'i_basket',
  hunter: 'i_spear',
  woodcutter: 'i_axe',
  farmer: 'i_sickle',
  quarrier: 'i_pick',
  miner: 'i_ore',
  smith: 'i_anvil',
  scholar: 'i_knowledge',
  healer: 'i_herb',
  scout: 'i_scout',
  builder: 'i_hammer',
};

export const BUILDING_ICON = (state: GameState, t: BuildingId) => (t === 'hut' ? (eraOf(state) >= 2 ? 'hut1' : 'hut0') : t === 'monument' ? 'shrine' : t);

type Updater = () => void;

const JOB_SOURCE: Partial<Record<JobId, [ResourceId, string][]>> = {
  gatherer: [['food', 'Gatherers']],
  hunter: [
    ['food', 'Hunters'],
    ['hides', 'Hunters'],
  ],
  woodcutter: [['wood', 'Woodcutters']],
  farmer: [['food', 'Farmers']],
  quarrier: [['stone', 'Quarriers']],
  miner: [['ore', 'Miners']],
  smith: [['tools', 'Smiths']],
  scholar: [['knowledge', 'Scholars']],
};

export function seasonName(day: number) {
  return SEASONS[seasonIndex(day)];
}

export function dateLabel(day: number) {
  return `Y${year(day)} ${seasonName(day).slice(0, 3)}`;
}

export class Panels {
  tab: Tab = 'decide';
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private sig = '';
  private updaters: Updater[] = [];
  private logFilter: 'all' | 'life' | 'discovery' | 'events' = 'all';
  private badges: Partial<Record<Tab, HTMLElement>> = {};
  private tabBtns: Partial<Record<Tab, HTMLElement>> = {};
  /** Tabs on show; null until the first update after a game is attached. */
  private revealed: Set<Tab> | null = null;

  constructor(private game: Game) {
    this.body = document.getElementById('tab-body')!;
    this.tabsEl = document.getElementById('tabs')!;
    const tabs: [Tab, string, string][] = [
      ['decide', 'Decide', 'i_flag'],
      ['people', 'People', 'i_people'],
      ['build', 'Build', 'i_hammer'],
      ['research', 'Research', 'i_knowledge'],
      ['log', 'Chronicle', 'i_star'],
    ];
    for (const [id, label, icon] of tabs) {
      const badge = h('span', { class: 'badge hidden' });
      this.badges[id] = badge;
      const b = h(
        'button',
        {
          class: 'tab' + (id === this.tab ? ' active' : ''),
          role: 'tab',
          'data-tab': id,
          onclick: () => {
            sfx('click');
            this.setTab(id);
          },
        },
        img(icon, 2),
        label,
        badge,
      );
      this.tabBtns[id] = b;
      this.tabsEl.append(b);
    }
  }

  /** Forget which tabs were on show (new game / load), so they do not all announce themselves. */
  reset() {
    this.revealed = null;
  }

  setTab(t: Tab) {
    if (!tabRevealed(this.game.state, t)) return;
    this.tab = t;
    this.tabBtns[t]!.classList.remove('fresh');
    for (const el of this.tabsEl.querySelectorAll('.tab')) el.classList.toggle('active', (el as HTMLElement).dataset.tab === t);
    this.sig = '';
    this.body.scrollTop = 0;
    const side = document.getElementById('side')!;
    if (side.classList.contains('collapsed')) document.getElementById('side-toggle')!.click();
    this.update();
  }

  update() {
    const s = this.game.state;
    this.updateBadges(s);
    const sig = this.signature(s);
    if (sig !== this.sig) {
      this.sig = sig;
      const scroll = this.body.scrollTop;
      this.body.replaceChildren();
      this.updaters = [];
      switch (this.tab) {
        case 'decide':
          buildDecide(this.game, this.body, this.updaters);
          break;
        case 'people':
          this.buildPeople(s);
          break;
        case 'build':
          this.buildBuild(s);
          break;
        case 'research':
          this.buildResearch(s);
          break;
        case 'log':
          this.buildLog(s);
          break;
      }
      this.body.scrollTop = scroll;
    }
    for (const u of this.updaters) u();
  }

  private updateTabs(s: GameState) {
    const first = !this.revealed;
    const revealed = this.revealed ?? new Set<Tab>();
    for (const [id, btn] of Object.entries(this.tabBtns) as [Tab, HTMLElement][]) {
      const on = tabRevealed(s, id);
      btn.classList.toggle('hidden', !on);
      if (on && !revealed.has(id)) {
        revealed.add(id);
        // A newly opened tab glows until it is visited.
        if (!first) btn.classList.add('fresh');
      }
      if (!on) btn.classList.remove('fresh');
    }
    this.revealed = revealed;
  }

  private updateBadges(s: GameState) {
    this.updateTabs(s);
    const ready = s.council.research ? 0 : TECH_ORDER.filter((t) => !t.startsWith('era_') && techStatus(s, t).ok).length;
    const rb = this.badges.research!;
    rb.textContent = String(ready);
    rb.classList.toggle('hidden', ready === 0 || this.tab === 'research');
    const idle = s.council.jobs ? 0 : popSummary(s).idle;
    const pb = this.badges.people!;
    pb.textContent = String(idle);
    pb.classList.toggle('hidden', idle === 0 || this.tab === 'people');
    const db = this.badges.decide!;
    db.textContent = '!';
    db.classList.toggle('hidden', !pendingDecision(s) || this.tab === 'decide');
  }

  private signature(s: GameState): string {
    switch (this.tab) {
      case 'decide':
        return decideSignature(s);
      case 'people':
        return `p:${JOBS.filter((j) => jobUnlocked(s, j)).join(',')}:${s.settlers.length > 0}:${s.council.jobs}`;
      case 'build':
        return `b:${s.techs.length}:${eraOf(s)}:${s.buildings.filter((b) => !b.done).map((b) => b.id).join(',')}:${this.game.view.placing}:${s.council.build}`;
      case 'research':
        return `r:${s.techs.length}:${eraOf(s)}:${s.council.research}:${s.pin}:${s.objective > PIN_UNLOCK}`;
      case 'log':
        return `l:${s.log.length}:${s.log[s.log.length - 1]?.day}:${this.logFilter}`;
    }
  }

  // ---------------------------------------------------------------- people
  private buildPeople(s: GameState) {
    const b = this.body;
    const d = () => derived(this.game.state);
    const st = () => this.game.state;

    b.append(h('div', { class: 'section-title' }, 'Your People'));
    const grid = h('div', { class: 'stat-grid' });
    const stat = (k: string, tipFn: () => string) => {
      const v = h('div', { class: 'v' });
      const el = tip(h('div', { class: 'stat' }, h('div', { class: 'k' }, k), v), tipFn);
      grid.append(el);
      return { el, v };
    };
    const pop = stat('Population', () => `<h4>Population</h4>Everyone in ${escapeHtml(st().name)}.<br><span class="muted">Peak: ${st().stats.peakPop} · Births: ${st().stats.births} · Deaths: ${st().stats.deaths}</span>`);
    const house = stat('Housing', () => `<h4>Housing</h4>Families only have children when there is free housing. Overcrowding lowers morale and spreads illness.<br><span class="muted">Build Huts${eraOf(st()) >= 2 ? ' and Stone Houses' : ''}.</span>`);
    const morale = stat('Morale', () => this.moraleTip());
    const meter = h('div', { class: 'meter' }, h('i'));
    morale.el.append(meter);
    const kids = stat('Children', () => `<h4>Children</h4>Children eat but do not work. They come of age at 13.`);
    const elders = stat('Elders', () => `<h4>Elders</h4>Elders (52+) retire from work but share their wisdom (+knowledge).`);
    const gen = stat('Generation', () => `<h4>Generations</h4>How many generations have been born since the founders lit the first fire.`);
    b.append(grid);

    const idleNote = h('div', { class: 'idle-note hidden' });
    const manual = !s.council.jobs;
    b.append(h('div', { class: 'section-title' }, 'Work'));
    if (!manual) b.append(h('div', { class: 'council-note' }, 'The council assigns work each day following your focus and policies. ', h('button', { class: 'link-btn', onclick: () => this.setTab('decide') }, 'Change direction →')));
    b.append(idleNote);

    const jobsWrap = h('div');
    b.append(jobsWrap);
    for (const j of JOBS) {
      if (!jobUnlocked(s, j)) continue;
      const def = JOB_DEFS[j];
      const count = h('div', { class: 'count' });
      const sub = h('div', { class: 'sub' });
      const minus = h('button', { class: 'icon-btn', title: 'Remove (Shift: 5)' }, '−');
      const plus = h('button', { class: 'icon-btn', title: 'Add (Shift: 5)' }, '+');
      const change = (delta: number) => (e: MouseEvent) => {
        const n = e.shiftKey ? 5 : 1;
        const g = this.game.state;
        const cur = Math.min(g.jobTargets[j], d().slots[j]);
        setJobTarget(g, j, cur + delta * n);
        sfx('click');
        this.game.changed();
      };
      minus.addEventListener('click', change(-1));
      plus.addEventListener('click', change(1));
      const row = h(
        'div',
        { class: 'job', style: `--jc:${def.color}` },
        img(JOB_ICON[j], 2),
        tip(h('div', null, h('div', { class: 'name' }, def.plural), sub), () => this.jobTip(j)),
        manual ? h('div', { class: 'ctl' }, minus, count, plus) : h('div', { class: 'ctl' }, count),
      );
      jobsWrap.append(row);
      this.updaters.push(() => {
        const g = this.game.state;
        const ps = popSummary(g);
        const slots = d().slots[j];
        const target = Math.min(g.jobTargets[j], slots);
        const have = ps.jobs[j];
        count.innerHTML = `${have}<span class="t">/${target}${isFinite(slots) ? ` · ${slots}` : ''}</span>`;
        count.classList.toggle('short', have < target);
        tip(count, `<h4>${def.plural}</h4>${have} working · ${target} wanted${isFinite(slots) ? ` · ${slots} slots from buildings` : ''}`);
        minus.disabled = target <= 0;
        plus.disabled = target >= slots || (ps.idle === 0 && have >= target && target >= ps.adults);
        sub.textContent = this.jobOutputText(j, have);
      });
    }

    const roster = h('details', { class: 'roster-wrap' }, h('summary', { class: 'section-title', style: 'cursor:pointer' }, 'Roster'));
    const rosterBody = h('div', { class: 'roster' });
    roster.append(rosterBody);
    roster.addEventListener('toggle', () => this.fillRoster(rosterBody));
    b.append(roster);

    this.updaters.push(() => {
      const g = this.game.state;
      const ps = popSummary(g);
      const dd = d();
      pop.v.innerHTML = `${ps.total}`;
      house.v.innerHTML = `${ps.total}<small>/${dd.housing}</small>`;
      house.el.style.borderColor = ps.total >= dd.housing ? '#a36a2a' : '';
      morale.v.textContent = `${Math.round(g.morale)}`;
      const mi = meter.firstChild as HTMLElement;
      mi.style.width = `${g.morale}%`;
      mi.style.background = g.morale > 60 ? 'var(--good)' : g.morale > 35 ? 'var(--gold)' : 'var(--bad)';
      kids.v.textContent = String(ps.children);
      elders.v.textContent = String(ps.elders);
      gen.v.textContent = String(g.stats.maxGen);
      if (ps.idle > 0 && !g.council.jobs) {
        idleNote.classList.remove('hidden');
        idleNote.textContent = `${ps.idle} adult${ps.idle > 1 ? 's are' : ' is'} idle — they forage a little and help builders. Assign them with +.`;
      } else idleNote.classList.add('hidden');
      if (roster.open && Math.random() < 0.2) this.fillRoster(rosterBody);
    });
  }

  private fillRoster(el: HTMLElement) {
    const s = this.game.state;
    const list = [...s.settlers].sort((a, b) => a.born - b.born).slice(0, 60);
    el.replaceChildren(h('div', { class: 'h' }, 'NAME'), h('div', { class: 'h' }, 'ROLE'), h('div', { class: 'h', style: 'text-align:right' }, 'AGE'));
    for (const p of list) {
      const age = Math.floor(ageOf(s, p));
      const role = p.job ? JOB_DEFS[p.job].name : age < 13 ? 'Child' : age >= 52 ? 'Elder' : 'Idle';
      el.append(h('div', null, `${p.name} `, h('span', { style: 'color:var(--dim);font-size:11px' }, `gen ${p.gen}`)), h('div', { class: 'j', style: `color:${p.job ? JOB_DEFS[p.job].color : 'var(--muted)'}` }, role), h('div', { class: 'a' }, String(age)));
    }
    if (s.settlers.length > list.length) el.append(h('div', { style: 'grid-column:1/-1;color:var(--dim);font-size:12px;padding-top:4px' }, `…and ${s.settlers.length - list.length} more`));
  }

  private jobOutputText(j: JobId, n: number): string {
    const s = this.game.state;
    const r = this.game.rates;
    const src = JOB_SOURCE[j];
    if (src) {
      if (!n) return `${Object.entries(JOB_DEFS[j].output)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')} each (base)`;
      return src.map(([res, key]) => `${fmtRate((r.prod[res][key] ?? 0) / n)} ${res}`).join(' · ') + ' each/day';
    }
    if (j === 'healer') return `Care: ${Math.round(careLevel(s, n) * 100)}% of the people`;
    if (j === 'scout') {
      const left = s.explored.length - s.stats.tilesExplored;
      return left <= 0 ? 'The whole land is known' : `${Math.round((s.stats.tilesExplored / (MAP_W * MAP_H)) * 100)}% of the land explored`;
    }
    if (j === 'builder') {
      const sites = derived(s).sites.length;
      return sites ? `${sites} site${sites > 1 ? 's' : ''} under construction` : 'Nothing to build — place something!';
    }
    return '';
  }

  private jobTip(j: JobId): string {
    const s = this.game.state;
    const def = JOB_DEFS[j];
    let extra = '';
    if (j === 'gatherer') extra = `<div class="sep"></div><span class="muted">The land around you supports about ${gathererCapacity(s)} gatherers before yields drop. Berry thickets and fishing waters in your territory raise this.</span>`;
    if (def.usesTools) extra += `<div class="sep"></div><span class="muted">Tools in stock: ${toolBonus(s) > 1 ? `<b style="color:var(--good)">+${Math.round((toolBonus(s) - 1) * 100)}% output</b>` : 'none (no bonus)'}</span>`;
    if (def.input) extra += `<div class="sep"></div><span class="muted">Consumes ${Object.entries(def.input).map(([k, v]) => `${v} ${k}`).join(' + ')} per smith per day.</span>`;
    return `<h4>${def.name}</h4>${def.desc}${extra}<div class="sep"></div><span class="muted">Morale: ×${productivity(s).toFixed(2)} output</span>`;
  }

  private moraleTip(): string {
    const s = this.game.state;
    const target = moraleTarget(s, s.hunger, s.cold);
    const mods = s.modifiers.filter((m) => m.effects.morale).map((m) => `<div class="tl ${m.effects.morale > 0 ? 'pos' : 'neg'}"><span>${m.label}</span><span>${m.effects.morale > 0 ? '+' : ''}${m.effects.morale}</span></div>`);
    return `<h4>Morale ${Math.round(s.morale)} → ${Math.round(target)}</h4>Happy people work harder (×${productivity(s).toFixed(2)}) and raise more children. Hunger, cold and overcrowding hurt; temples, festivals and sacred groves help.${mods.length ? '<div class="sep"></div>' + mods.join('') : ''}${s.hunger > 0.05 ? '<div class="tl neg"><span>Hunger</span><span>−</span></div>' : ''}${s.cold > 0.05 ? '<div class="tl neg"><span>Cold</span><span>−</span></div>' : ''}`;
  }

  // ---------------------------------------------------------------- build
  private buildBuild(s: GameState) {
    const b = this.body;
    const sites = s.buildings.filter((x) => !x.done);
    if (sites.length) {
      b.append(h('div', { class: 'section-title' }, `Construction (${sites.length})`));
      for (const site of sites) {
        const def = BUILDING_DEFS[site.type];
        const bar = h('i');
        const info = h('div', { class: 'ts', style: 'font-family:var(--mono);font-size:9px;color:var(--muted)' });
        const cancel = h('button', { class: 'btn small danger', title: 'Cancel (refunds 75%)' }, '✕');
        cancel.addEventListener('click', () => {
          cancelBuilding(this.game.state, site.id);
          sfx('click');
          this.game.changed();
        });
        const row = h('div', { class: 'queue-item' }, img(BUILDING_ICON(s, site.type), 2), h('div', null, h('div', null, def.name), h('div', { class: 'bar' }, bar), info), cancel);
        row.addEventListener('click', (e) => {
          if (e.target === cancel) return;
          this.game.view.centerOn(site.x + 0.5, site.y + 0.5);
        });
        row.style.cursor = 'pointer';
        b.append(row);
        this.updaters.push(() => {
          const g = this.game.state;
          const p = site.progress / buildWork(g, site.type);
          bar.style.width = `${Math.min(100, p * 100)}%`;
          const builders = popSummary(g).jobs.builder;
          const stalled = def.materials && materialLimit(g, site.type) < 0.01;
          const first = g.buildings.find((x) => !x.done)?.id === site.id;
          info.textContent = stalled ? 'Waiting for materials…' : first ? (builders ? `${Math.round(p * 100)}% · ${builders} builder${builders > 1 ? 's' : ''}` : `${Math.round(p * 100)}% · assign builders!`) : `${Math.round(p * 100)}% · queued`;
          info.style.color = stalled || (!builders && first) ? 'var(--ember)' : '';
        });
      }
    }

    b.append(h('div', { class: 'section-title' }, s.council.build ? 'Commission a building' : 'Buildings'));
    if (s.council.build) {
      const wish = h('div', { class: 'council-note' });
      b.append(wish);
      this.updaters.push(() => {
        const w = councilWish(this.game.state);
        wish.textContent = `The council builds on its own${w ? ` — next up: ${BUILDING_DEFS[w.type].name}${w.waiting ? ' (gathering materials)' : ''}` : ''}. You can also commission any building yourself: pick one, then click a glowing tile.`;
      });
    } else b.append(h('div', { style: 'font-size:12px;color:var(--muted);margin:-2px 0 8px' }, 'Pick a building, then click a highlighted tile inside your territory. Gold tiles give adjacency bonuses.'));
    const cards = h('div', { class: 'cards' });
    b.append(cards);
    for (const t of BUILD_ORDER) {
      const def = BUILDING_DEFS[t];
      const unlocked = buildingUnlocked(s, t);
      const nextEraLocked = def.tech && TECH_DEFS[def.tech].era > eraOf(s) + 1;
      if (nextEraLocked) continue;
      const cnt = h('div', { class: 'cnt' });
      const costHolder = h('div');
      const req = unlocked ? null : h('div', { class: 'req' }, `Requires ${TECH_DEFS[def.tech!].name}`);
      const card = h(
        'button',
        { class: 'card' + (unlocked ? '' : ' locked') + (this.game.view.placing === t ? ' selected' : '') },
        h('div', { class: 'top' }, img(BUILDING_ICON(s, t), 2), h('div', null, h('div', { class: 'nm' }, def.name), cnt)),
        h('div', { class: 'benefit' }, def.benefit),
        costHolder,
        req,
      );
      tip(card, () => {
        const g = this.game.state;
        const extra = def.materials ? `<div class="sep"></div>As it rises it consumes: ${Object.entries(buildMaterials(g, t)!).map(([k, v]) => `${fmt(v ?? 0)} ${k}`).join(', ')}.` : '';
        return `<h4>${def.name}</h4>${def.desc}${def.hint ? `<div class="sep"></div><span class="muted">${def.hint}</span>` : ''}${extra}${!unlocked ? `<div class="sep"></div><span style="color:var(--bad)">Requires ${TECH_DEFS[def.tech!].name}</span>` : ''}<div class="sep"></div><span class="muted">Work: ${buildWork(g, t)} · Built: ${derived(g).counts[t] ?? 0}</span>`;
      });
      card.addEventListener('click', () => {
        if (!unlocked) return;
        const avail = buildingAvailability(this.game.state, t);
        if (!avail.ok) {
          sfx('error');
          return;
        }
        sfx('click');
        this.game.startPlacing(this.game.view.placing === t ? null : t);
      });
      cards.append(card);
      this.updaters.push(() => {
        const g = this.game.state;
        const n = g.buildings.filter((x) => x.type === t).length;
        cnt.textContent = def.max ? `${n}/${def.max} built` : n ? `${n} built` : '';
        costHolder.replaceChildren(costEl(g, def.cost));
        const ok = buildingAvailability(g, t).ok;
        card.classList.toggle('unaffordable', unlocked && !ok);
        card.style.opacity = unlocked ? (ok ? '1' : '0.72') : '';
      });
    }
  }

  // ---------------------------------------------------------------- research
  private buildResearch(s: GameState) {
    const b = this.body;
    const era = eraOf(s);
    const kn = h('div', { style: 'font-size:14px;display:flex;align-items:center;gap:8px;margin-bottom:6px' });
    b.append(kn);
    this.updaters.push(() => {
      const g = this.game.state;
      const rate = Object.values(this.game.rates.prod.knowledge).reduce((a, x) => a + x, 0);
      kn.replaceChildren(img('i_knowledge', 2), h('span', null, `${fmt(g.res.knowledge)} knowledge`), h('span', { style: 'color:var(--good);font-family:var(--mono);font-size:10px' }, `${fmtRate(rate)}/day`));
    });
    const canPin = s.objective > PIN_UNLOCK;
    if (s.council.research) {
      b.append(
        h(
          'div',
          { class: 'council-note' },
          canPin
            ? 'The council researches on its own, following your focus. Mark a discovery as next to have it save knowledge for that one first.'
            : 'The council researches on its own, following your focus. (Choosing the next discovery yourself unlocks with your first discovery.)',
        ),
      );
    }
    for (let e = Math.min(4, era + 1); e >= 0; e--) {
      const future = e > era;
      const techs = TECH_ORDER.filter((t) => TECH_DEFS[t].era === e && TECH_DEFS[t].advancesTo === undefined);
      const allDone = techs.every((t) => s.techs.includes(t));
      if (allDone && !future) {
        b.append(h('div', { class: 'era-head future' }, h('div', { class: 'n' }, `\u2714 ${ERAS[e].name}`), h('div', { class: 'b' }, `All ${techs.length} discoveries made.`)));
        continue;
      }
      b.append(h('div', { class: 'era-head' + (future ? ' future' : '') }, h('div', { class: 'n' }, (future ? '\u{1F512} ' : '') + ERAS[e].name), h('div', { class: 'b' }, future ? 'Choose the next path in the Decide tab to reach this age.' : ERAS[e].blurb)));
      if (future) {
        b.append(h('div', { style: 'font-size:12px;color:var(--dim);margin:0 4px 8px' }, techs.map((t) => TECH_DEFS[t].name).join(' \u00b7 ')));
        continue;
      }
      const rank = (t: TechId) => (s.techs.includes(t) ? 2 : s.pin === t ? -1 : 0);
      techs.sort((a, c) => rank(a) - rank(c));
      for (const t of techs) b.append(this.techCard(t));
    }
  }

  private techCard(t: TechId) {
    const def = TECH_DEFS[t];
    const s = this.game.state;
    const known = s.techs.includes(t);
    const auto = s.council.research;
    const pinned = s.pin === t;
    const why = h('div', { class: 'why' });
    const canPin = s.objective > PIN_UNLOCK;
    const btn = auto
      ? h('button', { class: 'btn small ' + (pinned ? 'primary' : ''), disabled: !canPin, title: canPin ? '' : 'Unlocks with your first discovery' }, pinned ? 'Next \u2714' : 'Make next')
      : h('button', { class: 'btn small good' }, 'Discover');
    const costBox = h('div', { style: 'grid-column:1/-1' });
    const card = h(
      'div',
      { class: 'tech' + (known ? ' done' : '') + (pinned ? ' era' : '') },
      h('div', { class: 'tn' }, def.name),
      known ? h('span') : btn,
      h('div', { class: 'td' }, def.desc),
      known ? null : costBox,
      known ? null : why,
    );
    if (!known) {
      btn.addEventListener('click', () => {
        const g = this.game.state;
        if (auto) {
          g.pin = g.pin === t ? null : t;
          sfx('click');
          this.game.changed();
          return;
        }
        const r = research(g, t, this.game.tickCtx().fx);
        if (r.ok) {
          sfx('research');
          this.game.changed();
        } else sfx('error');
      });
      this.updaters.push(() => {
        const g = this.game.state;
        const st = techStatus(g, t);
        if (!auto) btn.disabled = !st.ok;
        card.classList.toggle('ready', st.ok);
        costBox.replaceChildren(costEl(g, def.cost));
        const reasons: string[] = [];
        const missing = (def.requires ?? []).filter((r) => !g.techs.includes(r));
        if (missing.length) reasons.push(`Needs ${missing.map((m) => TECH_DEFS[m].name).join(', ')}`);
        why.textContent = reasons.join(' \u00b7 ');
      });
    }
    return card;
  }

  // ---------------------------------------------------------------- chronicle
  private buildLog(s: GameState) {
    const b = this.body;
    const years = Math.floor(s.day / DAYS_PER_YEAR);
    const grid = h(
      'div',
      { class: 'stat-grid', style: 'margin-bottom:10px' },
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Years'), h('div', { class: 'v' }, String(years))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Births'), h('div', { class: 'v' }, String(s.stats.births))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Deaths'), h('div', { class: 'v' }, String(s.stats.deaths))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Arrivals'), h('div', { class: 'v' }, String(s.stats.immigrants))),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Explored'), h('div', { class: 'v' }, `${Math.round((s.stats.tilesExplored / (MAP_W * MAP_H)) * 100)}%`)),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Buildings'), h('div', { class: 'v' }, String(s.buildings.filter((x) => x.done).length))),
    );
    b.append(grid);
    const filters: [typeof this.logFilter, string][] = [
      ['all', 'All'],
      ['life', 'Births & deaths'],
      ['discovery', 'Discoveries'],
      ['events', 'Events'],
    ];
    b.append(
      h(
        'div',
        { class: 'filters' },
        ...filters.map(([id, label]) =>
          h(
            'button',
            {
              class: 'chip' + (this.logFilter === id ? ' on' : ''),
              onclick: () => {
                this.logFilter = id;
                this.sig = '';
                this.update();
              },
            },
            label,
          ),
        ),
      ),
    );
    const match = (e: LogEntry) => {
      switch (this.logFilter) {
        case 'life':
          return e.kind === 'birth' || e.kind === 'death';
        case 'discovery':
          return e.kind === 'discovery' || e.kind === 'era' || e.kind === 'build';
        case 'events':
          return e.kind === 'good' || e.kind === 'bad' || e.kind === 'info';
        default:
          return true;
      }
    };
    const entries = s.log.filter(match).slice(-150).reverse();
    for (const e of entries) b.append(h('div', { class: `log-entry ${e.kind}` }, h('div', { class: 'when' }, dateLabel(e.day)), h('div', { class: 'txt' }, e.text)));
    if (!entries.length) b.append(h('div', { style: 'color:var(--dim);font-size:13px' }, 'Nothing recorded yet.'));
  }
}

export function resourceTip(game: Game, r: ResourceId): string {
  const s = game.state;
  const def = RESOURCE_DEFS[r];
  const cap = derived(s).caps[r];
  const prod = Object.entries(game.rates.prod[r]).filter(([, v]) => Math.abs(v) > 0.001);
  const cons = Object.entries(game.rates.cons[r]).filter(([, v]) => Math.abs(v) > 0.001);
  const net = prod.reduce((a, [, v]) => a + v, 0) - cons.reduce((a, [, v]) => a + v, 0);
  const lines = [
    ...prod.map(([k, v]) => `<div class="tl pos"><span>${k}</span><span>+${v.toFixed(2)}</span></div>`),
    ...cons.map(([k, v]) => `<div class="tl neg"><span>${k}</span><span>−${v.toFixed(2)}</span></div>`),
  ];
  let note = '';
  if (r === 'food' && seasonIndex(s.day) !== 3) note = '<div class="sep"></div><span class="muted">Winter brings poor foraging and no harvest — keep a stockpile.</span>';
  if (r === 'wood') note = '<div class="sep"></div><span class="muted">In winter everyone burns firewood to stay warm.</span>';
  if (r === 'tools') note = `<div class="sep"></div><span class="muted">${toolBonus(s) > 1 ? `Labourers +${Math.round((toolBonus(s) - 1) * 100)}% while tools are in stock.` : 'Labourers get a bonus while tools are in stock.'}</span>`;
  return `<h4>${def.name} ${fmt(s.res[r])}${isFinite(cap) ? ` / ${fmt(cap)}` : ''}</h4>${def.desc}${lines.length ? '<div class="sep"></div>' + lines.join('') : ''}<div class="sep"></div><div class="tl ${net >= 0 ? 'pos' : 'neg'}"><span>Net per day</span><span>${fmtRate(net)}</span></div>${note}`;
}

export function seasonIcon(day: number) {
  return ['i_spring', 'i_summer', 'i_autumn', 'i_winter'][seasonIndex(day)];
}

export { RES_ICON };
