import { buildingAvailability, buildingUnlocked, cancelBuilding, prioritise, research, setJobTarget, techStatus, worksQueue } from '../game/actions';
import {
  BIOMES,
  BUILD_ORDER,
  BUILDING_DEFS,
  TIERS,
  DAYS_PER_YEAR,
  ERAS,
  JOB_DEFS,
  MAP_H,
  MAP_W,
  RESOURCE_DEFS,
  SEASONS,
  TECH_DEFS,
  TECH_ORDER,
  TRAFFIC_PAVE,
  TRAFFIC_ROUTE,
  TRAFFIC_TRAIL,
} from '../game/data';
import { census, derived, jobUnlocked, type Link } from '../game/derived';
import { fellLeft, siteStage, sizeOf } from '../game/land';
import { getMap, idx, tx, ty } from '../game/map';
import { expeditionCost, findSites, launchPioneers, launchVoyage, nextTierNeeds, openRoute, pairKey, pioneerStatus, routeIncome, routeOptions, siteCalling, siteProfile, ties, townTitle, type SiteChoice } from '../game/realm';
import { partyStatus } from '../game/scouting';
import { ageOf, eraOf, hasTech, seasonIndex, year } from '../game/state';
import { buildMaterials, buildWork, careLevel, gathererCapacity, materialLimit, moraleTarget, popSummary, productivity, TOOL_LIFE, toolBonus, toolShare, toolUsers, yieldEff } from '../game/sim';
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
  /** Choosing a site for pioneers: the candidates on show. */
  private choosing = false;
  private choices: SiteChoice[] = [];
  /** Settlement the choices were found from. */
  private choicesFrom = 0;
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
      ['realm', 'Realm', 'i_house'],
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
    if (t !== 'realm' && this.choosing) {
      this.choosing = false;
      this.game.view.siteChoices = [];
    }
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
        case 'realm':
          this.buildRealm(s);
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
        return `b:${s.techs.length}:${eraOf(s)}:${worksQueue(s).map((b) => b.id).join(',')}:${this.game.view.placing}:${s.council.build}:${s.towns.length}`;
      case 'realm':
        return `m:${s.towns.map((t) => `${t.id}.${t.tier}`).join(',')}:${s.expeditions.map((e) => e.id).join(',')}:${s.routes.length}:${ties(s).filter((t) => t.stage === 'none' || t.stage === 'trail').length}:${s.towns.length}:${s.techs.length}:${s.council.build}:${this.choosing}:${s.buildings.filter((b) => b.type === 'harbour' && b.done).length}`;
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
      const out = s.expeditions.filter((e) => e.kind === 'scout').length;
      const parties = out ? ` · ${out} part${out > 1 ? 'ies' : 'y'} in the wilds` : '';
      return left <= 0 ? 'The whole land is known' : `${Math.round((s.stats.tilesExplored / (MAP_W * MAP_H)) * 100)}% of the land known${parties}`;
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
    const landNote: Partial<Record<JobId, string>> = {
      woodcutter: 'the woods near the camps are felled; they regrow in a few years, or a new camp can open in fresh forest',
      hunter: 'the herds nearby are hunted thin; they recover if left alone, and pastures breed animals instead',
      quarrier: 'the quarries are running out of rock',
      miner: 'the mines are running out of ore',
    };
    const eff = yieldEff(s, j);
    if (landNote[j] && eff < 0.95 && popSummary(s).jobs[j] > 0) extra += `<div class="sep"></div><span style="color:var(--bad)">Only ${Math.round(eff * 100)}% of a full yield: ${landNote[j]}.</span>`;
    if (def.usesTools) {
      const share = toolShare(s);
      extra += `<div class="sep"></div><span class="muted">Tools: ${share > 0 ? `${Math.round(share * 100)}% of labourers have one, <b style="color:var(--good)">+${Math.round((toolBonus(s) - 1) * 100)}% output</b>` : 'none in stock (no bonus)'}</span>`;
    }
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
    const sites = worksQueue(s);
    if (sites.length) {
      b.append(h('div', { class: 'section-title' }, `Works queue (${sites.length})`));
      b.append(h('div', { style: 'font-size:11px;color:var(--muted);margin:-2px 0 6px' }, 'Builders work down the queue: trees on a site are felled and rock levelled before the building goes up.'));
      for (const [k, site] of sites.entries()) {
        const def = BUILDING_DEFS[site.type];
        const bar = h('i');
        const info = h('div', { class: 'ts', style: 'font-family:var(--mono);font-size:9px;color:var(--muted)' });
        const cancel = h('button', { class: 'btn small danger', title: 'Cancel (refunds 75%)' }, '✕');
        cancel.addEventListener('click', () => {
          cancelBuilding(this.game.state, site.id);
          sfx('click');
          this.game.changed();
        });
        const up = h('button', { class: 'btn small', title: 'Do this next' }, '↑');
        up.addEventListener('click', () => {
          prioritise(this.game.state, site.id);
          sfx('click');
          this.game.changed();
        });
        if (k === 0) up.setAttribute('disabled', '');
        const town = s.towns.length > 1 ? s.towns.find((t) => t.id === site.town)?.name : '';
        const [w, hh] = sizeOf(site.type);
        const row = h(
          'div',
          { class: 'queue-item' },
          img(BUILDING_ICON(s, site.type), 2),
          h('div', null, h('div', null, def.name, h('span', { style: 'color:var(--muted);font-size:11px' }, `${w > 1 || hh > 1 ? ` ${w}×${hh}` : ''}${town ? ` · ${town}` : ''}`)), h('div', { class: 'bar' }, bar), info),
          h('div', { style: 'display:flex;gap:4px' }, up, cancel),
        );
        row.addEventListener('click', (e) => {
          if (e.target === cancel || e.target === up) return;
          this.game.view.centerOn(site.x + w / 2, site.y + hh / 2);
        });
        row.style.cursor = 'pointer';
        b.append(row);
        this.updaters.push(() => {
          const g = this.game.state;
          const stage = siteStage(g, site);
          const prepLeft = fellLeft(g, site) + (site.prep ?? 0);
          const p = stage === 'building' ? site.progress / buildWork(g, site.type) : site.prepTotal ? 1 - prepLeft / site.prepTotal : 0;
          bar.style.width = `${Math.min(100, Math.max(0, p) * 100)}%`;
          bar.style.background = stage === 'felling' ? 'var(--good)' : stage === 'levelling' ? '#c3cad4' : '';
          const builders = popSummary(g).jobs.builder;
          const stalled = stage === 'building' && def.materials && materialLimit(g, site.type) < 0.01;
          const first = worksQueue(g)[0]?.id === site.id;
          const what = stage === 'felling' ? 'Felling trees' : stage === 'levelling' ? 'Levelling rock' : 'Building';
          info.textContent = stalled ? 'Waiting for materials…' : `${what} · ${Math.round(p * 100)}%${first ? (builders ? ` · ${builders} builder${builders > 1 ? 's' : ''}` : ' · assign builders!') : ' · queued'}`;
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
        h('div', { class: 'top' }, img(BUILDING_ICON(s, t), 2), h('div', null, h('div', { class: 'nm' }, def.name, def.size ? h('span', { class: 'size' }, ` ${def.size[0]}×${def.size[1]}`) : null), cnt)),
        h('div', { class: 'benefit' }, def.benefit),
        costHolder,
        req,
      );
      tip(card, () => {
        const g = this.game.state;
        const extra = def.materials ? `<div class="sep"></div>As it rises it consumes: ${Object.entries(buildMaterials(g, t)!).map(([k, v]) => `${fmt(v ?? 0)} ${k}`).join(', ')}.` : '';
        return `<h4>${def.name}</h4>${def.desc}${def.size ? `<div class="sep"></div><span class="muted">Covers ${def.size[0]}×${def.size[1]} tiles. Forest on the site is felled and rock levelled first.</span>` : ''}${def.hint ? `<div class="sep"></div><span class="muted">${def.hint}</span>` : ''}${extra}${!unlocked ? `<div class="sep"></div><span style="color:var(--bad)">Requires ${TECH_DEFS[def.tech!].name}</span>` : ''}<div class="sep"></div><span class="muted">Work: ${buildWork(g, t)} · Built: ${derived(g).counts[t] ?? 0}</span>`;
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
        if (def.tier) card.classList.toggle('locked', !g.towns.some((x) => x.tier >= def.tier!) || !unlocked);
        costHolder.replaceChildren(costEl(g, def.cost));
        const ok = buildingAvailability(g, t).ok;
        card.classList.toggle('unaffordable', unlocked && !ok);
        card.style.opacity = unlocked ? (ok ? '1' : '0.72') : '';
      });
    }
  }

  // ---------------------------------------------------------------- realm
  private buildRealm(s: GameState) {
    const b = this.body;
    const d = derived(s);
    const map = getMap(s.seed);
    const home = map.island[idx(s.towns[0].x, s.towns[0].y)];
    const LINK: Record<Link, string> = {
      capital: 'The capital',
      road: 'Joined by road',
      route: 'Joined by a trade route',
      trail: 'Joined by a trail: 85% of its goods arrive',
      none: 'Cut off: only half its goods arrive until a trail or trade route joins it.',
    };
    b.append(h('div', { class: 'section-title' }, `Settlements (${s.towns.length})`));
    for (const t of s.towns) {
      const info = d.towns.get(t.id)!;
      const people = h('b');
      const needs = h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' });
      const across = map.island[idx(t.x, t.y)] !== home;
      const card = h(
        'div',
        { class: 'queue-item town-card' + (t === s.towns[0] ? ' capital' : '') },
        img(t.tier >= 2 ? 'house' : 'hut0', 2),
        h(
          'div',
          { style: 'flex:1' },
          h('div', null, h('span', { class: 'town-name' }, t.name), ' ', h('span', { class: 'town-tier' }, townTitle(s, t))),
          h('div', { class: 'ts', style: 'font-size:11px' }, `${BIOMES[info.biome].name}${across ? ' · overseas' : ''} · `, people, ` · ${info.buildings} buildings`),
          h('div', { class: 'ts', style: `font-size:11px;color:${info.link === 'none' ? 'var(--ember)' : 'var(--muted)'}` }, LINK[info.link]),
          needs,
        ),
      );
      tip(card, () => `<h4>${t.name}</h4>${BIOMES[info.biome].desc}<div class="sep"></div>${TIERS[t.tier].name}, founded in year ${Math.floor(t.founded / DAYS_PER_YEAR) + 1}.${info.specialty ? ` It lives by ${townTitle(s, t).split(' ')[0].toLowerCase()}.` : ''}`);
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => this.game.view.centerOn(t.x + 0.5, t.y + 0.5));
      b.append(card);
      this.updaters.push(() => {
        const g = this.game.state;
        const c = census(g);
        const dd = derived(g);
        people.textContent = `${c.residents.get(t.id) ?? 0}/${dd.towns.get(t.id)?.housing ?? 0} people`;
        const n = nextTierNeeds(g, t);
        needs.textContent = t.tier + 1 < TIERS.length ? `To become a ${TIERS[t.tier + 1].name.toLowerCase()}: ${n.length ? n.join(', ') : 'ready'}` : 'The greatest of cities.';
      });
    }

    // Pioneers, voyages and scouting parties
    b.append(h('div', { class: 'section-title' }, 'In the field'));
    if (!s.expeditions.length) b.append(h('div', { class: 'ts', style: 'font-size:12px;color:var(--muted)' }, 'No one is out in the wilds just now.'));
    for (const e of s.expeditions) {
      const bar = h('i');
      const from = s.towns.find((t) => t.id === e.from)?.name ?? '';
      const label = h('div');
      const status = h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' });
      const icon = e.kind === 'settle' ? 'i_flag' : 'i_scout';
      const row = h('div', { class: 'queue-item' }, img(icon, 2), h('div', { style: 'flex:1' }, label, status, h('div', { class: 'bar' }, bar)));
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const i = e.path[e.at];
        this.game.view.centerOn(tx(i) + 0.5, ty(i) + 0.5);
      });
      b.append(row);
      this.updaters.push(() => {
        const g = this.game.state;
        bar.style.width = `${Math.round((e.at / Math.max(1, e.path.length - 1)) * 100)}%`;
        if (e.kind === 'voyage') label.textContent = `A galley out of ${from}, charting the seas`;
        else if (e.kind === 'settle') label.textContent = `${e.people.length} pioneers from ${from}`;
        else {
          label.textContent = e.messenger ? `A messenger hurrying home to ${from}` : `${e.people.length} scout${e.people.length > 1 ? 's' : ''} from ${from}`;
          status.textContent = partyStatus(g, e);
        }
      });
    }
    const from = [...s.towns].sort((a, c) => (census(s).adults.get(c.id) ?? 0) - (census(s).adults.get(a.id) ?? 0))[0];
    const status = pioneerStatus(s, from.id);
    b.append(
      h(
        'div',
        { class: 'council-note' },
        s.council.build
          ? 'Scouts and pioneers look for prime land: fresh water, fertile soil, timber, stone, ore, game and fish. The council sends pioneers when the realm can spare them; you can choose a site yourself.'
          : 'Scouts and pioneers look for prime land: fresh water, fertile soil, timber, stone, ore, game and fish.',
      ),
    );
    const choose = h('button', { class: 'btn' + (this.choosing ? ' primary' : '') }, this.choosing ? 'Hide sites' : `Find a site for pioneers from ${from.name}`);
    choose.addEventListener('click', () => {
      sfx('click');
      this.choosing = !this.choosing;
      this.choices = this.choosing ? findSites(this.game.state, from.id, { limit: 6 }) : [];
      this.choicesFrom = from.id;
      this.game.view.siteChoices = this.choices;
      this.game.view.siteHover = -1;
      this.sig = '';
      this.update();
    });
    b.append(h('div', { class: 'acts', style: 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0' }, choose));
    if (!status.ok) b.append(h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' }, `Pioneers cannot set out yet: ${status.reason}.`));
    if (this.choosing) {
      if (!this.choices.length) b.append(h('div', { class: 'ts', style: 'font-size:12px;color:var(--muted)' }, 'No good land is known within reach. Send scouts further, or build a harbour to look across the sea.'));
      for (const [k, c] of this.choices.entries()) {
        const p = siteProfile(s.seed, c.tile);
        const calling = siteCalling(p);
        const biome = BIOMES[map.biome[c.tile] as keyof typeof BIOMES].name;
        const cost = expeditionCost(s, c.sea);
        const go = h('button', { class: 'btn small primary' }, 'Send');
        const row = h(
          'div',
          { class: 'queue-item site-choice' },
          h('div', { class: 'site-rank' }, String(k + 1)),
          h(
            'div',
            { style: 'flex:1' },
            h('div', null, `${biome} ${calling} land${c.sea ? ' across the sea' : ''}`),
            h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' }, `Worth ${Math.round(c.value)} · ${Math.round(c.cost)} days away${p.water ? ' · fresh water' : ' · no fresh water'}${p.coast ? ' · coast' : ''}`),
            costEl(s, cost),
          ),
          go,
        );
        row.addEventListener('mouseenter', () => (this.game.view.siteHover = k));
        row.addEventListener('mouseleave', () => (this.game.view.siteHover = -1));
        row.addEventListener('click', (e) => {
          if (e.target === go) return;
          this.game.view.centerOn(tx(c.tile) + 0.5, ty(c.tile) + 0.5);
          this.game.view.siteHover = k;
        });
        go.addEventListener('click', () => {
          const r = launchPioneers(this.game.state, this.game.tickCtx(), this.choicesFrom, c);
          if (!r.ok) {
            sfx('error');
            go.textContent = r.reason;
            return;
          }
          sfx('place');
          this.choosing = false;
          this.game.view.siteChoices = [];
          this.game.changed();
        });
        b.append(row);
      }
    }
    if (s.techs.includes('seafaring')) {
      const port = s.buildings.find((x) => x.type === 'harbour' && x.done);
      const sail = h('button', { class: 'btn' }, 'Send a galley to chart the seas');
      if (!port) sail.setAttribute('disabled', '');
      sail.addEventListener('click', () => {
        const r = launchVoyage(this.game.state, port!.town ?? s.towns[0].id);
        sfx(r.ok ? 'place' : 'error');
        if (!r.ok) sail.textContent = r.reason;
        this.game.changed();
      });
      b.append(h('div', { class: 'acts', style: 'margin:6px 0' }, sail));
      if (!port) b.append(h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' }, 'Build a harbour on the shore of the open sea first.'));
    }

    // Trade routes
    b.append(h('div', { class: 'section-title' }, `Trade routes (${s.routes.length})`));
    if (s.towns.length < 2) b.append(h('div', { class: 'ts', style: 'font-size:12px;color:var(--muted)' }, 'Trade needs a second settlement.'));
    else
      b.append(
        h(
          'div',
          { class: 'council-note' },
          'Over the years, people travelling between settlements on the same land wear trails between them. The busiest ways become cart routes, and the busiest routes are paved into roads. Bigger places that lie closer together get there sooner.',
        ),
      );
    for (const r of s.routes) {
      const A = s.towns.find((t) => t.id === r.a)?.name;
      const B = s.towns.find((t) => t.id === r.b)?.name;
      const inc = h('span');
      const row = h('div', { class: 'queue-item' }, img(r.kind === 'sea' ? 'i_scout' : 'i_hammer', 2), h('div', { style: 'flex:1' }, h('div', null, `${A} – ${B}`), h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' }, r.kind === 'sea' ? 'By galley · ' : 'By cart · ', inc)));
      b.append(row);
      this.updaters.push(() => {
        const g = this.game.state;
        const trails = new Set(g.trails);
        const left = r.kind === 'land' ? r.path.filter((i, k) => k >= r.paved && trails.has(i)).length : 0;
        const traffic = g.traffic[pairKey(r.a, r.b)] ?? 0;
        const paving = r.kind !== 'land' || !left ? '' : traffic < TRAFFIC_PAVE ? ` · paving starts when it is busier (${Math.round((traffic / TRAFFIC_PAVE) * 100)}%)` : ` · ${left} tiles of trail still to pave`;
        inc.textContent = `+${routeIncome(g, r).toFixed(2)} knowledge/day${paving}`;
      });
    }
    // Ways still growing between settlements on the same land.
    // The ways closest to becoming routes (a great realm has many more).
    const growing = ties(s)
      .filter((t) => t.stage === 'none' || t.stage === 'trail')
      .sort((a, b) => b.traffic - a.traffic || a.a - b.a || a.b - b.b)
      .slice(0, 8);
    for (const t of growing) {
      const A = s.towns.find((x) => x.id === t.a)?.name;
      const B = s.towns.find((x) => x.id === t.b)?.name;
      const bar = h('i');
      const what = h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' });
      b.append(h('div', { class: 'queue-item route-option' }, h('div', { style: 'flex:1;min-width:0' }, h('div', null, `${A} – ${B}`), what, h('div', { class: 'bar' }, bar))));
      this.updaters.push(() => {
        const now = ties(this.game.state).find((x) => x.a === t.a && x.b === t.b);
        if (!now) return;
        const goal = now.stage === 'none' ? TRAFFIC_TRAIL : TRAFFIC_ROUTE;
        bar.style.width = `${Math.min(100, Math.round((now.traffic / goal) * 100))}%`;
        const pace = now.flow > 0 ? ` · ${now.flow < 1 ? 'a few' : Math.round(now.flow)} travellers a day` : '';
        what.textContent =
          now.stage === 'route' || now.stage === 'paved'
            ? 'Carts now run this way'
            : now.waiting
              ? `Busy enough for carts: ${now.waiting}`
              : now.stage === 'none'
                ? `Travellers are wearing a trail${pace}`
                : `Trail worn, trade growing toward a cart route${pace}`;
      });
    }
    for (const o of routeOptions(s).slice(0, 8)) {
      const A = s.towns.find((t) => t.id === o.a)?.name;
      const B = s.towns.find((t) => t.id === o.b)?.name;
      if (!o.path.length) continue;
      const btn = h('button', { class: 'btn small' + (o.ok ? ' primary' : '') }, 'Open');
      if (!o.ok) btn.setAttribute('disabled', '');
      btn.addEventListener('click', () => {
        const r = openRoute(this.game.state, this.game.tickCtx(), o.a, o.b);
        sfx(r.ok ? 'place' : 'error');
        this.game.changed();
      });
      b.append(
        h(
          'div',
          { class: 'queue-item route-option' },
          h('div', { style: 'flex:1;min-width:0' }, h('div', null, `${A} – ${B}`, h('span', { style: 'color:var(--muted);font-size:11px' }, ' · by sea')), o.ok ? costEl(s, o.cost) : h('div', { class: 'ts', style: 'font-size:11px;color:var(--muted)' }, o.reason ?? '')),
          o.ok ? btn : null,
        ),
      );
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
  if (r === 'tools') {
    const users = toolUsers(s);
    note = `<div class="sep"></div><span class="muted">Each labourer with a tool works ${hasTech(s, 'iron') ? '40' : '20'}% better, and tools in use wear out in about ${Math.round(TOOL_LIFE / DAYS_PER_YEAR)} years. ${users ? `${Math.round(toolShare(s) * 100)}% of ${users} labourers have one: labourers +${Math.round((toolBonus(s) - 1) * 100)}%.` : ''}</span>`;
  }
  return `<h4>${def.name} ${fmt(s.res[r])}${isFinite(cap) ? ` / ${fmt(cap)}` : ''}</h4>${def.desc}${lines.length ? '<div class="sep"></div>' + lines.join('') : ''}<div class="sep"></div><div class="tl ${net >= 0 ? 'pos' : 'neg'}"><span>Net per day</span><span>${fmtRate(net)}</span></div>${note}`;
}

export function seasonIcon(day: number) {
  return ['i_spring', 'i_summer', 'i_autumn', 'i_winter'][seasonIndex(day)];
}

export { RES_ICON };
