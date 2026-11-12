// Ring buffer of microphone frames stamped with absolute AudioContext frame numbers.
export class FrameRing {
  readonly capacity: number;
  private buf: Float32Array;
  /** Absolute frame number one past the newest frame written. */
  end = 0;
  /** Absolute frame number of the oldest valid frame. */
  start = 0;
  private started = false;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  write(frame: number, data: Float32Array): void {
    if (!this.started) {
      this.start = frame;
      this.end = frame;
      this.started = true;
    }
    if (frame > this.end) {
      // gap (dropped batch): fill with silence
      this.fill(this.end, frame - this.end);
    }
    let from = 0;
    if (frame < this.end) from = this.end - frame; // overlap: skip already written frames
    for (let i = from; i < data.length; i++) this.buf[(frame + i) % this.capacity] = data[i];
    this.end = Math.max(this.end, frame + data.length);
    this.start = Math.max(this.start, this.end - this.capacity);
  }

  private fill(frame: number, n: number) {
    for (let i = 0; i < Math.min(n, this.capacity); i++) this.buf[(frame + i) % this.capacity] = 0;
  }

  has(startFrame: number, endFrame: number): boolean {
    return this.started && startFrame >= this.start && endFrame <= this.end;
  }

  /** Copies [startFrame, startFrame+len) – frames outside the stored range read as silence. */
  read(startFrame: number, len: number): Float32Array {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const f = startFrame + i;
      if (f >= this.start && f < this.end) out[i] = this.buf[((f % this.capacity) + this.capacity) % this.capacity];
    }
    return out;
  }

  /** First absolute frame >= from whose |sample| exceeds threshold, or -1. */
  findOnset(from: number, threshold: number): number {
    for (let f = Math.max(from, this.start); f < this.end; f++) {
      if (Math.abs(this.buf[f % this.capacity]) >= threshold) return f;
    }
    return -1;
  }
}
