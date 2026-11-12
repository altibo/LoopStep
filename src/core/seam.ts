// Click-free loop seam: the audio recorded just after the loop end is cross-faded into the loop start,
// so the wrap from the last to the first sample continues the original performance.

/** raw must contain loopLen + fade frames. Returns exactly loopLen frames. */
export function closeLoop(raw: Float32Array, loopLen: number, fade: number): Float32Array {
  const out = raw.slice(0, loopLen);
  const f = Math.min(fade, loopLen, raw.length - loopLen);
  for (let i = 0; i < f; i++) {
    const x = (i + 0.5) / f;
    const fadeIn = Math.sin((x * Math.PI) / 2);
    const fadeOut = Math.cos((x * Math.PI) / 2);
    out[i] = raw[i] * fadeIn + raw[loopLen + i] * fadeOut;
  }
  return out;
}

export function reverse(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[data.length - 1 - i];
  return out;
}

export function peak(data: Float32Array): number {
  let m = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > m) m = a;
  }
  return m;
}

/** Largest jump between neighbouring samples, including the wrap from end to start. */
export function maxStep(data: Float32Array, wrap = true): number {
  let m = 0;
  for (let i = 1; i < data.length; i++) m = Math.max(m, Math.abs(data[i] - data[i - 1]));
  if (wrap && data.length > 1) m = Math.max(m, Math.abs(data[0] - data[data.length - 1]));
  return m;
}
