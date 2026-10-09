import { GUIDE, nextGuide, pruneGuide, type GuideStep } from '../game/guide';
import { loadPrefs, savePrefs } from '../game/save';
import type { GameState } from '../game/types';
import { sfx } from './audio';
import { escapeHtml, h } from './dom';
import type { Panels } from './panels';
import type { Game } from './types';

/** Shows the elder's tips one at a time and highlights what each one is about. */
export class Guide {
  enabled = loadPrefs().tips;
  private el = document.getElementById('guide')!;
  private shown: GuideStep | null = null;
  private glowing: Element | null = null;
  private scrolledFor: string | null = null;

  constructor(
    private game: Game,
    private panels: Panels,
  ) {}

  attach(s: GameState) {
    // Settlements saved before the guide existed are already under way: no tips for them.
    if (!s.guide) s.guide = GUIDE.map((g) => g.id);
    this.shown = null;
    this.scrolledFor = null;
    this.render(s);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    savePrefs({ tips: on });
    this.update();
  }

  update() {
    const s = this.game.state;
    pruneGuide(s);
    const step = this.enabled ? nextGuide(s) : null;
    if (step !== this.shown) {
      this.shown = step;
      this.render(s);
    }
    this.position();
    this.highlight();
  }

  hide() {
    this.el.classList.add('hidden');
    this.setGlow(null);
  }

  private dismiss() {
    const s = this.game.state;
    if (this.shown && s.guide && !s.guide.includes(this.shown.id)) s.guide.push(this.shown.id);
    sfx('click');
    this.update();
  }

  private render(s: GameState) {
    const g = this.shown;
    if (!g) {
      this.hide();
      this.el.replaceChildren();
      return;
    }
    const showMe =
      g.tab &&
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            sfx('click');
            this.panels.setTab(g.tab!);
            this.scrolledFor = null;
          },
        },
        'Show me',
      );
    this.el.replaceChildren(
      h('div', { class: 'gk' }, 'The elder says'),
      h('div', { class: 'gt' }, g.title.replace('{name}', s.name)),
      h('div', { class: 'gb', html: g.text.replace('{name}', escapeHtml(s.name)) }),
      h(
        'div',
        { class: 'ga' },
        h('button', { class: 'btn small primary', onclick: () => this.dismiss() }, 'Got it'),
        showMe,
        h(
          'button',
          {
            class: 'link-btn',
            title: 'Turn tips back on from the menu',
            onclick: () => {
              sfx('click');
              this.setEnabled(false);
            },
          },
          'Hide tips',
        ),
      ),
    );
    this.el.classList.remove('hidden', 'in');
    void this.el.offsetWidth;
    this.el.classList.add('in');
  }

  /** Sit below the milestone panel, and below an event card if it would cover us. */
  private position() {
    if (this.el.classList.contains('hidden')) return;
    let top = document.getElementById('objective')!.getBoundingClientRect().bottom;
    const choice = document.getElementById('choice')!;
    if (!choice.classList.contains('hidden')) {
      const c = choice.getBoundingClientRect();
      const me = this.el.getBoundingClientRect();
      if (c.left < me.right && c.right > me.left) top = Math.max(top, c.bottom);
    }
    this.el.style.top = `${Math.round(top + 8)}px`;
  }

  private highlight() {
    const g = this.shown;
    let el: Element | null = null;
    if (g) {
      const onTab = !g.tab || this.panels.tab === g.tab;
      if (!onTab) el = document.querySelector(`.tab[data-tab="${g.tab}"]`);
      else if (g.target) el = document.querySelector(g.target);
      // Bring a highlighted section of the side panel into view once.
      if (el && onTab && g.tab && this.scrolledFor !== g.id && el.closest('#tab-body')) {
        this.scrolledFor = g.id;
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    this.setGlow(el);
  }

  private setGlow(el: Element | null) {
    if (this.glowing && this.glowing !== el) this.glowing.classList.remove('guide-glow');
    this.glowing = el;
    el?.classList.add('guide-glow');
  }
}
