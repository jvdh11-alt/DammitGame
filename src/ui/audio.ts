/**
 * Procedural audio for Dammit: a soft lounge-style background loop, card sound effects and fanfares,
 * all synthesised with the Web Audio API (no audio files, nothing to license, works offline).
 */

type Ctx = BaseAudioContext;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export type SfxName =
  | 'draw' | 'discard' | 'lay' | 'swoosh' | 'tick' | 'turn'
  | 'handWon' | 'handOver' | 'gameWon' | 'gameOver';

// ---------- small synth ----------

function makeImpulse(ctx: Ctx, seconds = 2.4, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

class Synth {
  private noise: AudioBuffer;
  private wet: GainNode;

  constructor(readonly ctx: Ctx, readonly out: AudioNode, reverb = 0.28) {
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = reverb;
    this.wet.connect(verb);
    verb.connect(out);
  }

  /** Gain envelope: quick attack to `peak`, exponential decay to silence by `t + dur`. */
  private env(g: GainNode, t: number, attack: number, peak: number, dur: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, attack + 0.02));
  }

  private osc(type: OscillatorType, f: number, t: number, stop: number, dest: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    o.stop(stop);
  }

  private send(node: AudioNode, amount = 1) {
    if (amount <= 0) return;
    const s = this.ctx.createGain();
    s.gain.value = amount;
    node.connect(s);
    s.connect(this.wet);
  }

  /** Soft electric-piano note. */
  epiano(midi: number, t: number, dur: number, vel: number) {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    this.env(g, t, 0.006, vel * 0.15, dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    g.connect(lp);
    lp.connect(this.out);
    this.send(lp, 1);
    this.osc('sine', f, t, t + dur + 0.05, g);
    this.osc('triangle', f, t, t + dur + 0.05, g, 4);
    const tine = this.ctx.createGain();
    this.env(tine, t, 0.002, vel * 0.06, Math.min(dur, 0.35));
    tine.connect(lp);
    this.osc('sine', f * 4, t, t + 0.4, tine);
  }

  bass(midi: number, t: number, dur: number, vel: number) {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    this.env(g, t, 0.012, vel * 0.26, dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    g.connect(lp);
    lp.connect(this.out);
    this.osc('triangle', f, t, t + dur + 0.05, g);
    this.osc('sine', f, t, t + dur + 0.05, g);
  }

  /** Short filtered noise burst. Frequency sweeps from f0 to f1. */
  noiseBurst(t: number, dur: number, vel: number, type: BiquadFilterType, f0: number, f1: number, q = 0.8, reverb = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    filt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, vel, dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.out);
    this.send(g, reverb);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  hat(t: number, vel: number) {
    this.noiseBurst(t, 0.05, vel * 0.05, 'highpass', 7000, 7000, 0.7);
  }

  bell(midi: number, t: number, dur: number, vel: number) {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    this.env(g, t, 0.003, vel * 0.16, dur);
    g.connect(this.out);
    this.send(g, 1.2);
    this.osc('sine', f, t, t + dur + 0.05, g);
    this.osc('sine', f * 2.76, t, t + dur * 0.5, g);
    this.osc('sine', f * 5.4, t, t + dur * 0.25, g);
  }

  brass(midi: number, t: number, dur: number, vel: number) {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel * 0.07, t + 0.06);
    g.gain.setValueAtTime(vel * 0.07, t + Math.max(dur - 0.25, 0.07));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.exponentialRampToValueAtTime(2800, t + 0.18);
    g.connect(lp);
    lp.connect(this.out);
    this.send(lp, 0.8);
    this.osc('sawtooth', f, t, t + dur + 0.05, g, -7);
    this.osc('sawtooth', f, t, t + dur + 0.05, g, 7);
  }
}

// ---------- music: five synthesised styles, from slow and mellow to upbeat ----------

type ChordType = 'maj9' | 'm9' | 'dom13' | 'maj7' | 'm7' | 'dom7';
interface Chord { root: number; type: ChordType }
const VOICING: Record<ChordType, number[]> = {
  maj9: [4, 7, 11, 14], m9: [3, 7, 10, 14], dom13: [4, 10, 14, 21],
  maj7: [4, 7, 11, 16], m7: [3, 7, 10, 15], dom7: [4, 7, 10, 14],
};
const COLOR: Record<ChordType, number[]> = {
  maj9: [0, 4, 7, 9, 11, 14], m9: [0, 3, 7, 10, 14, 17], dom13: [0, 4, 9, 10, 14, 21],
  maj7: [0, 4, 7, 9, 11], m7: [0, 3, 7, 10, 12], dom7: [0, 4, 7, 9, 10],
};

const C = (root: number, type: ChordType): Chord => ({ root, type });

export interface MusicStyle { id: string; label: string; blurb: string; bpm: number }
type Ctx2 = { s: Synth; rng: () => number; t: number; beat: number; bar: number; chord: Chord; next: Chord };
interface StyleDef extends MusicStyle { progs: Chord[][]; form: number[]; play: (c: Ctx2) => void }

const pickTone = (c: Ctx2, lo: number, hi: number) => {
  const pc = (c.chord.root + COLOR[c.chord.type][Math.floor(c.rng() * COLOR[c.chord.type].length)]) % 12;
  let note = lo + ((pc - lo) % 12 + 12) % 12;
  if (note > hi) note -= 12;
  return note;
};
const stabChord = (c: Ctx2, at: number, dur: number, vel: number, lift = 12) =>
  VOICING[c.chord.type].forEach((iv, i) => c.s.epiano(c.chord.root + iv + lift, at + i * 0.011, dur, vel * (0.85 + c.rng() * 0.3)));
const kick = (s: Synth, t: number, vel = 1) => { s.bass(38, t, 0.16, vel); s.noiseBurst(t, 0.03, vel * 0.05, 'lowpass', 400, 200, 0.7); };

const STYLES: StyleDef[] = [
  { // 1. the original: slow, swung, jazzy
    id: 'lounge', label: 'Smooth Lounge', blurb: 'Slow and swung, jazzy', bpm: 84,
    progs: [
      [C(48, 'maj9'), C(45, 'm9'), C(50, 'm9'), C(43, 'dom13')],
      [C(53, 'maj9'), C(50, 'm9'), C(55, 'm9'), C(48, 'dom13')],
      [C(51, 'maj9'), C(48, 'm9'), C(53, 'm9'), C(46, 'dom13')],
    ],
    form: [0, 0, 1, 1, 0, 2, 1, 0],
    play(c) {
      const { s, rng, chord, next } = c;
      const SW = 0.62, h = (n: number) => c.t + n * c.beat;
      stabChord(c, h(0), c.beat * 1.7, 0.8);
      stabChord(c, h(1 + SW + 0.04), c.beat * 0.9, 0.5);
      if (rng() < 0.4) stabChord(c, h(3 + SW), c.beat * 0.7, 0.4);
      s.bass(chord.root - 12, h(0), c.beat * 1.5, 0.9);
      s.bass(chord.root - 12 + (rng() < 0.5 ? 7 : 12), h(2), c.beat * 1.2, 0.7);
      s.bass(rng() < 0.65 ? next.root - 12 + (rng() < 0.5 ? -1 : 1) : chord.root - 5, h(3), c.beat * 0.9, 0.6);
      s.hat(h(1), 0.6); s.hat(h(3), 0.6);
      for (const beat of [0, 1, 2, 3]) if (rng() < 0.35) s.hat(h(beat + SW), 0.25);
      if (rng() < 0.75) {
        const slots = [0, 1, 1 + SW, 2, 2 + SW, 3, 3 + SW].filter(() => rng() < 0.4);
        for (const slot of slots) s.epiano(pickTone(c, 72, 86), h(slot), c.beat * (0.6 + rng() * 0.9), 0.55);
      }
    },
  },
  { // 2. very slow, sparse, dreamy
    id: 'chill', label: 'Late Night Chill', blurb: 'Very slow, soft and sleepy', bpm: 62,
    progs: [
      [C(45, 'm9'), C(41, 'maj9'), C(48, 'maj7'), C(43, 'dom7')],
      [C(50, 'm9'), C(46, 'maj9'), C(43, 'm7'), C(45, 'dom7')],
    ],
    form: [0, 0, 1, 0],
    play(c) {
      const { s, rng, chord } = c;
      const h = (n: number) => c.t + n * c.beat;
      stabChord(c, h(0), c.beat * 3.6, 0.55, 12);
      s.bass(chord.root - 12, h(0), c.beat * 2.5, 0.8);
      if (rng() < 0.5) s.bass(chord.root - 5, h(2.5), c.beat * 1.2, 0.5);
      s.hat(h(1), 0.35); s.hat(h(3), 0.35);
      if (rng() < 0.55) s.bell(pickTone(c, 76, 90), h(rng() < 0.5 ? 1.5 : 2.5), 2.2, 0.4);
      if (rng() < 0.45) s.epiano(pickTone(c, 66, 79), h(2), c.beat * 1.8, 0.45);
    },
  },
  { // 3. bossa nova: gentle, steady, a little Brazilian
    id: 'bossa', label: 'Cafe Bossa', blurb: 'Gentle bossa nova groove', bpm: 100,
    progs: [
      [C(50, 'm7'), C(43, 'dom7'), C(48, 'maj7'), C(48, 'maj7')],
      [C(45, 'm7'), C(50, 'm7'), C(43, 'dom7'), C(48, 'maj7')],
    ],
    form: [0, 1, 0, 1],
    play(c) {
      const { s, rng, chord } = c;
      const h = (n: number) => c.t + n * c.beat;
      // classic bossa comping: stabs on 1, the "and" of 2, 3.5, 4
      for (const [at, v] of [[0, 0.7], [1.5, 0.55], [2.5, 0.5], [3.5, 0.45]] as const) stabChord(c, h(at), c.beat * 0.55, v, 12);
      s.bass(chord.root - 12, h(0), c.beat * 1.3, 0.85);
      s.bass(chord.root - 5, h(1.5), c.beat * 1.2, 0.7);
      s.bass(chord.root - 12, h(2), c.beat * 1.0, 0.75);
      s.bass(chord.root - 5, h(3.5), c.beat * 0.8, 0.6);
      for (let i = 0; i < 8; i++) s.hat(h(i / 2), i % 2 ? 0.28 : 0.4); // steady shaker-ish eighths
      s.noiseBurst(h(0), 0.03, 0.04, 'bandpass', 1800, 1800, 2); // rim click
      s.noiseBurst(h(1.5), 0.03, 0.03, 'bandpass', 1800, 1800, 2);
      if (rng() < 0.6) s.epiano(pickTone(c, 72, 86), h([0.5, 1, 2, 3][Math.floor(rng() * 4)]), c.beat * 0.8, 0.5);
    },
  },
  { // 4. funk: syncopated stabs, busy bass, 16th hats
    id: 'funk', label: 'Funky Groove', blurb: 'Upbeat and syncopated', bpm: 108,
    progs: [
      [C(45, 'dom7'), C(45, 'dom7'), C(50, 'dom7'), C(45, 'dom7')],
      [C(48, 'dom7'), C(48, 'dom7'), C(53, 'dom7'), C(55, 'dom7')],
    ],
    form: [0, 0, 1, 0],
    play(c) {
      const { s, rng, chord } = c;
      const h = (n: number) => c.t + n * c.beat;
      kick(s, h(0), 0.9); kick(s, h(2.5), 0.7); if (rng() < 0.5) kick(s, h(1.75), 0.6);
      s.noiseBurst(h(1), 0.1, 0.12, 'bandpass', 1800, 1500, 0.9); s.noiseBurst(h(3), 0.1, 0.12, 'bandpass', 1800, 1500, 0.9); // snare
      for (let i = 0; i < 16; i++) s.hat(h(i / 4), i % 4 === 2 ? 0.55 : 0.3);
      for (const [at, v] of [[0.5, 0.6], [1.75, 0.55], [2.25, 0.6], [3.5, 0.5]] as const) stabChord(c, h(at), c.beat * 0.22, v, 12);
      const line = [0, 0, 12, 0, 10, 7, 0, 5];
      line.forEach((iv, i) => { if (i % 2 === 0 || rng() < 0.6) s.bass(chord.root - 12 + iv, h(i / 2), c.beat * 0.4, 0.75); });
      if (rng() < 0.5) s.epiano(pickTone(c, 74, 88), h([1, 2, 3.25][Math.floor(rng() * 3)]), c.beat * 0.3, 0.45);
    },
  },
  { // 5. bright four-on-the-floor dance-pop
    id: 'upbeat', label: 'Bright Pop', blurb: 'Fast, bright and danceable', bpm: 124,
    progs: [
      [C(48, 'maj7'), C(55, 'dom7'), C(45, 'm7'), C(41, 'maj7')],
      [C(53, 'maj7'), C(48, 'maj7'), C(50, 'm7'), C(55, 'dom7')],
    ],
    form: [0, 0, 1, 0],
    play(c) {
      const { s, rng, chord } = c;
      const h = (n: number) => c.t + n * c.beat;
      for (let b = 0; b < 4; b++) kick(s, h(b), 0.85);
      s.noiseBurst(h(1), 0.12, 0.1, 'bandpass', 2200, 1800, 0.9); s.noiseBurst(h(3), 0.12, 0.1, 'bandpass', 2200, 1800, 0.9); // clap
      for (let b = 0; b < 4; b++) s.hat(h(b + 0.5), 0.6); // off-beat open hats
      for (let i = 0; i < 8; i++) s.bass(chord.root - 12 + (i % 2 ? 12 : 0), h(i / 2 + 0.01), c.beat * 0.3, 0.7); // pumping octave bass
      stabChord(c, h(0), c.beat * 1.0, 0.7, 12); stabChord(c, h(2), c.beat * 1.0, 0.6, 12);
      // sparkly arpeggio
      const tones = VOICING[chord.type].map((iv) => chord.root + iv + 24);
      for (let i = 0; i < 8; i++) if (rng() < 0.8) s.bell(tones[(i + Math.floor(rng() * 2)) % tones.length], h(i / 2), 0.5, 0.35);
    },
  },
];

export const MUSIC_STYLES: MusicStyle[] = STYLES.map(({ id, label, blurb, bpm }) => ({ id, label, blurb, bpm }));
export const DEFAULT_STYLE = 'lounge';

export class Music {
  private nextBar = 0;
  private bar = 0;
  private def: StyleDef = STYLES[0];

  constructor(private s: Synth, private rng: () => number = Math.random, style: string = DEFAULT_STYLE) { this.setStyle(style); }

  setStyle(id: string) { this.def = STYLES.find((x) => x.id === id) ?? STYLES[0]; }

  start(t0: number) {
    this.nextBar = t0;
    this.bar = 0;
  }

  /** Schedule every bar that begins before `until` (audio-clock seconds). */
  schedule(until: number) {
    const beat = 60 / this.def.bpm;
    while (this.nextBar < until) {
      this.playBar(this.nextBar, this.bar++, beat);
      this.nextBar += beat * 4;
    }
  }

  private chordAt(bar: number): Chord {
    const d = this.def;
    return d.progs[d.form[Math.floor(bar / 4) % d.form.length]][bar % 4];
  }

  private playBar(t: number, bar: number, beat: number) {
    this.def.play({ s: this.s, rng: this.rng, t, beat, bar, chord: this.chordAt(bar), next: this.chordAt(bar + 1) });
  }
}

// ---------- sound effects ----------

const N = { C4: 60, E4: 64, G4: 67, A4: 69, C5: 72, D5: 74, E5: 76, G5: 79, B5: 83, C6: 84, E6: 88, G6: 91 };

function playSfx(s: Synth, name: SfxName, t: number) {
  switch (name) {
    case 'draw':
      s.noiseBurst(t, 0.12, 1.1, 'bandpass', 900, 3200, 0.9);
      break;
    case 'discard':
      s.noiseBurst(t, 0.05, 0.22, 'highpass', 2500, 2500, 0.7);
      s.bass(40, t, 0.12, 0.8);
      break;
    case 'lay':
      s.bell(N.E5, t, 0.7, 0.7);
      s.bell(N.B5, t + 0.1, 0.9, 0.6);
      s.noiseBurst(t, 0.05, 0.12, 'highpass', 2500, 2500, 0.7);
      break;
    case 'swoosh': // a swoop: rising then falling whoosh with a sparkle
      s.noiseBurst(t, 0.35, 1.2, 'bandpass', 300, 4500, 1.4, 0.2);
      s.noiseBurst(t + 0.25, 0.45, 1.0, 'bandpass', 4500, 400, 1.4, 0.3);
      s.bell(N.C6, t + 0.3, 0.6, 0.35);
      s.bell(N.G6, t + 0.4, 0.8, 0.3);
      break;
    case 'tick':
      s.bell(N.E6, t, 0.18, 0.8);
      break;
    case 'turn':
      s.bell(N.E5, t, 0.5, 0.9);
      s.bell(N.G5, t + 0.12, 0.5, 0.9);
      s.bell(N.C6, t + 0.24, 0.9, 1.0);
      break;
    case 'handWon': // you went out: bright little fanfare
      [N.C5, N.E5, N.G5, N.C6].forEach((m, i) => { s.brass(m, t + i * 0.1, 0.45, 0.8); s.bell(m + 12, t + i * 0.1, 0.9, 0.5); });
      [N.C5, N.E5, N.G5].forEach((m) => s.brass(m, t + 0.46, 0.9, 0.8));
      [N.G6, N.E6, N.C6].forEach((m, i) => s.bell(m, t + 0.55 + i * 0.07, 0.8, 0.4));
      break;
    case 'handOver': // someone else went out: soft two-note resolve
      s.bell(N.D5, t, 0.8, 0.55);
      s.bell(N.A4, t + 0.22, 1.1, 0.55);
      break;
    case 'gameWon': { // the big one
      const climb = [N.C4, N.E4, N.G4, N.C5, N.E5, N.G5, N.C6];
      climb.forEach((m, i) => { s.brass(m, t + i * 0.13, 0.5, 0.85); s.bell(m + 12, t + i * 0.13, 1.1, 0.5); });
      const t2 = t + climb.length * 0.13 + 0.1;
      [N.C4 - 12, N.C4, N.E4, N.G4, N.C5, N.E5].forEach((m) => s.brass(m, t2, 2.6, 1));
      [N.C6, N.G5, N.E6, N.G6, N.C6 + 12].forEach((m, i) => s.bell(m, t2 + 0.05 + i * 0.12, 1.8, 0.55));
      for (let i = 0; i < 14; i++) s.bell(N.G5 + Math.floor(Math.random() * 16), t2 + 0.7 + i * 0.12, 0.6, 0.3);
      break;
    }
    case 'gameOver': // someone else won: warm resolving chord
      [N.A4 - 12, N.A4, N.C5, N.E5].forEach((m) => s.epiano(m, t, 2.4, 0.9));
      [N.E5, N.C5, N.A4].forEach((m, i) => s.bell(m, t + 0.15 + i * 0.2, 1.4, 0.45));
      break;
  }
}

// ---------- audio manager ----------

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const level = (key: string, fallback: number) => {
  const v = store.get(key);
  const n = v === null ? fallback : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

/** Music and sound effects each have their own on/off switch and volume. Music defaults to off. */
class AudioManager {
  musicOn = store.get('musicOn') === '1';
  sfxOn = store.get('sfxOn') !== '0';
  musicVol = level('musicVol', 0.5);
  musicStyle = MUSIC_STYLES.some((x) => x.id === store.get('musicStyle')) ? store.get('musicStyle')! : DEFAULT_STYLE;
  sfxVol = level('sfxVol', 0.7);
  private ctx?: AudioContext;
  private musicBus?: GainNode;
  private sfxBus?: GainNode;
  private sfxSynth?: Synth;
  private music?: Music;
  private timer?: number;

  /** Call from a user gesture (browsers block audio until then). */
  unlock() {
    if (!this.ctx) this.init();
    this.apply();
  }

  private init() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    const master = ctx.createGain();
    master.connect(comp);
    comp.connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0;
    this.sfxBus.connect(master);

    this.sfxSynth = new Synth(ctx, this.sfxBus, 0.2);
    this.music = new Music(new Synth(ctx, this.musicBus, 0.3), Math.random, this.musicStyle);
    document.addEventListener('visibilitychange', () => this.apply());
  }

  /** Bring gains, the music scheduler and the audio clock in line with the current settings. */
  private apply() {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.sfxBus || !this.music) return;
    const now = ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(this.musicOn ? this.musicVol * this.musicVol * 0.6 : 0, now, this.musicOn ? 0.6 : 0.08);
    this.sfxBus.gain.setTargetAtTime(this.sfxOn ? this.sfxVol * this.sfxVol * 0.75 : 0, now, 0.04);
    // Only generate music while it is switched on.
    if (this.musicOn && this.timer === undefined) {
      this.music.start(now + 0.15);
      this.timer = window.setInterval(() => this.music!.schedule(ctx.currentTime + 0.8), 200);
    } else if (!this.musicOn && this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    // Save CPU when nothing is audible or the tab is in the background.
    const silent = (!this.musicOn && !this.sfxOn) || document.hidden;
    (silent ? ctx.suspend() : ctx.resume()).catch(() => { /* needs a user gesture first; ignore */ });
  }

  setMusicOn(on: boolean) { this.musicOn = on; store.set('musicOn', on ? '1' : '0'); this.unlock(); }
  setMusicStyle(id: string) {
    if (!MUSIC_STYLES.some((x) => x.id === id)) return;
    this.musicStyle = id; store.set('musicStyle', id);
    this.unlock();
    this.music?.setStyle(id);
    if (this.ctx && this.musicOn && this.timer !== undefined) this.music?.start(this.ctx.currentTime + 0.15); // switch right away
  }
  setSfxOn(on: boolean) { this.sfxOn = on; store.set('sfxOn', on ? '1' : '0'); this.unlock(); }
  setMusicVol(v: number) { this.musicVol = Math.min(1, Math.max(0, v)); store.set('musicVol', String(this.musicVol)); this.unlock(); }
  setSfxVol(v: number) { this.sfxVol = Math.min(1, Math.max(0, v)); store.set('sfxVol', String(this.sfxVol)); this.unlock(); }

  sfx(name: SfxName) {
    if (!this.sfxOn || !this.ctx || !this.sfxSynth || this.ctx.state !== 'running') return;
    playSfx(this.sfxSynth, name, this.ctx.currentTime + 0.01);
  }
}

export const audio = new AudioManager();

// ---------- offline rendering (used by tests to check the synthesis without speakers) ----------

export async function renderOffline(what: 'music' | SfxName, seconds: number, style: string = DEFAULT_STYLE): Promise<Float32Array> {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.floor(sr * seconds), sr);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  const bus = ctx.createGain();
  bus.gain.value = what === 'music' ? 0.4 : 1; // same levels as the live music and effects buses
  bus.connect(comp);
  comp.connect(ctx.destination);
  if (what === 'music') {
    const m = new Music(new Synth(ctx, bus, 0.3), Math.random, style);
    m.start(0.05);
    m.schedule(seconds);
  } else {
    playSfx(new Synth(ctx, bus, 0.2), what, 0.05);
  }
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}
(window as unknown as { __dammitAudio?: unknown }).__dammitAudio = { renderOffline };
