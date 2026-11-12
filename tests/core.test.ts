import { test } from "node:test";
import assert from "node:assert/strict";
import { METERS, accentOf, alignedOffset, beatFrames, beatInfo, clampBpm, cycleAt, loopFrames, loopPos, recordWindow, syncedDelay, tapTempo } from "../src/core/timing.ts";
import { barLength, countdown, lcmBars, nextCycleStart, phaseOf, trackPos } from "../src/core/grid.ts";
import { FrameRing } from "../src/core/ring.ts";
import { closeLoop, maxStep, reverse } from "../src/core/seam.ts";
import { detectLatency } from "../src/core/latency.ts";
import { encodeWav } from "../src/core/wav.ts";

test("loop length is exact whole frames", () => {
  assert.equal(loopFrames(120, 4, 4, 48000), 384000); // 8 s
  assert.equal(loopFrames(90, 3, 2, 44100), 176400); // 4 s
  assert.equal(loopFrames(100, 4, 1, 48000), 115200);
  const odd = loopFrames(97, 7, 3, 48000);
  assert.ok(Number.isInteger(odd));
  assert.ok(Math.abs(odd - (48000 * 60 * 21) / 97) <= 0.5);
});

test("beat grid derives from loop length (no drift after many cycles)", () => {
  const L = loopFrames(97, 4, 4, 48000);
  const bf = beatFrames(L, 4, 4);
  assert.equal(bf * 16, L);
  // beat 0 of cycle 1000 lands exactly on the cycle start
  const t0 = 12345;
  const info = beatInfo(t0 + 1000 * L, t0, L, 4, 4);
  assert.deepEqual([info.cycle, info.bar, info.beat], [1000, 1, 1]);
});

test("beatInfo, count-in and positions", () => {
  const L = 4 * 48000; // 4 beats at 60 BPM, 1 bar
  const i = beatInfo(-1, 0, L, 4, 1);
  assert.equal(i.countIn, true);
  assert.equal(i.beat, 4);
  assert.equal(cycleAt(-1, 0, L), -1);
  assert.equal(loopPos(-1, 0, L), L - 1);
  assert.equal(beatInfo(48000 * 2.5, 0, L, 4, 1).beat, 3);
  assert.equal(beatInfo(48000 * 5, 0, L * 2, 4, 2).bar, 2);
});

test("latency compensated record window and aligned playback offset", () => {
  const w = recordWindow(3, 1000, 48000, 7200, 256);
  assert.equal(w.start, 1000 + 3 * 48000 + 7200);
  assert.equal(w.end - w.start, 48000 + 256);
  assert.equal(alignedOffset(1000 + 5 * 48000 + 17, 1000, 48000), 17);
});

test("accents, clamp, tap tempo, synced delay", () => {
  assert.equal(accentOf(0, METERS["4/4"]), 2);
  assert.equal(accentOf(3, METERS["6/8"]), 1);
  assert.equal(accentOf(1, METERS["4/4"]), 0);
  assert.equal(clampBpm(10), 40);
  assert.equal(clampBpm(999), 240);
  assert.equal(tapTempo([0, 500, 1000, 1500]), 120);
  assert.equal(tapTempo([0, 500]), null);
  assert.equal(syncedDelay(120, "1/8."), 0.375);
});

test("grid: whole-frame bars, next loop start, minimum lead", () => {
  assert.equal(barLength(120, 4, 48000), 96000);
  assert.equal(barLength(97, 4, 44100), Math.round((44100 * 60 * 4) / 97));
  const t0 = 5000, M = 4 * 96000;
  // REC pressed in the middle of cycle 2 -> starts exactly at the start of cycle 3
  assert.equal(nextCycleStart(t0 + 2 * M + 123456, t0, M), t0 + 3 * M);
  // exactly on a start counts as that start; too close (inside the lead) waits for the next
  assert.equal(nextCycleStart(t0 + 3 * M, t0, M), t0 + 3 * M);
  assert.equal(nextCycleStart(t0 + 3 * M - 100, t0, M, 2880), t0 + 4 * M);
  // during count-in (before t0) the first start is t0
  assert.equal(nextCycleStart(t0 - 90000, t0, M), t0);
});

test("grid: per-track lengths stay phase-locked", () => {
  const bar = 96000, t0 = 1000, M = 4 * bar;
  // an 8-bar track recorded from cycle 3 (odd cycle) has phase 4 bars
  const L8 = 8 * bar;
  const S = t0 + 3 * M;
  assert.equal(phaseOf(S, t0, L8), 4 * bar);
  // its loop restarts exactly on every second master cycle after S, forever
  for (const k of [0, 2, 4, 1000]) assert.equal(trackPos(S + k * M, t0, 4 * bar, L8), 0);
  assert.equal(trackPos(S + M, t0, 4 * bar, L8), M);
  // a 1-bar track restarts on every bar line of the master
  for (let k = 0; k < 9; k++) assert.equal(trackPos(t0 + k * bar, t0, phaseOf(t0 + 2 * M, t0, bar), bar), 0);
});

test("grid: LCM of track lengths for export and countdown display", () => {
  assert.equal(lcmBars([4, 8, 1]), 8);
  assert.equal(lcmBars([3, 4]), 12);
  assert.equal(lcmBars([16, 5, 7]), 16); // 560 bars > cap -> longest track
  const bar = 4800 * 4; // 4 beats of 4800
  assert.deepEqual(countdown(0, 3 * bar, bar, 4), { bars: 3, beats: 12, show: 3, unit: "Takte" });
  assert.deepEqual(countdown(2 * bar + 1, 3 * bar, bar, 4), { bars: 1, beats: 4, show: 4, unit: "Schläge" });
  assert.deepEqual(countdown(3 * bar - 10, 3 * bar, bar, 4), { bars: 1, beats: 1, show: 1, unit: "Schlag" });
});

test("ring buffer keeps absolute frame stamps, handles gaps and wrap", () => {
  const r = new FrameRing(1000);
  const blk = (start: number, n: number) => Float32Array.from({ length: n }, (_, i) => (start + i) / 1e6);
  for (let f = 5000; f < 7000; f += 128) r.write(f, blk(f, 128));
  assert.equal(r.end, 5000 + Math.ceil(2000 / 128) * 128);
  assert.ok(!r.has(5000, 5100)); // overwritten
  const end = r.end;
  assert.ok(r.has(end - 900, end));
  const got = r.read(end - 900, 900);
  for (let i = 0; i < 900; i++) assert.equal(got[i], Math.fround((end - 900 + i) / 1e6));
  r.write(end + 100, blk(end + 100, 128)); // gap of 100 frames -> silence
  const g = r.read(end, 228);
  assert.equal(g[50], 0);
  assert.equal(g[100], Math.fround((end + 100) / 1e6));
  assert.equal(r.findOnset(end + 50, 0.001), end + 100);
});

test("loop seam: exact length and continuity at the wrap", () => {
  const L = 4800;
  const raw = Float32Array.from({ length: L + 256 }, (_, i) => Math.sin((2 * Math.PI * 441 * i) / 48000 + 0.3) * 0.8 + Math.sin(i / 37) * 0.1);
  const closed = closeLoop(raw, L, 256);
  assert.equal(closed.length, L);
  assert.ok(maxStep(raw.slice(0, L)) > 0.1, "raw loop has a jump at the wrap");
  assert.ok(maxStep(closed) < 0.12, `closed loop step ${maxStep(closed)}`);
  assert.equal(closed[L - 1], raw[L - 1]);
  assert.deepEqual(reverse(Float32Array.of(1, 2, 3)), Float32Array.of(3, 2, 1));
});

test("latency detection finds the round trip sample-accurately", () => {
  const sr = 48000;
  const lag = 6321;
  const recStart = 100000;
  const rec = new Float32Array(sr * 5);
  let seed = 1;
  for (let i = 0; i < rec.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rec[i] = (seed / 2 ** 32 - 0.5) * 0.004;
  }
  const clicks: number[] = [];
  for (let k = 0; k < 10; k++) {
    const c = recStart + 9600 + k * 16800;
    clicks.push(c);
    const at = c - recStart + lag + (k === 3 ? 40 : 0);
    for (let j = 0; j < 400; j++) rec[at + j] += Math.sin((2 * Math.PI * 2500 * j) / sr + Math.PI / 2) * Math.exp(-j / 120) * 0.5;
  }
  const r = detectLatency(rec, recStart, clicks, sr);
  assert.equal(r.ok, true);
  assert.equal(r.frames, lag);
  assert.ok(Math.abs(r.ms - (lag / sr) * 1000) < 1e-9);
  const silent = detectLatency(new Float32Array(sr * 5), recStart, clicks, sr);
  assert.equal(silent.ok, false);
});

test("WAV encoder writes a valid 16-bit header", () => {
  const buf = encodeWav([Float32Array.of(0, 1, -1), Float32Array.of(0.5, 0, 0)], 48000);
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44 + 3 * 2 * 2);
  assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), "RIFF");
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getInt16(44 + 4, true), 32767);
  assert.equal(v.getInt16(44 + 8, true), -32768);
});
