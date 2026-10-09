/** Tiny synthesized sound effects — no audio assets required. */
type Sfx = 'click' | 'build' | 'place' | 'birth' | 'death' | 'discover' | 'era' | 'error' | 'research' | 'event' | 'victory';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let lastPlayed: Record<string, number> = {};

export function setSoundEnabled(on: boolean) {
  enabled = on;
}
export function soundEnabled() {
  return enabled;
}

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', vol = 0.5, slide = 0) {
  const c = ctx!;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime + start);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + start + dur);
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  o.connect(g);
  g.connect(master!);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.02);
}

function noise(start: number, dur: number, vol = 0.3) {
  const c = ctx!;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = vol;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  src.connect(f);
  f.connect(g);
  g.connect(master!);
  src.start(c.currentTime + start);
}

export function sfx(name: Sfx) {
  if (!enabled) return;
  const now = performance.now();
  if (now - (lastPlayed[name] ?? 0) < 70) return;
  lastPlayed[name] = now;
  if (!ensure()) return;
  switch (name) {
    case 'click':
      tone(660, 0, 0.05, 'square', 0.18);
      break;
    case 'place':
      tone(330, 0, 0.08, 'square', 0.25);
      noise(0, 0.12, 0.25);
      break;
    case 'build':
      tone(392, 0, 0.09, 'square', 0.25);
      tone(523, 0.09, 0.09, 'square', 0.25);
      tone(659, 0.18, 0.16, 'square', 0.25);
      break;
    case 'birth':
      tone(880, 0, 0.12, 'triangle', 0.25);
      tone(1175, 0.1, 0.18, 'triangle', 0.22);
      break;
    case 'death':
      tone(220, 0, 0.35, 'triangle', 0.25, -80);
      break;
    case 'discover':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.07, 0.14, 'square', 0.18));
      break;
    case 'research':
      tone(587, 0, 0.1, 'triangle', 0.3);
      tone(880, 0.08, 0.22, 'triangle', 0.3);
      break;
    case 'era':
      [392, 523, 659, 784].forEach((f, i) => tone(f, i * 0.14, 0.3, 'square', 0.2));
      tone(1047, 0.56, 0.7, 'triangle', 0.3);
      break;
    case 'victory':
      [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.16, 0.32, 'square', 0.2));
      break;
    case 'event':
      tone(494, 0, 0.12, 'triangle', 0.3);
      tone(370, 0.12, 0.2, 'triangle', 0.3);
      break;
    case 'error':
      tone(160, 0, 0.12, 'square', 0.2, -40);
      break;
  }
}

export function resetSfxThrottle() {
  lastPlayed = {};
}
