import { describe, it, expect, vi, beforeEach, beforeAll, Mock } from "vitest";

// Mock AudioWorkletProcessor and registerProcessor as they are part of AudioWorkletGlobalScope
const mockPort = {
  postMessage: vi.fn(),
  onmessage: null as ((event: MessageEvent) => void) | null,
  onmessageerror: null as ((event: MessageEvent) => void) | null,
  start: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};

const mockAudioWorkletProcessor = class AudioWorkletProcessorMock {
  port: MessagePort;
  constructor() {
    // Each instance gets a fresh mockPort-like structure for its port
    this.port = {
      postMessage: vi.fn(),
      onmessage: null,
      onmessageerror: null,
      start: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MessagePort;
  }
  process(
    _inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    return true;
  }
};

(globalThis as any).AudioWorkletProcessor = mockAudioWorkletProcessor;
const registerProcessorMock = vi.fn() as Mock<(...args: any[]) => void>;
(globalThis as any).registerProcessor = registerProcessorMock;
(globalThis as any).sampleRate = 48000;

let EncoderAudioWorkletProcessor: typeof mockAudioWorkletProcessor | undefined;

describe("EncoderAudioWorkletProcessor", () => {
  beforeAll(async () => {
    try {
      // @ts-ignore - Suppressing import path extension error for now
      await import("../src/audio-worklet-processor.ts");
    } catch (e) {
      console.error("beforeAll: Failed to import module during test setup:", e); // Keep this one for critical errors
      throw e;
    }

    await Promise.resolve();

    if (registerProcessorMock.mock.calls.length > 0) {
      EncoderAudioWorkletProcessor = registerProcessorMock.mock.calls[0][1];
    } else {
      throw new Error(
        "Processor not registered in beforeAll. Check module import or mocking.",
      );
    }
  });

  beforeEach(() => {
    // Reset individual mock states if necessary, but EncoderAudioWorkletProcessor is now set.
    // For example, if mockPort was shared and modified, reset it here.
    // However, mockAudioWorkletProcessor constructor now creates a fresh port for each instance.
    mockPort.postMessage.mockClear(); // If this global mockPort is used by any other direct test
    mockPort.onmessage = null;
    mockPort.onmessageerror = null;
    // registerProcessorMock.mockClear(); // Clearing this might not be what we want if we test its call count across tests
    // For the first test, it should have 1 call. For others, it remains 1.
  });

  it('should be registered with the name "encoder-audio-worklet" once', () => {
    expect(EncoderAudioWorkletProcessor).toBeDefined();
    expect(registerProcessorMock).toHaveBeenCalledTimes(1); // Check it was called once in total
    expect(registerProcessorMock).toHaveBeenCalledWith(
      "encoder-audio-worklet",
      EncoderAudioWorkletProcessor,
    );
  });

  describe("constructor", () => {
    it("should set up port.onmessage", () => {
      if (!EncoderAudioWorkletProcessor)
        throw new Error("Processor not defined");
      const processor = new EncoderAudioWorkletProcessor();
      expect(processor.port.onmessage).toBeInstanceOf(Function);
    });

    it("should set workerPort when port event.data.port is received", () => {
      if (!EncoderAudioWorkletProcessor)
        throw new Error("Processor not defined");
      const processor = new EncoderAudioWorkletProcessor() as any;
      const mockWorkerPort = { postMessage: vi.fn() } as any;
      processor.port.onmessage({ data: { port: mockWorkerPort } });
      expect(processor.workerPort).toBe(mockWorkerPort);
    });

    it("should update sampleRateVal when port event.data.sampleRate is received", () => {
      if (!EncoderAudioWorkletProcessor)
        throw new Error("Processor not defined");
      const processor = new EncoderAudioWorkletProcessor() as any;
      const newSampleRate = 16000;
      processor.port.onmessage({ data: { sampleRate: newSampleRate } });
      expect(processor.sampleRateVal).toBe(newSampleRate);
    });
  });

  describe("process", () => {
    let processor: any;
    let mockWorkerSidePort: {
      postMessage: Mock<(...args: any[]) => any>;
    };

    beforeEach(() => {
      if (!EncoderAudioWorkletProcessor)
        throw new Error("Processor not defined");
      processor = new EncoderAudioWorkletProcessor() as any;
      mockWorkerSidePort = {
        postMessage: vi.fn() as Mock<(...args: any[]) => any>,
      };
      // Each processor instance gets a new port from mockAudioWorkletProcessor constructor
      // We need to simulate the onmessage handler being called on THAT specific port.
      if (processor.port && typeof processor.port.onmessage === "function") {
        processor.port.onmessage({ data: { port: mockWorkerSidePort } });
      } else {
        throw new Error(
          "Processor port or onmessage handler not set up correctly for process tests.",
        );
      }
    });

    it("should return true and not postMessage if workerPort is null", () => {
      processor.workerPort = null;
      const inputs: Float32Array[][] = [[new Float32Array(128)]];
      const result = processor.process(inputs, [], {});
      expect(result).toBe(true);
      expect(mockWorkerSidePort.postMessage).not.toHaveBeenCalled();
    });

    it("should return true and not postMessage if inputs are empty or invalid", () => {
      let inputs: Float32Array[][] = [[]];
      expect(processor.process(inputs, [], {})).toBe(true);
      expect(mockWorkerSidePort.postMessage).not.toHaveBeenCalled();

      inputs = [[new Float32Array(0)]];
      expect(processor.process(inputs, [], {})).toBe(true);
      expect(mockWorkerSidePort.postMessage).not.toHaveBeenCalled();

      inputs = [undefined as any];
      expect(processor.process(inputs, [], {})).toBe(true);
      expect(mockWorkerSidePort.postMessage).not.toHaveBeenCalled();
    });

    it("should post audio data to workerPort if inputs are valid", () => {
      const inputData = [
        new Float32Array([0.1, 0.2, 0.3]),
        new Float32Array([0.4, 0.5, 0.6]),
      ];
      const inputs: Float32Array[][] = [inputData];
      processor.sampleRateVal = 44100;

      const result = processor.process(inputs, [], {});
      expect(result).toBe(true);
      expect(mockWorkerSidePort.postMessage).toHaveBeenCalledTimes(1);

      const expectedBuffers = inputData.map((arr) => new Float32Array(arr));

      expect(mockWorkerSidePort.postMessage).toHaveBeenCalledWith(
        {
          type: "addAudioData",
          audioData: expect.any(Array),
          numberOfFrames: 3,
          numberOfChannels: 2,
          sampleRate: 44100,
          timestamp: 0,
          format: "f32-planar",
        },
        expectedBuffers.map((b) => b.buffer),
      );

      const actualAudioData =
        mockWorkerSidePort.postMessage.mock.calls[0][0].audioData;
      expect(actualAudioData.length).toBe(2);
      expect(actualAudioData[0]).toEqual(expectedBuffers[0]);
      expect(actualAudioData[1]).toEqual(expectedBuffers[1]);
      expect(actualAudioData[0]).not.toBe(inputData[0]);
    });

    it("should increment timestamp based on processed frames", () => {
      const input1 = [new Float32Array([0.1, 0.2])];
      const input2 = [new Float32Array([0.3, 0.4, 0.5])];
      processor.sampleRateVal = 48000;

      processor.process([input1], [], {});
      const timestampFirst =
        mockWorkerSidePort.postMessage.mock.calls[0][0].timestamp;
      expect(timestampFirst).toBe(0);
      mockWorkerSidePort.postMessage.mockClear();

      processor.process([input2], [], {});
      const expectedTimestampSecond = (input1[0].length / 48000) * 1_000_000;
      const timestampSecond =
        mockWorkerSidePort.postMessage.mock.calls[0][0].timestamp;
      expect(timestampSecond).toBeCloseTo(expectedTimestampSecond);
    });
  });
});
