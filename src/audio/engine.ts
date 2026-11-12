// Looper engine: master clock, armed recording that starts exactly at the next loop start ("Anfang"),
// per-track lengths phase-locked to one bar grid, effects, metronome.
import { METERS, accentOf, msToFrames } from "../core/timing.ts";
import { barLength, countdown, lcmBars, nextCycleStart, phaseOf, trackPos, type Countdown } from "../core/grid.ts";
import { FrameRing } from "../core/ring.ts";
import { closeLoop, reverse } from "../core/seam.ts";
import { detectLatency, type LatencyResult } from "../core/latency.ts";
import { MasterBus, TrackChain, audibleTracks, defaultMasterParams, defaultTrackParams, type MasterParams, type TrackParams } from "./fx.ts";

export type ClickMode = "aus" | "einzaehlen" | "aufnahme" | "immer";
export type PedalB = "undo" | "stop" | "cancel";

export interface Settings {
  bpm: number;
  meter: string;
  trackCount: number;
  countIn: number;
  click: ClickMode;
  clickVol: number;
  duck: number; // playback level while recording (1 = unchanged, 0 = silent)
  onsetStart: boolean;
  onsetLevel: number;
  latencyMs: number;
  inputGain: number;
  pedalB: PedalB;
  defaultBars: number;
}

export const defaultSettings = (): Settings => ({
  bpm: 90,
  meter: "4/4",
  trackCount: 4,
  countIn: 1,
  click: "aufnahme",
  clickVol: 0.6,
  duck: 1,
  onsetStart: false,
  onsetLevel: 0.12,
  latencyMs: 0,
  inputGain: 1,
  pedalB: "undo",
  defaultBars: 4,
});

export const BAR_CHOICES = [1, 2, 4, 8, 16];

export type Phase = "idle" | "waiting" | "countin" | "running" | "paused";

export interface Track {
  index: number;
  bars: number; // length for the next recording (and of the current audio)
  data: Float32Array | null; // forward audio, exactly bars*barF frames
  dataBars: number;
  phaseBars: number; // grid offset in bars at which this track's loop begins
  params: TrackParams;
  chain: TrackChain | null;
  source: AudioBufferSourceNode | null;
  srcGain: GainNode | null;
  takes: number;
}

/** The single armed / recording take. S = output frame where recording starts (a loop start). */
interface Rec {
  track: number;
  S: number;
  len: number;
  bars: number;
}

interface Pending extends Rec {
  start: number; // mic frames
  end: number;
  phaseBars: number;
}

export type TrackState = "empty" | "armed" | "recording" | "playing" | "muted";

export interface ViewState {
  phase: Phase;
  frame: number;
  bar: number; // 1-based bar in master cycle
  beat: number; // 1-based beat in bar
  masterBars: number;
  masterFrac: number;
  countIn: number; // beats left in count-in (0 if none)
  armed: number; // track armed (waiting for the loop start), -1 if none
  recording: number; // track recording now, -1 if none
  toStart: Countdown | null; // armed: until recording starts
  toEnd: Countdown | null; // recording: until the take ends
  level: number;
  clip: boolean;
  trackFrac: number[];
  trackState: TrackState[];
}

const FADE = 256; // seam crossfade (frames)
const LOOKAHEAD = 0.25; // s
const MIN_LEAD = 0.06; // s: an arm closer than this to the loop start waits for the next one

export class Engine {
  s: Settings;
  master: MasterParams = defaultMasterParams();
  tracks: Track[] = [];
  ctx: AudioContext | null = null;
  phase: Phase = "idle";
  barF = 0;
  masterBars = 0; // 0 = no master cycle yet (defined by the first take)
  t0 = 0;
  rec: Rec | null = null;
  level = 0;
  clipUntil = 0;
  micError = "";
  notice = "";
  onChange: () => void = () => {};
  loopbackSeconds: number | null = null; // test mode: output -> delay -> input instead of the microphone

  private ring: FrameRing | null = null;
  private bus: MasterBus | null = null;
  private duck: GainNode | null = null;
  private outTap: GainNode | null = null;
  private clickOut: GainNode | null = null;
  private inGain: GainNode | null = null;
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBeat = 0;
  private pending: Pending[] = [];
  private clicks: { osc: OscillatorNode; at: number }[] = [];
  private history: { track: number; prev: { data: Float32Array; bars: number; phaseBars: number } | null }[] = [];
  private inputReady: Promise<void> | null = null;

  constructor(s: Settings) {
    this.s = s;
    this.setTrackCount(s.trackCount);
  }

  get sr(): number {
    return this.ctx?.sampleRate ?? 48000;
  }
  get meter() {
    return METERS[this.s.meter] ?? METERS["4/4"];
  }
  get hasAudio(): boolean {
    return this.tracks.some((t) => t.data);
  }
  get masterLen(): number {
    return this.masterBars * this.barF;
  }
  get latencyFrames(): number {
    return msToFrames(this.s.latencyMs, this.sr);
  }
  get gridLocked(): boolean {
    return this.hasAudio || !!this.rec || this.pending.length > 0;
  }
  private get playing() {
    return this.phase === "running" || this.phase === "countin";
  }

  setTrackCount(n: number) {
    this.s.trackCount = n;
    while (this.tracks.length < n) this.tracks.push(this.newTrack(this.tracks.length));
    this.onChange();
  }

  private newTrack(index: number): Track {
    return { index, bars: this.s.defaultBars, data: null, dataBars: 0, phaseBars: 0, params: defaultTrackParams(), chain: null, source: null, srcGain: null, takes: 0 };
  }

  setTrackBars(i: number, bars: number) {
    const t = this.tracks[i];
    if (t.data && this.rec?.track !== i) return; // locked once recorded; re-arm to change
    if (this.rec?.track === i && this.playing && this.ctx && this.ctx.currentTime * this.sr >= this.rec.S) return; // already recording
    t.bars = bars;
    if (this.rec?.track === i) {
      // re-plan the armed take with the new length
      this.rec.bars = bars;
      this.rec.len = bars * this.barF;
      if (this.masterBars === 0 || (!this.hasAudio && this.pending.length === 0)) this.masterBars = bars;
      if (Number.isFinite(this.rec.S)) this.setRec({ ...this.rec });
    }
    this.onChange();
  }

  async ensureAudio(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(new URL("./recorder-worklet.js", document.baseURI).href);
      this.outTap = ctx.createGain();
      this.outTap.connect(ctx.destination);
      this.bus = new MasterBus(ctx, this.master, this.s.bpm);
      this.duck = ctx.createGain();
      this.bus.out.connect(this.duck).connect(this.outTap);
      this.clickOut = ctx.createGain();
      this.clickOut.connect(this.outTap);
      for (const t of this.tracks) this.applyTrack(t, true);
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    return this.ctx;
  }

  async ensureInput(): Promise<void> {
    if (!this.inputReady)
      this.inputReady = this.openInput().catch((e) => {
        this.inputReady = null;
        throw e;
      });
    return this.inputReady;
  }

  private async openInput() {
    const ctx = await this.ensureAudio();
    const node = new AudioWorkletNode(ctx, "loopstep-recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
    this.inGain = ctx.createGain();
    this.inGain.gain.value = this.s.inputGain;
    if (this.loopbackSeconds != null) {
      const d = ctx.createDelay(2);
      d.delayTime.value = this.loopbackSeconds;
      this.outTap!.connect(d).connect(this.inGain);
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      ctx.createMediaStreamSource(this.stream).connect(this.inGain);
    }
    this.inGain.connect(node);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    this.ring = new FrameRing(Math.ceil(ctx.sampleRate * 200));
    node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array; peak: number }>) => this.onInput(e.data.frame, e.data.data, e.data.peak);
    this.micError = "";
  }

  /** Test hook: node that feeds the speaker (and the loopback input in test mode). */
  outTapForTest(): GainNode {
    return this.outTap!;
  }

  setInputGain(v: number) {
    this.s.inputGain = v;
    if (this.inGain && this.ctx) this.inGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private onInput(frame: number, data: Float32Array, pk: number) {
    this.ring!.write(frame, data);
    this.level = Math.max(pk, this.level * 0.85);
    if (pk >= 0.98) this.clipUntil = performance.now() + 1200;
    if (this.phase === "waiting" && pk >= this.s.onsetLevel) {
      const onset = this.ring!.findOnset(frame, this.s.onsetLevel);
      if (onset >= 0) this.beginAtOnset(onset);
    }
  }

  private async prepare() {
    await this.ensureAudio();
    try {
      await this.ensureInput();
    } catch (e) {
      this.micError = (e as Error).name === "NotAllowedError" ? "Mikrofon nicht erlaubt" : "Kein Mikrofon: " + (e as Error).message;
      this.onChange();
      throw e;
    }
    if (!this.gridLocked) this.barF = barLength(this.s.bpm, this.meter.beats, this.sr);
    this.bus!.set(this.master, this.s.bpm);
  }

  private nowFrame(): number {
    return Math.round(this.ctx!.currentTime * this.sr);
  }

  // ---------- transport ----------

  /** Big button: Start (idle: count-in + record the first empty track) / Stopp / Weiter. */
  async mainAction() {
    if (this.playing || this.phase === "waiting") this.pause();
    else if (this.phase === "paused") await this.resume();
    else await this.toggleRec(this.firstEmpty() >= 0 ? this.firstEmpty() : 0);
  }

  firstEmpty(): number {
    for (let i = 0; i < this.s.trackCount; i++) if (!this.tracks[i].data) return i;
    return -1;
  }

  /** Pedal tap: cancel an armed take, else arm the next empty track (Start/Weiter when stopped). */
  async pedalTap() {
    if (this.rec && this.playing && this.nowFrame() < this.rec.S) return this.toggleRec(this.rec.track);
    if (this.rec) return; // recording: the pedal never destroys a running take
    if (this.phase === "paused") return this.resume();
    const i = this.firstEmpty();
    if (i < 0) {
      this.notice = "Alle Spuren sind belegt – Spur löschen oder REC an einer Spur tippen.";
      this.onChange();
      return;
    }
    return this.toggleRec(i);
  }

  /** REC button of a track: arm / cancel arm / abort a running take. */
  async toggleRec(i: number) {
    this.notice = "";
    if (this.rec?.track === i) {
      this.cancelRec();
      return;
    }
    if (this.rec && this.ctx && this.nowFrame() >= this.rec.S && this.playing) {
      this.notice = `Spur ${this.rec.track + 1} nimmt gerade auf.`;
      this.onChange();
      return;
    }
    if (this.rec) this.cancelRec(true);
    await this.prepare();
    const t = this.tracks[i];
    const firstTake = this.masterBars === 0 || (!this.hasAudio && this.pending.length === 0);
    if (firstTake) this.masterBars = t.bars;
    const len = t.bars * this.barF;
    if (this.playing) {
      const S = nextCycleStart(this.nowFrame(), this.t0, this.masterLen, Math.round(MIN_LEAD * this.sr));
      this.setRec({ track: i, S, len, bars: t.bars });
    } else if (firstTake && this.s.onsetStart) {
      this.rec = { track: i, S: Infinity, len, bars: t.bars };
      this.phase = "waiting";
      this.startTimer();
    } else {
      this.startClock();
      this.setRec({ track: i, S: this.t0, len, bars: t.bars });
    }
    this.onChange();
  }

  private setRec(r: Rec) {
    this.rec = r;
    const ctx = this.ctx!;
    const sS = r.S / this.sr;
    const sE = (r.S + r.len) / this.sr;
    this.duck!.gain.cancelScheduledValues(ctx.currentTime);
    this.duck!.gain.setValueAtTime(1, ctx.currentTime);
    this.duck!.gain.setValueAtTime(this.s.duck, sS);
    this.duck!.gain.setValueAtTime(1, sE);
    // a re-recorded track goes silent while the new take is recorded
    const t = this.tracks[r.track];
    if (t.srcGain) {
      t.srcGain.gain.cancelScheduledValues(ctx.currentTime);
      t.srcGain.gain.setValueAtTime(1, ctx.currentTime);
      t.srcGain.gain.setValueAtTime(1, sS);
      t.srcGain.gain.linearRampToValueAtTime(0, sS + 0.01);
    }
  }

  private cancelRec(quiet = false) {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    if (this.ctx) {
      const now = this.ctx.currentTime;
      this.duck!.gain.cancelScheduledValues(now);
      this.duck!.gain.setValueAtTime(1, now);
      const t = this.tracks[r.track];
      if (t.srcGain) {
        t.srcGain.gain.cancelScheduledValues(now);
        t.srcGain.gain.setValueAtTime(1, now);
      }
    }
    if (!this.hasAudio && !this.pending.length) {
      // nothing to play: back to the start screen
      this.stopTimer();
      this.stopClicks();
      this.masterBars = 0;
      this.phase = "idle";
    }
    if (!quiet) this.onChange();
  }

  /** Starts the grid with a count-in; existing tracks start at t0. */
  private startClock() {
    const now = this.nowFrame();
    this.t0 = now + Math.round(this.sr * 0.12 + this.s.countIn * this.barF);
    this.nextBeat = -this.s.countIn * this.meter.beats;
    for (const t of this.tracks) if (t.data) this.startSource(t, this.t0);
    this.phase = "countin";
    this.startTimer();
  }

  async resume() {
    await this.prepare();
    this.startClock();
    this.onChange();
  }

  private beginAtOnset(onset: number) {
    if (!this.rec) return;
    const pre = msToFrames(15, this.sr);
    this.t0 = onset - pre - this.latencyFrames;
    const now = this.ctx!.currentTime * this.sr;
    this.nextBeat = Math.ceil((now - this.t0) / (this.barF / this.meter.beats));
    this.phase = "running";
    this.setRec({ ...this.rec, S: this.t0 });
    this.onChange();
  }

  private stopClicks() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const c of this.clicks) if (c.at > now) c.osc.stop();
    this.clicks = [];
  }

  pause() {
    if (!this.ctx) return;
    this.stopTimer();
    if (this.rec) this.cancelRec(true);
    for (const t of this.tracks) this.stopSource(t);
    this.stopClicks();
    const now = this.ctx.currentTime;
    this.duck!.gain.cancelScheduledValues(now);
    this.duck!.gain.setValueAtTime(1, now);
    this.phase = this.hasAudio || this.pending.length ? "paused" : "idle";
    if (this.phase === "idle") this.masterBars = 0;
    if (this.pending.length) this.timer = setInterval(() => this.flushPending(), 30);
    this.onChange();
  }

  clearAll() {
    this.pause();
    this.stopTimer();
    this.pending = [];
    for (const t of this.tracks) this.clearTrackAudio(t);
    this.history = [];
    this.masterBars = 0;
    this.phase = "idle";
    this.onChange();
  }

  private startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), 15);
    this.tick();
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const ctx = this.ctx!;
    if (this.phase === "waiting") return;
    const now = ctx.currentTime * this.sr;
    const horizon = now + LOOKAHEAD * this.sr;
    // recording window complete on the output side -> hand over to extraction
    if (this.rec && now >= this.rec.S + this.rec.len) {
      const r = this.rec;
      this.rec = null;
      const start = r.S + this.latencyFrames;
      this.pending.push({ ...r, start, end: start + r.len + FADE, phaseBars: Math.round(phaseOf(r.S, this.t0, r.len) / this.barF) });
      this.onChange();
    }
    // metronome
    const beatF = this.barF / this.meter.beats;
    while (this.t0 + this.nextBeat * beatF < horizon) {
      const n = this.nextBeat++;
      const at = this.t0 + n * beatF;
      if (at < now - 64) continue;
      const m = this.s.click;
      const r = this.rec;
      const recBeat = !!r && at < r.S + r.len - 1;
      const play = m === "immer" || n < 0 || (m === "aufnahme" && recBeat);
      if (play && m !== "aus") {
        const inBar = ((n % this.meter.beats) + this.meter.beats) % this.meter.beats;
        this.click(at / this.sr, accentOf(inBar, this.meter), n < 0);
      }
    }
    if (this.phase === "countin" && now >= this.t0) {
      this.phase = "running";
      this.onChange();
    }
    this.flushPending();
  }

  private flushPending() {
    if (!this.ring || !this.ctx) return;
    const keep: Pending[] = [];
    for (const p of this.pending) {
      if (this.ring.has(p.start, p.end)) this.finishTake(p);
      else if (p.start < this.ring.start) continue;
      else keep.push(p);
    }
    this.pending = keep;
    if ((this.phase === "paused" || this.phase === "idle") && !this.pending.length && this.timer) this.stopTimer();
  }

  private finishTake(p: Pending) {
    const raw = this.ring!.read(p.start, p.len + FADE);
    const data = closeLoop(raw, p.len, FADE);
    const t = this.tracks[p.track];
    this.history.push({ track: t.index, prev: t.data ? { data: t.data, bars: t.dataBars, phaseBars: t.phaseBars } : null });
    t.data = data;
    t.dataBars = p.bars;
    t.bars = p.bars;
    t.phaseBars = p.phaseBars;
    t.takes++;
    if (this.playing) {
      const startF = Math.max(this.ctx!.currentTime * this.sr + this.sr * 0.03, p.S + p.len);
      this.startSource(t, startF);
    } else if (this.phase === "idle") this.phase = "paused";
    this.onChange();
  }

  // ---------- tracks ----------

  private bufferFor(t: Track): AudioBuffer {
    const b = this.ctx!.createBuffer(1, t.data!.length, this.sr);
    b.copyToChannel((t.params.reverse ? reverse(t.data!) : t.data!) as Float32Array<ArrayBuffer>, 0);
    return b;
  }

  private startSource(t: Track, whenFrame: number) {
    if (!t.data || !this.ctx) return;
    this.applyTrack(t);
    this.stopSource(t, whenFrame / this.sr);
    const src = this.ctx.createBufferSource();
    src.buffer = this.bufferFor(t);
    src.loop = true;
    const g = this.ctx.createGain();
    src.connect(g).connect(t.chain!.input);
    const when = Math.max(this.ctx.currentTime, whenFrame / this.sr);
    const off = trackPos(Math.round(when * this.sr), this.t0, t.phaseBars * this.barF, t.data.length);
    src.start(when, off / this.sr);
    t.source = src;
    t.srcGain = g;
  }

  private stopSource(t: Track, at?: number) {
    if (!t.source || !this.ctx) return;
    const when = Math.max(this.ctx.currentTime, at ?? 0);
    t.srcGain!.gain.setValueAtTime(t.srcGain!.gain.value, when);
    t.srcGain!.gain.linearRampToValueAtTime(0, when + 0.008);
    t.source.stop(when + 0.01);
    t.source = null;
    t.srcGain = null;
  }

  applyTrack(t: Track, now = false) {
    if (!this.ctx || !this.bus) return;
    if (!t.chain) t.chain = new TrackChain(this.ctx, this.bus);
    const aud = audibleTracks(this.tracks.map((x) => x.params));
    t.chain.set(t.params, this.s.bpm, aud[t.index], now);
  }

  setParam<K extends keyof TrackParams>(i: number, key: K, v: TrackParams[K]) {
    const t = this.tracks[i];
    t.params[key] = v;
    if (key === "solo" || key === "mute") for (const x of this.tracks) this.applyTrack(x);
    else this.applyTrack(t);
    if (key === "reverse" && t.data && this.playing && this.rec?.track !== i) this.startSource(t, this.ctx!.currentTime * this.sr + 0.02 * this.sr);
    this.onChange();
  }

  setMaster(p: Partial<MasterParams>) {
    Object.assign(this.master, p);
    this.bus?.set(this.master, this.s.bpm);
    this.onChange();
  }

  private clearTrackAudio(t: Track) {
    this.stopSource(t);
    t.data = null;
    t.dataBars = 0;
    t.phaseBars = 0;
  }

  deleteTrack(i: number) {
    const t = this.tracks[i];
    if (this.rec?.track === i) this.cancelRec(true);
    this.pending = this.pending.filter((p) => p.track !== i);
    this.history = this.history.filter((h) => h.track !== i);
    this.clearTrackAudio(t);
    t.params = defaultTrackParams();
    this.applyTrack(t);
    this.afterRemoval();
    this.onChange();
  }

  private afterRemoval() {
    if (this.hasAudio || this.rec || this.pending.length) return;
    // all empty: the next take defines a new master cycle, tempo is free again
    this.stopTimer();
    this.stopClicks();
    this.masterBars = 0;
    this.phase = "idle";
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  undo() {
    const h = this.history.pop();
    if (!h) return;
    const t = this.tracks[h.track];
    this.stopSource(t);
    t.data = h.prev?.data ?? null;
    t.dataBars = h.prev?.bars ?? 0;
    if (h.prev) t.bars = h.prev.bars;
    t.phaseBars = h.prev?.phaseBars ?? 0;
    if (t.data && this.playing) this.startSource(t, this.ctx!.currentTime * this.sr + 0.02 * this.sr);
    this.afterRemoval();
    this.onChange();
  }

  // ---------- metronome ----------

  private click(atSec: number, accent: 0 | 1 | 2, countIn: boolean) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = accent === 2 ? 1760 : accent === 1 ? 1320 : 1100;
    const vol = this.s.clickVol * (accent === 2 ? 1 : 0.6) * (countIn ? 1 : 0.85);
    g.gain.setValueAtTime(vol, atSec);
    g.gain.exponentialRampToValueAtTime(0.0008, atSec + 0.05);
    osc.connect(g).connect(this.clickOut!);
    osc.start(atSec);
    osc.stop(atSec + 0.06);
    this.clicks.push({ osc, at: atSec });
    if (this.clicks.length > 64) this.clicks.splice(0, this.clicks.length - 64);
  }

  // ---------- calibration ----------

  async calibrate(count = 10): Promise<LatencyResult> {
    if (this.playing) this.pause();
    const ctx = await this.ensureAudio();
    await this.ensureInput();
    const sr = this.sr;
    const first = ctx.currentTime + 0.4;
    const clickFrames: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = first + i * 0.35;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = 2500;
      g.gain.setValueAtTime(0.9, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.02);
      osc.connect(g).connect(this.outTap!);
      osc.start(at);
      osc.stop(at + 0.03);
      clickFrames.push(Math.round(at * sr));
    }
    const recStart = Math.round((first - 0.2) * sr);
    const recEnd = Math.round((first + count * 0.35 + 0.7) * sr);
    while (!this.ring!.has(recStart, recEnd)) await new Promise((r) => setTimeout(r, 50));
    const rec = this.ring!.read(recStart, recEnd - recStart);
    const res = detectLatency(rec, recStart, clickFrames, sr);
    if (res.ok) this.s.latencyMs = Math.round(res.ms * 10) / 10;
    this.onChange();
    return res;
  }

  // ---------- view ----------

  view(): ViewState {
    const ctx = this.ctx;
    const v: ViewState = {
      phase: this.phase,
      frame: 0,
      bar: 0,
      beat: 0,
      masterBars: this.masterBars,
      masterFrac: 0,
      countIn: 0,
      armed: -1,
      recording: -1,
      toStart: null,
      toEnd: null,
      level: this.level,
      clip: performance.now() < this.clipUntil,
      trackFrac: this.tracks.map(() => 0),
      trackState: this.tracks.map((t) => (t.data ? (audibleTracks(this.tracks.map((x) => x.params))[t.index] ? "playing" : "muted") : "empty")),
    };
    if (this.phase === "waiting" && this.rec) {
      v.armed = this.rec.track;
      v.trackState[this.rec.track] = "armed";
    }
    if (!ctx || !this.barF || !this.playing) return v;
    const lat = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    const f = (ctx.currentTime - lat) * this.sr;
    v.frame = f;
    const beatF = this.barF / this.meter.beats;
    if (f < this.t0) v.countIn = Math.ceil((this.t0 - f) / beatF - 1e-9);
    if (this.masterLen) {
      const pos = trackPos(f, this.t0, 0, this.masterLen);
      v.masterFrac = pos / this.masterLen;
      v.bar = Math.floor(pos / this.barF) + 1;
      v.beat = Math.floor((pos % this.barF) / beatF) + 1;
    }
    this.tracks.forEach((t, i) => {
      if (t.data && f >= this.t0) v.trackFrac[i] = trackPos(f, this.t0, t.phaseBars * this.barF, t.data.length) / t.data.length;
    });
    const r = this.rec ?? this.pending.find((p) => f < p.S + p.len) ?? null;
    if (r) {
      if (f < r.S) {
        v.armed = r.track;
        v.toStart = countdown(f, r.S, this.barF, this.meter.beats);
        v.trackState[r.track] = "armed";
      } else if (f < r.S + r.len) {
        v.recording = r.track;
        v.toEnd = countdown(f, r.S + r.len, this.barF, this.meter.beats);
        v.trackState[r.track] = "recording";
        v.trackFrac[r.track] = (f - r.S) / r.len;
      }
    }
    return v;
  }

  // ---------- export / session ----------

  exportBars(): number {
    return lcmBars(this.tracks.filter((t) => t.data).map((t) => t.dataBars));
  }

  async renderMix(mult: number): Promise<{ channels: Float32Array[]; sampleRate: number; bars: number }> {
    const sr = this.sr;
    const bars = this.exportBars();
    const total = bars * this.barF;
    const off = new OfflineAudioContext(2, total * (mult + 1), sr);
    const bus = new MasterBus(off, this.master, this.s.bpm);
    bus.out.connect(off.destination);
    const aud = audibleTracks(this.tracks.map((x) => x.params));
    for (const t of this.tracks) {
      if (!t.data) continue;
      const ch = new TrackChain(off, bus);
      ch.set(t.params, this.s.bpm, aud[t.index], true);
      const b = off.createBuffer(1, t.data.length, sr);
      b.copyToChannel((t.params.reverse ? reverse(t.data) : t.data) as Float32Array<ArrayBuffer>, 0);
      const src = off.createBufferSource();
      src.buffer = b;
      src.loop = true;
      src.connect(ch.input);
      // render frame `total` = grid position 0 (first block is pre-roll so tails wrap in)
      src.start(0, trackPos(-total, 0, t.phaseBars * this.barF, t.data.length) / sr);
    }
    const out = await off.startRendering();
    return { channels: [out.getChannelData(0).slice(total), out.getChannelData(1).slice(total)], sampleRate: sr, bars: bars * mult };
  }

  snapshot() {
    return {
      v: 2,
      settings: { ...this.s },
      master: { ...this.master },
      sampleRate: this.sr,
      masterBars: this.masterBars,
      tracks: this.tracks.map((t) => ({ data: t.data, bars: t.bars, dataBars: t.dataBars, phaseBars: t.phaseBars, params: { ...t.params } })),
    };
  }

  async restore(snap: ReturnType<Engine["snapshot"]>) {
    this.clearAll();
    const ctx = await this.ensureAudio();
    Object.assign(this.s, snap.settings);
    Object.assign(this.master, snap.master);
    this.setTrackCount(Math.max(this.s.trackCount, snap.tracks.length));
    this.barF = barLength(this.s.bpm, this.meter.beats, ctx.sampleRate);
    this.masterBars = snap.masterBars;
    for (let i = 0; i < snap.tracks.length; i++) {
      const st = snap.tracks[i];
      const t = this.tracks[i];
      t.params = { ...defaultTrackParams(), ...st.params };
      t.bars = st.bars;
      t.dataBars = st.dataBars;
      t.phaseBars = st.phaseBars;
      t.data = st.data ? await resampleTo(st.data, snap.sampleRate, ctx.sampleRate, st.dataBars * this.barF) : null;
      this.applyTrack(t, true);
    }
    this.bus!.set(this.master, this.s.bpm, true);
    this.phase = this.hasAudio ? "paused" : "idle";
    if (!this.hasAudio) this.masterBars = 0;
    this.onChange();
  }
}

async function resampleTo(data: Float32Array, from: number, to: number, len: number): Promise<Float32Array> {
  if (from === to && data.length === len) return data;
  const off = new OfflineAudioContext(1, len, to);
  const b = off.createBuffer(1, data.length, from);
  b.copyToChannel(new Float32Array(data), 0);
  const s = off.createBufferSource();
  s.buffer = b;
  s.connect(off.destination);
  s.start(0);
  const r = await off.startRendering();
  return r.getChannelData(0).slice(0, len);
}
