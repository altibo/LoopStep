// Round-trip latency detection from a loopback measurement (speaker click -> microphone).

export interface LatencyResult {
  frames: number;
  ms: number;
  hits: number;
  spreadMs: number;
  ok: boolean;
}

/**
 * recorded: mic frames starting at absolute frame recStart.
 * clicks: absolute frames at which the clicks were scheduled on the output.
 * For each click the onset is the first sample within the search window that exceeds
 * max(rel * windowPeak, noiseFloor * 4).
 */
export function detectLatency(
  recorded: Float32Array,
  recStart: number,
  clicks: number[],
  sampleRate: number,
  opts: { maxMs?: number; rel?: number; minPeak?: number } = {},
): LatencyResult {
  const maxF = Math.round(((opts.maxMs ?? 600) / 1000) * sampleRate);
  const rel = opts.rel ?? 0.5;
  const minPeak = opts.minPeak ?? 0.02;
  // noise floor: RMS of the part before the first click
  const pre = Math.max(0, Math.min(recorded.length, clicks[0] - recStart));
  let ns = 0;
  for (let i = 0; i < pre; i++) ns += recorded[i] * recorded[i];
  const noise = pre > 0 ? Math.sqrt(ns / pre) : 0;
  const lags: number[] = [];
  for (const c of clicks) {
    const a = c - recStart;
    const b = Math.min(recorded.length, a + maxF);
    if (a < 0 || a >= recorded.length) continue;
    let pk = 0;
    for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(recorded[i]));
    if (pk < minPeak || pk < noise * 6) continue;
    const thr = Math.max(pk * rel, noise * 4);
    for (let i = a; i < b; i++) {
      if (Math.abs(recorded[i]) >= thr) {
        lags.push(i - a);
        break;
      }
    }
  }
  if (lags.length === 0) return { frames: 0, ms: 0, hits: 0, spreadMs: 0, ok: false };
  const s = [...lags].sort((x, y) => x - y);
  const med = s[Math.floor(s.length / 2)];
  const close = s.filter((l) => Math.abs(l - med) <= sampleRate * 0.01);
  const spread = (s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] - s[Math.floor(s.length * 0.1)]) / sampleRate * 1000;
  return {
    frames: med,
    ms: (med / sampleRate) * 1000,
    hits: lags.length,
    spreadMs: spread,
    ok: close.length >= Math.max(3, Math.ceil(clicks.length / 2)),
  };
}
