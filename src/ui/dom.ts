import { RESOURCE_DEFS } from '../game/data';
import type { Cost, GameState, ResourceId } from '../game/types';
import { spriteURL } from '../render/sprites';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function img(name: string, scale = 2, cls = 'pix', overrides?: Record<string, string>) {
  return h('img', { src: spriteURL(name, scale, overrides), class: cls, alt: '', draggable: false });
}

export const RES_ICON: Record<ResourceId, string> = {
  food: 'i_food',
  wood: 'i_wood',
  stone: 'i_stone',
  hides: 'i_hides',
  ore: 'i_ore',
  tools: 'i_tools',
  knowledge: 'i_knowledge',
};

export function fmt(n: number, digits = 0): string {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a >= 1000) return Math.floor(n).toLocaleString('en-US');
  return digits ? n.toFixed(digits) : String(Math.floor(n));
}

export function fmtRate(n: number): string {
  if (Math.abs(n) < 0.005) return '±0';
  const s = Math.abs(n) >= 10 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(1) : n.toFixed(2);
  return (n > 0 ? '+' : '') + s;
}

export function costEl(state: GameState, cost: Cost) {
  return h(
    'div',
    { class: 'cost' },
    ...Object.entries(cost).map(([r, n]) => {
      const ok = state.res[r as ResourceId] >= (n ?? 0);
      return h('span', { class: ok ? '' : 'no', title: RESOURCE_DEFS[r as ResourceId].name }, img(RES_ICON[r as ResourceId], 1), fmt(n ?? 0));
    }),
  );
}

export function costText(cost: Cost) {
  return Object.entries(cost)
    .map(([r, n]) => `${fmt(n ?? 0)} ${RESOURCE_DEFS[r as ResourceId].name.toLowerCase()}`)
    .join(', ');
}

// ------------------------------------------------------------------ tooltips
const tips = new WeakMap<Element, () => string>();
let tipEl: HTMLElement;
let current: Element | null = null;

export function tip<T extends Element>(el: T, fn: (() => string) | string): T {
  tips.set(el, typeof fn === 'string' ? () => fn : fn);
  return el;
}

export function initTooltips() {
  tipEl = document.getElementById('tooltip')!;
  const show = (target: Element, x: number, y: number) => {
    const fn = tips.get(target);
    if (!fn) return;
    tipEl.innerHTML = fn();
    tipEl.classList.add('show');
    const r = tipEl.getBoundingClientRect();
    let left = x + 14;
    let top = y + 16;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 10;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 10;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    let el = e.target as Element | null;
    while (el && !tips.has(el)) el = el.parentElement;
    current = el;
    if (!el) {
      tipEl.classList.remove('show');
      return;
    }
    show(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', () => {
    if (current) tipEl.classList.remove('show');
  });
}

export function hideTip() {
  tipEl?.classList.remove('show');
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
