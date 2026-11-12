// Looper engine: master clock, auto-advancing recording, sample-exact loops, effects, metronome.
import { METERS, accentOf, alignedOffset, barFrames, beatFrames, beatInfo, cycleStart, loopFrames, msToFrames, recordWindow, type BeatInfo } from "../core/timing.ts";
import { decideCycle, pendingTrack, type CycleAction, type TrackSlot } from "../core/plan.ts";
import { FrameRing } from "../core/ring.ts";
import { closeLoop, reverse } from "../core/seam.ts";
import { detectLatency, type LatencyResult } from "../core/latency.ts";
import { MasterBus, TrackChain, audibleTracks, defaultMasterParams, defaultTrackParams, type MasterParams, type TrackParams } from "./fx.ts";

export type ClickMode = "aus" | "einzaehlen" | "aufnahme" | "immer";
export type PedalB = "undo" | "auto" | "stop";

export interface Settings {
  bpm: number;
  meter: string;
  bars: number;
  trackCount: number;
  gap: number;
  countIn: number;
  click: ClickMode;
  clickVol: number;
  duck: number; // playback level while recording (1 = unchanged, 0 = silent)
  onsetStart: boolean;
  onsetLevel: number;
  latencyMs: number;
  inputGain: number;
  pedalB: PedalB;
}

export const defaultSettings = (): Settings => ({
  bpm: 90,
  meter: "4/4",
  bars: 4,
  trackCount: 4,
  gap: 1,
  countIn: 1,
  click: "aufnahme",
  clickVol: 0.6,
  duck: 1,
  onsetStart: false,
  onsetLevel: 0.12,
  latencyMs: 0,
  inputGain: 1,
  pedalB: "undo",
});

export type Phase = "idle" | "armed" | "countin" | "running" | "paused";

export interface Track {
  index: number;
  data: Float32Array | null; // forward audio, exactly loopLen frames
  params: TrackParams;
  chain: TrackChain | null;
  source: AudioBufferSourceNode | null;
  srcGain: GainNode | null;
  rerecord: boolean;
  busy: boolean;
  takes: number;
}

interface Pending {
  track: number;
  cycle: number;
  start: number;
  end: number;
}

export interface ViewState {
  phase: Phase;
  beat: BeatInfo | null;
  countInLeft: number; // beats left in count-in
  action: CycleAction | null;
  recording: number; // track index being recorded now, -1 if none
  nextRecord: { track: number; inCycles: number } | null;
  level: number;
  clip: boolean;
  autoRecord: boolean;
}

const FADE = 256; // seam crossfade (frames)
const LOOKAHEAD = 0.25; // s

export class Engine {
  s: Settings;
  master: MasterParams = defaultMasterParams();
  tracks: Track[] = [];
  ctx: AudioContext | null = null;
  phase: Phase = "idle";
  autoRecord = true;
  loopLen = 0;
  t0 = 0;
  level = 0;
  clipUntil = 0;
  micError = "";
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
  private nextCycle = 0;
  private nextBeat = 0;
  private since = Infinity;
  private actions = new Map<number, CycleAction>();
  private pending: Pending[] = [];
  private clicks: { osc: OscillatorNode; at: number }[] = [];
  private history: { track: number; prev: Float32Array | null }[] = [];
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

  get latencyFrames(): number {
    return msToFrames(this.s.latencyMs, this.sr);
  }

  computeLoopLen(): number {
    return loopFrames(this.s.bpm, this.meter.beats, this.s.bars, this.sr);
  }

  setTrackCount(n: number) {
    this.s.trackCount = n;
    while (this.tracks.length < n) this.tracks.push(this.newTrack(this.tracks.length));
    this.onChange();
  }

  private newTrack(index: number): Track {
    return { index, data: null, params: defaultTrackParams(), chain: null, source: null, srcGain: null, rerecord: false, busy: false, takes: 0 };
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
    if (!this.inputReady) this.inputReady = this.openInput().catch((e) => {
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
    if (this.phase === "armed" && pk >= this.s.onsetLevel) {
      const onset = this.ring!.findOnset(frame, this.s.onsetLevel);
      if (onset >= 0) this.beginAtOnset(onset);
    }
  }

  // ---------- transport ----------

  /** One tap: Start (idle) / Stopp (running) / Weiter (paused). */
  async mainAction() {
    if (this.phase === "running" || this.phase === "countin" || this.phase === "armed") this.pause();
    else await this.start();
  }

  async start() {
    const ctx = await this.ensureAudio();
    try {
      await this.ensureInput();
    } catch (e) {
      this.micError = (e as Error).name === "NotAllowedError" ? "Mikrofon nicht erlaubt" : "Kein Mikrofon: " + (e as Error).message;
      this.onChange();
      throw e;
    }
    if (!this.hasAudio) this.loopLen = this.computeLoopLen();
    this.bus!.set(this.master, this.s.bpm);
    this.resetSchedule();
    if (this.s.onsetStart && !this.hasAudio) {
      this.phase = "armed";
      this.startTimer();
      this.onChange();
      return;
    }
    const now = Math.round(ctx.currentTime * this.sr);
    const bar = barFrames(this.loopLen, this.s.bars);
    this.t0 = now + Math.round(this.sr * 0.12 + this.s.countIn * bar);
    this.nextBeat = -this.s.countIn * this.meter.beats;
    for (const t of this.tracks) if (t.data) this.startSource(t, this.t0);
    this.phase = "countin";
    this.startTimer();
    this.onChange();
  }

  private beginAtOnset(onset: number) {
    const pre = msToFrames(15, this.sr);
    this.t0 = onset - pre - this.latencyFrames;
    const now = this.ctx!.currentTime * this.sr;
    const bf = beatFrames(this.loopLen, this.meter.beats, this.s.bars);
    this.nextBeat = Math.ceil((now - this.t0) / bf);
    this.phase = "running";
    this.onChange();
  }

  pause() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const nowF = now * this.sr;
    this.stopTimer();
    for (const t of this.tracks) this.stopSource(t);
    for (const c of this.clicks) if (c.at > now) c.osc.stop();
    this.clicks = [];
    this.pending = this.pending.filter((p) => p.end - this.latencyFrames <= nowF);
    for (const t of this.tracks) t.busy = this.pending.some((p) => p.track === t.index);
    this.duck!.gain.cancelScheduledValues(now);
    this.duck!.gain.setValueAtTime(1, now);
    this.phase = this.hasAudio || this.pending.length ? "paused" : "idle";
    this.timer = setInterval(() => this.flushPending(), 30); // finish takes that ended before the stop
    this.onChange();
  }

  /** Stop everything and wipe all tracks. */
  clearAll() {
    this.pause();
    this.stopTimer();
    this.pending = [];
    for (const t of this.tracks) this.clearTrackAudio(t);
    this.history = [];
    this.phase = "idle";
    this.onChange();
  }

  setAutoRecord(on: boolean) {
    this.autoRecord = on;
    this.onChange();
  }

  private resetSchedule() {
    this.nextCycle = 0;
    this.since = Infinity;
    this.actions.clear();
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

  private slots(): TrackSlot[] {
    return this.tracks.map((t) => ({ hasAudio: !!t.data || t.busy, rerecord: t.rerecord && !t.busy }));
  }

  private tick() {
    const ctx = this.ctx!;
    const now = ctx.currentTime * this.sr;
    if (this.phase === "armed") return;
    const horizon = now + LOOKAHEAD * this.sr;
    // cycle decisions
    while (cycleStart(this.nextCycle, this.t0, this.loopLen) < horizon) {
      const c = this.nextCycle++;
      const a = decideCycle({ slots: this.slots(), trackCount: this.s.trackCount, gap: this.s.gap, autoRecord: this.autoRecord, cyclesSinceRecord: this.since });
      this.actions.set(c, a);
      this.actions.delete(c - 4);
      const startSec = Math.max(ctx.currentTime, cycleStart(c, this.t0, this.loopLen) / this.sr);
      this.duck!.gain.setValueAtTime(a.kind === "record" ? this.s.duck : 1, startSec);
      if (a.kind === "record") {
        const w = recordWindow(c, this.t0, this.loopLen, this.latencyFrames, FADE);
        this.pending.push({ track: a.track, cycle: c, start: w.start, end: w.end });
        this.tracks[a.track].busy = true;
        this.since = 0;
      } else this.since++;
      this.onChange();
    }
    // metronome
    const bf = beatFrames(this.loopLen, this.meter.beats, this.s.bars);
    while (this.t0 + this.nextBeat * bf < horizon) {
      const n = this.nextBeat++;
      const at = this.t0 + n * bf;
      if (at < now - 64) continue;
      const cyc = Math.floor(n / (this.meter.beats * this.s.bars));
      const act = this.actions.get(cyc);
      const m = this.s.click;
      const play = m === "immer" || n < 0 || (m === "aufnahme" && act?.kind === "record");
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
      else if (p.start < this.ring.start) this.tracks[p.track].busy = false;
      else keep.push(p);
    }
    this.pending = keep;
    if (this.phase === "paused" || this.phase === "idle") {
      if (!this.pending.length && this.timer) this.stopTimer();
    }
  }

  private finishTake(p: Pending) {
    const raw = this.ring!.read(p.start, this.loopLen + FADE);
    const data = closeLoop(raw, this.loopLen, FADE);
    const t = this.tracks[p.track];
    this.history.push({ track: t.index, prev: t.rerecord ? t.data : null });
    t.data = data;
    t.rerecord = false;
    t.busy = false;
    t.takes++;
    if (this.phase === "running" || this.phase === "countin") {
      const startF = Math.max(this.ctx!.currentTime * this.sr + this.sr * 0.03, p.end - FADE - this.latencyFrames);
      this.startSource(t, startF);
    }
    this.onChange();
  }

  // ---------- tracks ----------

  private bufferFor(t: Track): AudioBuffer {
    const b = this.ctx!.createBuffer(1, this.loopLen, this.sr);
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
    const off = alignedOffset(Math.round(when * this.sr), this.t0, this.loopLen);
    src.start(when, off / this.sr);
    t.source = src;
    t.srcGain = g;
  }

  private stopSource(t: Track, at?: number) {
    if (!t.source || !this.ctx) return;
    const when = Math.max(this.ctx.currentTime, at ?? 0);
    t.srcGain!.gain.setValueAtTime(1, when);
    t.srcGain!.gain.linearRampToValueAtTime(0, when + 0.008);
    t.source.stop(when + 0.01);
    t.source = null;
    t.srcGain = null;
  }

  private get playing() {
    return this.phase === "running" || this.phase === "countin";
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
    if (key === "reverse" && t.data && this.playing) this.startSource(t, this.ctx!.currentTime * this.sr + 0.02 * this.sr);
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
    t.rerecord = false;
    t.busy = false;
  }

  deleteTrack(i: number) {
    const t = this.tracks[i];
    this.pending = this.pending.filter((p) => p.track !== i);
    this.history = this.history.filter((h) => h.track !== i);
    this.clearTrackAudio(t);
    t.params = defaultTrackParams();
    this.applyTrack(t);
    if (!this.hasAudio && this.phase === "paused") this.phase = "idle";
    this.onChange();
  }

  rerecordTrack(i: number) {
    const t = this.tracks[i];
    t.rerecord = !t.rerecord;
    this.onChange();
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  undo() {
    const h = this.history.pop();
    if (!h) return;
    const t = this.tracks[h.track];
    this.stopSource(t);
    t.data = h.prev;
    if (t.data && this.playing) this.startSource(t, this.ctx!.currentTime * this.sr + 0.02 * this.sr);
    if (!this.hasAudio && this.phase === "paused") this.phase = "idle";
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
    let beat: BeatInfo | null = null;
    let countInLeft = 0;
    let action: CycleAction | null = null;
    let nextRecord: ViewState["nextRecord"] = null;
    if (ctx && this.loopLen && (this.phase === "running" || this.phase === "countin")) {
      const lat = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
      const f = (ctx.currentTime - lat) * this.sr;
      beat = beatInfo(f, this.t0, this.loopLen, this.meter.beats, this.s.bars);
      if (beat.countIn) {
        const bf = beatFrames(this.loopLen, this.meter.beats, this.s.bars);
        countInLeft = Math.ceil((this.t0 - f) / bf);
      }
      action = this.actions.get(Math.max(0, beat.cycle)) ?? null;
      if (beat.countIn) action = this.actions.get(0) ?? null;
      if (action?.kind === "listen") nextRecord = { track: action.track, inCycles: action.nextRecordIn };
      else if (action?.kind === "record" || action?.kind === "play") {
        const nxt = this.actions.get(beat.cycle + 1);
        if (nxt?.kind === "record") nextRecord = { track: nxt.track, inCycles: 1 };
      }
    }
    if (this.phase === "armed") {
      const t = pendingTrack(this.slots(), this.s.trackCount);
      nextRecord = t >= 0 ? { track: t, inCycles: 0 } : null;
    }
    return {
      phase: this.phase,
      beat,
      countInLeft,
      action,
      recording: action?.kind === "record" && beat && !beat.countIn ? action.track : -1,
      nextRecord,
      level: this.level,
      clip: performance.now() < this.clipUntil,
      autoRecord: this.autoRecord,
    };
  }

  // ---------- export / session ----------

  async renderMix(cycles: number): Promise<{ channels: Float32Array[]; sampleRate: number }> {
    const sr = this.sr;
    const L = this.loopLen;
    const off = new OfflineAudioContext(2, L * (cycles + 1), sr);
    const bus = new MasterBus(off, this.master, this.s.bpm);
    bus.out.connect(off.destination);
    const aud = audibleTracks(this.tracks.map((x) => x.params));
    for (const t of this.tracks) {
      if (!t.data) continue;
      const ch = new TrackChain(off, bus);
      ch.set(t.params, this.s.bpm, aud[t.index], true);
      const b = off.createBuffer(1, L, sr);
      b.copyToChannel((t.params.reverse ? reverse(t.data) : t.data) as Float32Array<ArrayBuffer>, 0);
      const src = off.createBufferSource();
      src.buffer = b;
      src.loop = true;
      src.connect(ch.input);
      src.start(0);
    }
    const out = await off.startRendering();
    // first cycle is pre-roll so reverb/echo tails wrap into the exported loop
    return { channels: [out.getChannelData(0).slice(L), out.getChannelData(1).slice(L)], sampleRate: sr };
  }

  snapshot() {
    return {
      v: 1,
      settings: { ...this.s },
      master: { ...this.master },
      sampleRate: this.sr,
      loopLen: this.loopLen,
      tracks: this.tracks.map((t) => ({ data: t.data, params: { ...t.params } })),
    };
  }

  async restore(snap: ReturnType<Engine["snapshot"]>) {
    this.clearAll();
    const ctx = await this.ensureAudio();
    Object.assign(this.s, snap.settings);
    Object.assign(this.master, snap.master);
    this.setTrackCount(Math.max(this.s.trackCount, snap.tracks.length));
    this.loopLen = this.computeLoopLen();
    for (let i = 0; i < snap.tracks.length; i++) {
      const st = snap.tracks[i];
      const t = this.tracks[i];
      t.params = { ...defaultTrackParams(), ...st.params };
      t.data = st.data ? await resampleTo(st.data, snap.sampleRate, ctx.sampleRate, this.loopLen) : null;
      this.applyTrack(t, true);
    }
    this.bus!.set(this.master, this.s.bpm, true);
    this.phase = this.hasAudio ? "paused" : "idle";
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
