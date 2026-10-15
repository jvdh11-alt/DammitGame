/**
 * Procedural audio for Dammit: a soft lounge-style background loop, card sound effects and fanfares,
 * all synthesised with the Web Audio API (no audio files, nothing to license, works offline).
 */

type Ctx = BaseAudioContext;
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export type SfxName =
  | 'draw' | 'discard' | 'lay' | 'tick' | 'turn'
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

// ---------- music: a slow, swung 4-chord loop with bass, brushes and a gentle improvised line ----------

type ChordType = 'maj9' | 'm9' | 'dom13';
interface Chord { root: number; type: ChordType }
const VOICING: Record<ChordType, number[]> = { maj9: [4, 7, 11, 14], m9: [3, 7, 10, 14], dom13: [4, 10, 14, 21] };
const COLOR: Record<ChordType, number[]> = { maj9: [0, 4, 7, 9, 11, 14], m9: [0, 3, 7, 10, 14, 17], dom13: [0, 4, 9, 10, 14, 21] };

const C = (root: number, type: ChordType): Chord => ({ root, type });
const PROGRESSIONS: Chord[][] = [
  [C(48, 'maj9'), C(45, 'm9'), C(50, 'm9'), C(43, 'dom13')],   // I vi ii V in C
  [C(53, 'maj9'), C(50, 'm9'), C(55, 'm9'), C(48, 'dom13')],   // I vi ii V in F
  [C(51, 'maj9'), C(48, 'm9'), C(53, 'm9'), C(46, 'dom13')],   // I vi ii V in Eb
];
const FORM = [0, 0, 1, 1, 0, 2, 1, 0];                          // which progression, 4 bars each

const BPM = 84;
const BEAT = 60 / BPM;
const SWING = 0.62; // the off-beat eighth lands this far through the beat

export class Music {
  private nextBar = 0;
  private bar = 0;

  constructor(private s: Synth, private rng: () => number = Math.random) {}

  start(t0: number) {
    this.nextBar = t0;
    this.bar = 0;
  }

  /** Schedule every bar that begins before `until` (audio-clock seconds). */
  schedule(until: number) {
    while (this.nextBar < until) {
      this.playBar(this.nextBar, this.bar++);
      this.nextBar += BEAT * 4;
    }
  }

  private chordAt(bar: number): Chord {
    return PROGRESSIONS[FORM[Math.floor(bar / 4) % FORM.length]][bar % 4];
  }

  private playBar(t: number, bar: number) {
    const { s, rng } = this;
    const chord = this.chordAt(bar);
    const next = this.chordAt(bar + 1);
    const h = (n: number) => t + n * BEAT;

    // Comping: rolled chord on 1, a swung stab on the "and" of 2, sometimes another before the bar ends.
    const stab = (at: number, dur: number, vel: number) =>
      VOICING[chord.type].forEach((iv, i) => s.epiano(chord.root + iv + 12, at + i * 0.011, dur, vel * (0.85 + rng() * 0.3)));
    stab(h(0), BEAT * 1.7, 0.8);
    stab(h(1 + SWING + 0.04), BEAT * 0.9, 0.5);
    if (rng() < 0.4) stab(h(3 + SWING), BEAT * 0.7, 0.4);

    // Bass: root, then fifth, then a chromatic approach into the next chord.
    s.bass(chord.root - 12, h(0), BEAT * 1.5, 0.9);
    s.bass(chord.root - 12 + (rng() < 0.5 ? 7 : 12), h(2), BEAT * 1.2, 0.7);
    s.bass(rng() < 0.65 ? next.root - 12 + (rng() < 0.5 ? -1 : 1) : chord.root - 5, h(3), BEAT * 0.9, 0.6);

    // Brushes: soft hats on 2 and 4, a few ghost notes.
    s.hat(h(1), 0.6);
    s.hat(h(3), 0.6);
    for (const beat of [0, 1, 2, 3]) if (rng() < 0.35) s.hat(h(beat + SWING), 0.25);

    // A gentle improvised line from the chord's colour tones.
    if (rng() < 0.75) {
      const slots = [0, 1, 1 + SWING, 2, 2 + SWING, 3, 3 + SWING].filter(() => rng() < 0.4);
      for (const slot of slots) {
        const pc = (chord.root + COLOR[chord.type][Math.floor(rng() * COLOR[chord.type].length)]) % 12;
        let note = 72 + ((pc - 72) % 12 + 12) % 12;
        if (note > 86) note -= 12;
        s.epiano(note, h(slot), BEAT * (0.6 + rng() * 0.9), 0.55);
      }
    }
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
    this.music = new Music(new Synth(ctx, this.musicBus, 0.3));
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

export async function renderOffline(what: 'music' | SfxName, seconds: number): Promise<Float32Array> {
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
    const m = new Music(new Synth(ctx, bus, 0.3));
    m.start(0.05);
    m.schedule(seconds);
  } else {
    playSfx(new Synth(ctx, bus, 0.2), what, 0.05);
  }
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}
(window as unknown as { __dammitAudio?: unknown }).__dammitAudio = { renderOffline };
