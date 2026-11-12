// Streams mono microphone frames to the main thread, stamped with the absolute AudioContext frame
// (currentFrame), so recordings can be cut sample-exactly against the master clock.
class LoopStepRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.startFrame = 0;
    this.peak = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const frames = 128;
    if (this.n === 0) this.startFrame = currentFrame;
    const a = input && input[0];
    const b = input && input[1];
    for (let i = 0; i < frames; i++) {
      const s = a ? (b ? (a[i] + b[i]) * 0.5 : a[i]) : 0;
      this.buf[this.n + i] = s;
      const m = s < 0 ? -s : s;
      if (m > this.peak) this.peak = m;
    }
    this.n += frames;
    if (this.n >= this.size) {
      this.port.postMessage({ frame: this.startFrame, data: this.buf, peak: this.peak }, [this.buf.buffer]);
      this.buf = new Float32Array(this.size);
      this.n = 0;
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor("loopstep-recorder", LoopStepRecorder);
