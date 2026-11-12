// Effect chains. Built against BaseAudioContext so the live mix and the WAV export sound the same.
import { syncedDelay } from "../core/timing.ts";

export interface TrackParams {
  vol: number; // 0..1.5
  mute: boolean;
  solo: boolean;
  reverse: boolean;
  hall: number; // 0..1 send
  echo: number; // 0..1 send
  drive: number; // 0..1
  filter: number; // -1 (lowpass) .. 0 (off) .. 1 (highpass)
  trem: number; // 0..1 depth, synced 1/8
  chorus: number; // 0..1
}

export const defaultTrackParams = (): TrackParams => ({
  vol: 0.9,
  mute: false,
  solo: false,
  reverse: false,
  hall: 0,
  echo: 0,
  drive: 0,
  filter: 0,
  trem: 0,
  chorus: 0,
});

export type DelayDiv = "1/16" | "1/8" | "1/8." | "1/4";

export interface MasterParams {
  vol: number;
  hall: number; // reverb return
  echo: number; // delay return
  echoDiv: DelayDiv;
  echoFeedback: number;
}

export const defaultMasterParams = (): MasterParams => ({ vol: 0.9, hall: 0.8, echo: 0.8, echoDiv: "1/8.", echoFeedback: 0.4 });

export function filterSetting(v: number): { type: BiquadFilterType; freq: number; q: number } {
  if (v < -0.02) return { type: "lowpass", freq: 20000 * Math.pow(200 / 20000, -v), q: 1.2 };
  if (v > 0.02) return { type: "highpass", freq: 20 * Math.pow(4000 / 20, v), q: 1.2 };
  return { type: "lowpass", freq: 20000, q: 0.7 };
}

const curveCache = new Map<number, Float32Array<ArrayBuffer>>();
export function driveCurve(amount: number): Float32Array<ArrayBuffer> | null {
  const a = Math.round(amount * 20) / 20;
  if (a <= 0) return null;
  let c = curveCache.get(a);
  if (!c) {
    const k = 1 + a * 40;
    const n = 1024;
    c = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / norm;
    }
    curveCache.set(a, c);
  }
  return c;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makeImpulse(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    const r = rng(17 + c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp = lp * 0.55 + (r() * 2 - 1) * 0.45; // a little darker than white noise ("Holzraum")
      d[i] = lp * Math.pow(1 - t, 3.2) * (i < 64 ? i / 64 : 1);
    }
  }
  return ir;
}

export class MasterBus {
  readonly input: GainNode;
  readonly hallBus: GainNode;
  readonly echoBus: GainNode;
  readonly out: GainNode;
  private hallRet: GainNode;
  private echoRet: GainNode;
  private delay: DelayNode;
  private fb: GainNode;
  private ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, p: MasterParams, bpm: number) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.hallBus = ctx.createGain();
    this.echoBus = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx);
    this.hallRet = ctx.createGain();
    this.hallBus.connect(conv).connect(this.hallRet).connect(this.input);
    this.delay = ctx.createDelay(2.5);
    this.fb = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3800;
    this.echoRet = ctx.createGain();
    this.echoBus.connect(this.delay);
    this.delay.connect(tone).connect(this.fb).connect(this.delay);
    tone.connect(this.echoRet).connect(this.input);
    const vol = ctx.createGain();
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 4;
    lim.ratio.value = 12;
    lim.attack.value = 0.003;
    lim.release.value = 0.15;
    this.out = vol;
    this.input.connect(lim).connect(vol);
    this.set(p, bpm, true);
  }

  set(p: MasterParams, bpm: number, now = false) {
    const t = this.ctx.currentTime;
    const put = (a: AudioParam, v: number) => (now ? a.setValueAtTime(v, t) : a.setTargetAtTime(v, t, 0.03));
    put(this.out.gain, p.vol);
    put(this.hallRet.gain, p.hall * 0.9);
    put(this.echoRet.gain, p.echo);
    put(this.fb.gain, Math.min(0.85, p.echoFeedback));
    put(this.delay.delayTime, syncedDelay(bpm, p.echoDiv));
  }
}

export class TrackChain {
  readonly input: GainNode;
  private filter: BiquadFilterNode;
  private shaper: WaveShaperNode;
  private dry: GainNode;
  private wet: GainNode;
  private chorusDelay: DelayNode;
  private trem: GainNode;
  private tremDepth: GainNode;
  private tremLfo: OscillatorNode;
  private vol: GainNode;
  readonly gate: GainNode; // mute/solo
  private hall: GainNode;
  private echo: GainNode;
  private ctx: BaseAudioContext;
  private oscs: OscillatorNode[] = [];

  constructor(ctx: BaseAudioContext, master: MasterBus) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "2x";
    const sum = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.chorusDelay = ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.014;
    const chLfo = ctx.createOscillator();
    chLfo.frequency.value = 0.7;
    const chDepth = ctx.createGain();
    chDepth.gain.value = 0.004;
    chLfo.connect(chDepth).connect(this.chorusDelay.delayTime);
    this.trem = ctx.createGain();
    this.tremDepth = ctx.createGain();
    this.tremLfo = ctx.createOscillator();
    this.tremLfo.connect(this.tremDepth).connect(this.trem.gain);
    this.vol = ctx.createGain();
    this.gate = ctx.createGain();
    this.hall = ctx.createGain();
    this.echo = ctx.createGain();
    this.input.connect(this.filter).connect(this.shaper);
    this.shaper.connect(this.dry).connect(sum);
    this.shaper.connect(this.chorusDelay).connect(this.wet).connect(sum);
    sum.connect(this.trem).connect(this.vol).connect(this.gate);
    this.gate.connect(master.input);
    this.gate.connect(this.hall).connect(master.hallBus);
    this.gate.connect(this.echo).connect(master.echoBus);
    this.oscs = [chLfo, this.tremLfo];
    for (const o of this.oscs) o.start();
  }

  set(p: TrackParams, bpm: number, audible: boolean, now = false) {
    const t = this.ctx.currentTime;
    const put = (a: AudioParam, v: number) => (now ? a.setValueAtTime(v, t) : a.setTargetAtTime(v, t, 0.02));
    const f = filterSetting(p.filter);
    if (this.filter.type !== f.type) this.filter.type = f.type;
    put(this.filter.frequency, f.freq);
    put(this.filter.Q, f.q);
    const curve = driveCurve(p.drive);
    if (this.shaper.curve !== curve) this.shaper.curve = curve;
    put(this.dry.gain, (1 - p.chorus * 0.35) * (1 - p.drive * 0.35));
    put(this.wet.gain, p.chorus * 0.75 * (1 - p.drive * 0.35));
    put(this.trem.gain, 1 - p.trem * 0.5);
    put(this.tremDepth.gain, p.trem * 0.5);
    put(this.tremLfo.frequency, (bpm / 60) * 2);
    put(this.vol.gain, p.vol);
    put(this.gate.gain, audible ? 1 : 0);
    put(this.hall.gain, p.hall);
    put(this.echo.gain, p.echo * 0.8);
  }

  /** Sync the tremolo LFO phase is not critical; keep it simple. */
  dispose() {
    for (const o of this.oscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    this.gate.disconnect();
  }
}

/** Audible = not muted and (no solo active or this one soloed). */
export function audibleTracks(ps: { mute: boolean; solo: boolean }[]): boolean[] {
  const anySolo = ps.some((p) => p.solo);
  return ps.map((p) => (anySolo ? p.solo : !p.mute));
}
