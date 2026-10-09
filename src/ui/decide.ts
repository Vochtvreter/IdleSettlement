import { research, techStatus } from '../game/actions';
import { councilWish, focusOf, savingFor } from '../game/council';
import { BUILDING_DEFS, ERAS, TECH_DEFS } from '../game/data';
import {
  choiceOf,
  decide,
  DECISION_BY_ID,
  DECISIONS,
  decisionUnlocked,
  MILESTONES,
  milestoneDone,
  nextPath,
  PATH_ORDER,
  pathRequirements,
  policyCooldown,
  setTweak,
  TWEAKS,
  tweak,
  type DecisionDef,
} from '../game/decisions';
import { canAfford } from '../game/derived';
import type { GameState } from '../game/types';
import { sfx } from './audio';
import { costEl, h, tip } from './dom';
import type { Game } from './types';

type Updater = () => void;

/** True when a decision is waiting for the player (used for badges and the HUD pill). */
export function pendingDecision(s: GameState): DecisionDef | null {
  const p = nextPath(s);
  if (!p) return null;
  if (!pathRequirements(s, p).ready) return null;
  if (p.tech && !techStatus(s, p.tech).ok) return null;
  return p;
}

export function decideSignature(s: GameState) {
  const p = nextPath(s);
  const ready = p ? pathRequirements(s, p).ready : false;
  const afford = p?.tech ? techStatus(s, p.tech).ok : true;
  const cds = DECISIONS.filter((d) => d.kind === 'policy').map((d) => (policyCooldown(s, d.id) > 0 ? 1 : 0)).join('');
  return `d:${JSON.stringify(s.decisions)}:${s.objective}:${p?.id}:${ready}:${afford}:${JSON.stringify(s.council)}:${cds}`;
}

function lockLine(i: number) {
  return h('div', { class: 'lock' }, `\u{1F512} Unlocks at milestone ${i + 1}: ${MILESTONES[i].text}`);
}

export function buildDecide(game: Game, b: HTMLElement, updaters: Updater[]) {
  const s = game.state;
  const act = (id: string, opt: string) => {
    const r = decide(game.state, id, opt, game.tickCtx().fx, research);
    if (r.ok) {
      sfx(DECISION_BY_ID[id].kind === 'path' ? 'era' : 'click');
      game.changed();
    } else sfx('error');
  };

  // ------------------------------------------------ crossroads
  const p = nextPath(s);
  if (p) {
    const req = pathRequirements(s, p);
    const afford = !p.tech || canAfford(s, TECH_DEFS[p.tech].cost);
    const ready = req.ready && afford;
    const era = p.tech ? TECH_DEFS[p.tech].advancesTo! : null;
    const card = h('div', { class: 'path-card' + (ready ? ' ready' : '') });
    card.append(
      h('div', { class: 'kicker' }, era !== null ? `Crossroads · ${ERAS[era].name}` : 'Crossroads · your people’s nature'),
      h('div', { class: 'pt' }, p.name),
      h('div', { class: 'pp' }, p.prompt),
    );
    if (p.tech) {
      const reqs = h('div', { class: 'reqs' });
      const t = TECH_DEFS[p.tech];
      if (t.minPop) reqs.append(h('div', { class: s.settlers.length >= t.minPop ? 'ok' : 'no' }, `${s.settlers.length >= t.minPop ? '✔' : '✘'} ${t.minPop} people (${s.settlers.length})`));
      for (const r of t.requires ?? []) reqs.append(h('div', { class: s.techs.includes(r) ? 'ok' : 'no' }, `${s.techs.includes(r) ? '✔' : '✘'} ${TECH_DEFS[r].name}`));
      reqs.append(h('div', { class: afford ? 'ok' : 'no', style: 'display:flex;gap:6px;align-items:center' }, afford ? '✔' : '✘', costEl(s, t.cost)));
      card.append(reqs);
      if (req.ready && !afford) card.append(h('div', { class: 'note' }, 'The council is saving resources for this. The choice opens once they are gathered.'));
      else if (!req.ready) card.append(h('div', { class: 'note' }, 'Not yet — the settlement keeps growing on its own meanwhile.'));
      else card.append(h('div', { class: 'note good' }, 'Your people are ready. Choose a path to enter the new age. This choice is permanent.'));
    } else {
      card.append(h('div', { class: 'note good' }, 'Choose any time. This choice is permanent.'));
    }
    const opts = h('div', { class: 'opts' });
    for (const o of p.options) {
      const btn = h('button', { class: 'opt', disabled: !ready }, h('div', { class: 'on' }, o.name), h('div', { class: 'od' }, o.desc));
      btn.addEventListener('click', () => act(p.id, o.id));
      opts.append(btn);
    }
    card.append(opts);
    b.append(card);
  } else {
    b.append(h('div', { class: 'path-card done' }, h('div', { class: 'kicker' }, 'Crossroads'), h('div', { class: 'pt' }, 'Every path is chosen'), h('div', { class: 'pp' }, 'Your people’s story is written. Now raise the Sunspire.')));
  }

  // ------------------------------------------------ story so far
  const chosen = PATH_ORDER.filter((id) => s.decisions[id]);
  if (chosen.length) {
    b.append(h('div', { class: 'section-title' }, 'Your story'));
    const story = h('div', { class: 'story' });
    for (const id of chosen) {
      const d = DECISION_BY_ID[id];
      const o = d.options.find((x) => x.id === s.decisions[id])!;
      story.append(tip(h('div', { class: 'chapter' }, h('span', { class: 'cn' }, o.name), h('span', { class: 'cd' }, d.name)), `<h4>${o.name}</h4>${o.desc}`));
    }
    b.append(story);
  }

  // ------------------------------------------------ focus
  const focus = DECISION_BY_ID.focus;
  b.append(h('div', { class: 'section-title' }, focus.name));
  b.append(h('div', { class: 'hint-line' }, focus.prompt));
  const seg = h('div', { class: 'seg' });
  for (const o of focus.options) {
    const btn = tip(h('button', { class: 'seg-btn' + (focusOf(s) === o.id ? ' sel' : '') }, o.name), `<h4>${o.name}</h4>${o.desc}`);
    btn.addEventListener('click', () => act('focus', o.id));
    seg.append(btn);
  }
  b.append(seg);
  const plan = h('div', { class: 'hint-line', style: 'margin-top:6px' });
  b.append(plan);
  updaters.push(() => {
    const g = game.state;
    const w = g.council.build ? councilWish(g) : null;
    const save = savingFor(g);
    const parts: string[] = [];
    if (w) parts.push(`Next build: ${BUILDING_DEFS[w.type].name}${w.waiting ? ' (gathering materials)' : ''}`);
    if (g.pin) parts.push(`Researching toward ${TECH_DEFS[g.pin].name}`);
    else if (save) parts.push('Saving knowledge for the next age');
    plan.textContent = parts.length ? `Council: ${parts.join(' · ')}` : '';
  });

  // ------------------------------------------------ policies
  b.append(h('div', { class: 'section-title' }, 'Policies'));
  for (const d of DECISIONS.filter((x) => x.kind === 'policy')) {
    const unlocked = decisionUnlocked(s, d);
    const box = h('div', { class: 'policy' + (unlocked ? '' : ' locked') }, h('div', { class: 'pn' }, d.name), h('div', { class: 'pq' }, d.prompt));
    if (!unlocked) {
      box.append(lockLine(d.unlock));
      b.append(box);
      continue;
    }
    const cd = policyCooldown(s, d.id);
    const cur = choiceOf(s, d.id);
    const row = h('div', { class: 'seg' });
    for (const o of d.options) {
      const btn = tip(h('button', { class: 'seg-btn' + (cur === o.id ? ' sel' : ''), disabled: cd > 0 && cur !== o.id }, o.name), `<h4>${o.name}</h4>${o.desc}`);
      btn.addEventListener('click', () => act(d.id, o.id));
      row.append(btn);
    }
    box.append(row);
    const cur0 = d.options.find((o) => o.id === cur);
    const note = h('div', { class: 'pe' }, cur0?.desc ?? '');
    box.append(note);
    if (cd > 0) {
      const cdEl = h('div', { class: 'cd' });
      box.append(cdEl);
      updaters.push(() => (cdEl.textContent = `Settled for now — can change again in ${policyCooldown(game.state, d.id)} days.`));
    }
    b.append(box);
  }

  // ------------------------------------------------ tweaks
  b.append(h('div', { class: 'section-title' }, 'Council settings'));
  for (const t of TWEAKS) {
    const unlocked = milestoneDone(s, t.unlock);
    const val = h('span', { class: 'tv' });
    const box = h('div', { class: 'policy' + (unlocked ? '' : ' locked') }, h('div', { class: 'pn', style: 'display:flex;justify-content:space-between' }, t.name, val), h('div', { class: 'pq' }, t.desc));
    if (!unlocked) {
      val.textContent = `${t.initial}${t.unit}`;
      box.append(lockLine(t.unlock));
    } else {
      const input = h('input', { type: 'range', min: t.min, max: t.max, step: t.step, class: 'slider' }) as HTMLInputElement;
      input.value = String(tweak(s, t.id));
      const show = () => (val.textContent = `${tweak(game.state, t.id)}${t.unit}`);
      input.addEventListener('input', () => {
        setTweak(game.state, t.id, Number(input.value));
        show();
      });
      input.addEventListener('change', () => game.changed());
      show();
      box.append(input);
    }
    b.append(box);
  }

  // ------------------------------------------------ council toggles
  b.append(h('div', { class: 'section-title' }, 'Who decides the details?'));
  b.append(h('div', { class: 'hint-line' }, 'The council handles the day-to-day. Take any of it over yourself if you prefer.'));
  const toggles: [keyof GameState['council'], string, string][] = [
    ['jobs', 'Work assignments', 'People tab'],
    ['build', 'Construction', 'Build tab'],
    ['research', 'Discoveries', 'Research tab'],
  ];
  for (const [k, label, where] of toggles) {
    const on = s.council[k];
    const btn = h('button', { class: 'btn small ' + (on ? 'good' : '') }, on ? 'Council' : 'Manual');
    btn.addEventListener('click', () => {
      game.state.council[k] = !game.state.council[k];
      sfx('click');
      game.changed();
    });
    b.append(h('div', { class: 'toggle-row' }, h('div', null, h('div', null, label), h('div', { class: 'pq' }, on ? 'Managed by the council' : `You manage this in the ${where}`)), btn));
  }
}
