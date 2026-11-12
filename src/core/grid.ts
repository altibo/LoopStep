// Pure helpers for the bar grid shared by all tracks (track lengths are whole bars of barF frames).

/** Whole-frame bar length; all track lengths are exact multiples, so nothing drifts. */
export function barLength(bpm: number, beats: number, sampleRate: number): number {
  return Math.round(((sampleRate * 60) / bpm) * beats);
}

function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

/** First master-cycle start (t0 + k*M) at or after `frame + minLead`. */
export function nextCycleStart(frame: number, t0: number, master: number, minLead = 0): number {
  const k = Math.ceil((frame + minLead - t0) / master);
  return t0 + k * master;
}

/** Position inside a track's own loop. phase = grid offset (frames) at which the track's loop begins. */
export function trackPos(frame: number, t0: number, phase: number, len: number): number {
  return mod(frame - t0 - phase, len);
}

/** Phase of a take that started at output frame S. */
export function phaseOf(S: number, t0: number, len: number): number {
  return mod(S - t0, len);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Least common multiple of bar counts, capped (returns max if the LCM would exceed cap). */
export function lcmBars(bars: number[], cap = 64): number {
  if (!bars.length) return 0;
  let l = bars[0];
  for (const b of bars.slice(1)) l = (l / gcd(l, b)) * b;
  return l > cap ? Math.max(...bars) : l;
}

export interface Countdown {
  bars: number; // whole bars still to go (rounded up)
  beats: number; // beats still to go (rounded up)
  show: number; // number for the big display: bars while > 1 bar is left, then beats
  unit: "Takte" | "Takt" | "Schläge" | "Schlag";
}

/** Countdown from `frame` to `target` (both output frames). */
export function countdown(frame: number, target: number, barF: number, beats: number): Countdown {
  const left = Math.max(0, target - frame);
  const beatF = barF / beats;
  const nb = Math.ceil(left / beatF - 1e-9);
  const nbar = Math.ceil(left / barF - 1e-9);
  if (nb > beats) return { bars: nbar, beats: nb, show: nbar, unit: nbar === 1 ? "Takt" : "Takte" };
  return { bars: nbar, beats: nb, show: nb, unit: nb === 1 ? "Schlag" : "Schläge" };
}
