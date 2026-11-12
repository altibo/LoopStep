// Pure timing math. All positions are in audio frames of the AudioContext clock.

export interface Meter {
  beats: number; // beats per bar (numerator)
  unit: number; // 4 or 8 (only affects accents/labels; BPM always counts the beat unit)
}

export const METERS: Record<string, Meter> = {
  "2/4": { beats: 2, unit: 4 },
  "3/4": { beats: 3, unit: 4 },
  "4/4": { beats: 4, unit: 4 },
  "5/4": { beats: 5, unit: 4 },
  "6/8": { beats: 6, unit: 8 },
  "7/8": { beats: 7, unit: 8 },
  "12/8": { beats: 12, unit: 8 },
};

export const BPM_MIN = 40;
export const BPM_MAX = 240;

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 100;
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
}

/** Exact loop length in whole frames. Beat grid is derived from this so it never drifts against the loop. */
export function loopFrames(bpm: number, beats: number, bars: number, sampleRate: number): number {
  return Math.round(((sampleRate * 60) / bpm) * beats * bars);
}

export function beatFrames(loopLen: number, beats: number, bars: number): number {
  return loopLen / (beats * bars);
}

export function barFrames(loopLen: number, bars: number): number {
  return loopLen / bars;
}

/** Cycle index (can be negative during count-in) for an absolute frame. */
export function cycleAt(frame: number, t0: number, loopLen: number): number {
  return Math.floor((frame - t0) / loopLen);
}

export function cycleStart(cycle: number, t0: number, loopLen: number): number {
  return t0 + cycle * loopLen;
}

/** Position inside the loop, 0..loopLen-1, also for frames before t0. */
export function loopPos(frame: number, t0: number, loopLen: number): number {
  const p = (frame - t0) % loopLen;
  return p < 0 ? p + loopLen : p;
}

export interface BeatInfo {
  cycle: number;
  bar: number; // 1-based bar within the loop
  beat: number; // 1-based beat within the bar
  frac: number; // 0..1 progress through the loop
  countIn: boolean;
}

export function beatInfo(frame: number, t0: number, loopLen: number, beats: number, bars: number): BeatInfo {
  const cycle = cycleAt(frame, t0, loopLen);
  const pos = loopPos(frame, t0, loopLen);
  const bf = beatFrames(loopLen, beats, bars);
  const beatIdx = Math.min(beats * bars - 1, Math.floor(pos / bf));
  return {
    cycle,
    bar: Math.floor(beatIdx / beats) + 1,
    beat: (beatIdx % beats) + 1,
    frac: pos / loopLen,
    countIn: frame < t0,
  };
}

/** Accent level of a beat: 2 = downbeat, 1 = secondary (compound meters), 0 = normal. */
export function accentOf(beatInBar: number, meter: Meter): 0 | 1 | 2 {
  if (beatInBar === 0) return 2;
  if (meter.unit === 8 && meter.beats % 3 === 0 && beatInBar % 3 === 0) return 1;
  if (meter.beats === 7 && meter.unit === 8 && (beatInBar === 2 || beatInBar === 4)) return 1;
  return 0;
}

/** Recording window in microphone frames for a cycle, compensated by round-trip latency. */
export function recordWindow(cycle: number, t0: number, loopLen: number, latencyFrames: number, tail: number) {
  const start = cycleStart(cycle, t0, loopLen) + latencyFrames;
  return { start, end: start + loopLen + tail };
}

/** Where to start a looping source so it lines up with the grid: offset in frames for a given start frame. */
export function alignedOffset(startFrame: number, t0: number, loopLen: number): number {
  return loopPos(startFrame, t0, loopLen);
}

export function msToFrames(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

/** Tap tempo: median interval of the last taps (ms timestamps). */
export function tapTempo(taps: number[]): number | null {
  if (taps.length < 3) return null;
  const iv: number[] = [];
  for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
  iv.sort((a, b) => a - b);
  const med = iv[Math.floor(iv.length / 2)];
  if (med <= 0) return null;
  return clampBpm(60000 / med);
}

/** Tempo-synced delay time in seconds. */
export function syncedDelay(bpm: number, division: "1/8" | "1/8." | "1/4" | "1/16"): number {
  const q = 60 / bpm;
  return { "1/16": q / 4, "1/8": q / 2, "1/8.": (q * 3) / 4, "1/4": q }[division];
}
