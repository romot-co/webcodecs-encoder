import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
  FinalizeWorkerMessage,
  CancelWorkerMessage,
} from "../src/types";

// Mock the global self object for the worker environment
const mockSelf = {
  postMessage: vi.fn(),
  // Mock WebCodecs APIs on self
  VideoEncoder: {
    isConfigSupported: vi.fn(() => Promise.resolve(true)),
    // Add other necessary VideoEncoder mocks if needed by the worker logic during initialization
    // e.g., if the worker instantiates VideoEncoder and calls configure directly
  },
  AudioEncoder: {
    isConfigSupported: vi.fn(() => Promise.resolve(true)),
    // Add other necessary AudioEncoder mocks
  },
  // Add other self properties if needed, e.g., addEventListener, removeEventListener
  // For simplicity, onmessage is handled by directly calling the worker's onmessage handler in tests.
} as any;

global.self = mockSelf;

// Dynamically import the worker script to ensure mocks are set up first.
// The worker script will attach its onmessage to global.self.onmessage.
async function importWorker() {
  await import("../src/worker");
}

describe("worker", () => {
  let config: EncoderConfig;

  beforeEach(async () => {
    vi.resetModules(); // Reset modules to get a fresh worker state for each test

    // Explicitly mock VideoEncoder and AudioEncoder on global.self AFTER resetModules
    mockSelf.VideoEncoder = {
      isConfigSupported: vi.fn(() =>
        Promise.resolve({ supported: true, config: {} }),
      ),
      // Mock constructor and configure as they are used in the worker
      // @ts-ignore
      new: vi.fn(() => ({
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        state: "unconfigured",
      })),
    };
    // Simulate VideoEncoder constructor being part of the mockSelf.VideoEncoder object
    // This is a common pattern for mocking classes with static methods and constructors.
    // @ts-ignore
    mockSelf.VideoEncoder = vi.fn(() => ({
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      state: "unconfigured",
    }));
    // @ts-ignore
    mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
      Promise.resolve({ supported: true, config: { codec: "avc1.42001f" } }),
    );

    // @ts-ignore
    mockSelf.AudioEncoder = vi.fn(() => ({
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      state: "unconfigured",
    }));
    // @ts-ignore
    mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
      Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
    );

    // Make worker-internal mocks also available on globalThis for the helper functions in worker.ts
    globalThis.VideoEncoder = mockSelf.VideoEncoder;
    globalThis.AudioEncoder = mockSelf.AudioEncoder;
    // Add lightweight mocks for other APIs used by worker if not present from encoder.test.ts setup
    // (though usually worker tests are more isolated)
    if (typeof globalThis.VideoFrame === "undefined") {
      globalThis.VideoFrame = class VideoFrameMock {
        constructor(source: any, init: any) {
          Object.assign(this, init);
          this.source = source;
        }
        close() {}
        // Add other properties as needed by worker logic
        readonly source: any;
      } as any;
    }
    if (typeof globalThis.AudioData === "undefined") {
      globalThis.AudioData = class AudioDataMock {
        constructor(init: any) {
          Object.assign(this, init);
        }
        close() {}
      } as any;
    }

    // Reset postMessage mock
    mockSelf.postMessage.mockClear();

    await importWorker(); // Import worker script which uses the mocked Video/AudioEncoder

    config = {
      width: 640,
      height: 480,
      frameRate: 30,
      videoBitrate: 1000000,
      audioBitrate: 128000,
      sampleRate: 48000,
      channels: 2,
      codec: { video: "avc", audio: "aac" },
      container: "mp4",
      latencyMode: "quality",
    };
  });

  afterEach(() => {
    // Clean up worker state if necessary, e.g., if it sets global timers
    // For this worker, cleanup is mainly handled by vi.resetModules() and mock clearing.
    delete (globalThis as any).VideoEncoder; // Clean up globalThis mocks
    delete (globalThis as any).AudioEncoder;
    if ((globalThis as any).VideoFrame?.name === "VideoFrameMock")
      delete (globalThis as any).VideoFrame;
    if ((globalThis as any).AudioData?.name === "AudioDataMock")
      delete (globalThis as any).AudioData;
  });

  it("initializes and finalizes", async () => {
    if (!global.self.onmessage) {
      throw new Error("Worker onmessage handler not set up by script import");
    }
    // Simulate receiving an initialize message
    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "initialized",
        actualVideoCodec: "avc1.42001f",
        actualAudioCodec: "mp4a.40.2",
      },
      undefined,
    );

    // Simulate receiving a finalize message
    mockSelf.postMessage.mockClear(); // Clear previous calls
    const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
    await global.self.onmessage({ data: finalizeMessage } as MessageEvent);
    // Worker should post a 'finalized' message with the MP4 data or null when streaming
    expect(mockSelf.postMessage).toHaveBeenCalled();
    const finalizedCall = mockSelf.postMessage.mock.calls[0];
    const msg = finalizedCall[0];
    expect(msg.type).toBe("finalized");
    expect(msg.output === null || msg.output instanceof Uint8Array).toBe(true);
    expect(finalizedCall[1]).toEqual(expect.any(Array)); // transferable list
  });

  it("handles cancel message", async () => {
    if (!global.self.onmessage) {
      throw new Error("Worker onmessage handler not set up by script import");
    }
    // Initialize first (or part of it, enough to set up for cancel)
    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "initialized",
        actualVideoCodec: "avc1.42001f",
        actualAudioCodec: "mp4a.40.2",
      },
      undefined,
    );
    mockSelf.postMessage.mockClear();

    // Simulate receiving a cancel message
    const cancelMessage: CancelWorkerMessage = { type: "cancel" };
    await global.self.onmessage({ data: cancelMessage } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      { type: "cancelled" },
      undefined,
    );
    // Optionally, check if encoders/muxer were closed if the mock allows that level of detail
  });

  // Add more tests for addVideoData, addAudioData, error handling, etc.
});
