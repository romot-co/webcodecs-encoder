declare const sampleRate: number;

declare function registerProcessor(
  name: string,
  processorCtor: typeof AudioWorkletProcessor,
): void;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

class EncoderAudioWorkletProcessor extends AudioWorkletProcessor {
  private workerPort: MessagePort | null = null;
  private sampleRateVal = sampleRate;
  private processedFrames = 0;
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data?.port) {
        this.workerPort = event.data.port as MessagePort;
      }
      if (event.data?.sampleRate) {
        this.sampleRateVal = event.data.sampleRate;
      }
    };
  }
  process(inputs: Float32Array[][]) {
    if (!this.workerPort) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // At least one channel must exist, and it must have some frames.
    const firstChannel = input[0];
    if (!firstChannel || firstChannel.length === 0) return true;

    const numChannels = input.length;
    const numFrames = firstChannel.length; // This will be > 0 due to the check above
    const buffers: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      const copy = new Float32Array(input[c]);
      buffers.push(copy);
    }
    const timestamp = (this.processedFrames / this.sampleRateVal) * 1_000_000;
    this.processedFrames += numFrames;
    this.workerPort.postMessage(
      {
        type: "addAudioData",
        audioData: buffers,
        numberOfFrames: numFrames,
        numberOfChannels: numChannels,
        sampleRate: this.sampleRateVal,
        timestamp,
        format: "f32-planar",
      },
      buffers.map((b) => b.buffer),
    );
    return true;
  }
}

registerProcessor("encoder-audio-worklet", EncoderAudioWorkletProcessor);

export {};
