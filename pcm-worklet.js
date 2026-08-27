// Runs on the audio rendering thread of a 16 kHz AudioContext: converts the
// mixed meeting audio to 16-bit PCM and ships it to the main thread in
// ~128 ms chunks (2048 samples at 16 kHz).
class PCM16Worklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2048);
    this.n = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      let s = channel[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this.buffer[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buffer.length) {
        const out = this.buffer.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm16', PCM16Worklet);
