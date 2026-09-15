// Transport only: downmix PCM and forward exactly 1/60 second per LedFx audio tick.
class LedFxPcm extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(Math.round(sampleRate / 60)); this.offset = 0; }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input?.length) return true;
    for (let channel = 0; channel < output.length; channel++)
      output[channel].set(input[channel] || input[0]);
    for (let i = 0; i < input[0].length; i++) {
      let mono = 0;
      for (const channel of input) mono += channel[i];
      this.block[this.offset++] = mono / input.length;
      if (this.offset === this.block.length) {
        this.port.postMessage(this.block);
        this.block = new Float32Array(this.block.length);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('ledfx-pcm', LedFxPcm);
