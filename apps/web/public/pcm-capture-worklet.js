class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetSampleRate ?? 16000;
    this.ratio = sampleRate / this.targetRate;
    this.nextSourcePosition = 0;
    this.pending = [];
    this.pendingLevelSum = 0;
    this.pendingLevelCount = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) return true;
    const frameLength = input[0].length;
    const channels = input.length;
    const mono = new Float32Array(frameLength);
    let squareSum = 0;

    for (let i = 0; i < frameLength; i += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels; channel += 1) sample += input[channel][i] ?? 0;
      sample /= channels;
      mono[i] = sample;
      squareSum += sample * sample;
    }

    while (this.nextSourcePosition < frameLength) {
      const index = Math.min(frameLength - 1, Math.floor(this.nextSourcePosition));
      const sample = Math.max(-1, Math.min(1, mono[index]));
      this.pending.push(sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff));
      this.nextSourcePosition += this.ratio;
    }
    this.nextSourcePosition -= frameLength;
    this.pendingLevelSum += Math.sqrt(squareSum / frameLength);
    this.pendingLevelCount += 1;

    if (this.pending.length >= 1024) this.flush();
    return true;
  }

  flush() {
    if (this.pending.length === 0) return;
    const pcm = Int16Array.from(this.pending);
    const level = this.pendingLevelCount ? this.pendingLevelSum / this.pendingLevelCount : 0;
    this.pending = [];
    this.pendingLevelSum = 0;
    this.pendingLevelCount = 0;
    this.port.postMessage({ type: "pcm", pcm, level }, [pcm.buffer]);
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
