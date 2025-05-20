import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
  FinalizeWorkerMessage,
  CancelWorkerMessage,
  AddAudioDataMessage,
  MainThreadMessage,
} from "../src/types";
import { Mp4MuxerWrapper as ActualMp4MuxerWrapper } from "../src/mp4muxer"; // Import for type clarity if needed

// Mock the Mp4MuxerWrapper
const mockMuxerInstanceForWorker = {
  addVideoChunk: vi.fn(),
  addAudioChunk: vi.fn(),
  finalize: vi.fn<() => Uint8Array | null>(() => new Uint8Array([1, 2, 3, 4])), // Returns Uint8Array or null
  // If Mp4MuxerWrapper itself uses postMessageToMainThread, it needs to be mocked here or passed.
  // For now, assuming it's self-contained or its postMessage calls are not what we are testing for this mock.
};
vi.mock("../src/mp4muxer", () => ({
  Mp4MuxerWrapper: vi.fn(() => mockMuxerInstanceForWorker),
}));

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
  let Mp4MuxerWrapperMock: ReturnType<
    typeof vi.mocked<typeof ActualMp4MuxerWrapper>
  >;

  beforeEach(async () => {
    vi.resetModules(); // Reset modules to get a fresh worker state for each test
    // Re-import the mocked Mp4MuxerWrapper to get a fresh mock for each top-level test `it` in this describe
    // This is important if tests within this describe block use mockImplementationOnce, etc.
    const mp4muxerModule = await import("../src/mp4muxer");
    Mp4MuxerWrapperMock = vi.mocked(mp4muxerModule.Mp4MuxerWrapper);
    // Ensure it defaults to returning the standard mock instance for each top-level test
    Mp4MuxerWrapperMock.mockImplementation(
      () => mockMuxerInstanceForWorker as any,
    );

    // @ts-ignore
    mockSelf.VideoEncoder = vi.fn(() => ({
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
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
      flush: vi.fn().mockResolvedValue(undefined),
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

    const expectedOutputArray = new Uint8Array([1, 2, 3, 4]);
    // Mock muxer.finalize to return the Uint8Array directly
    mockMuxerInstanceForWorker.finalize = vi.fn(() => expectedOutputArray);

    // Simulate receiving an initialize message
    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    mockSelf.postMessage.mockClear();
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
    mockSelf.postMessage.mockClear();
    const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
    await global.self.onmessage({ data: finalizeMessage } as MessageEvent);

    expect(mockSelf.postMessage).toHaveBeenCalledTimes(1);
    const finalizedCall = mockSelf.postMessage.mock.calls[0];
    const msg = finalizedCall[0];

    expect(msg.type).toBe("finalized");
    expect(msg.output).toBeInstanceOf(Uint8Array);
    expect(msg.output).toEqual(expectedOutputArray); // Compare Uint8Array content

    expect(finalizedCall[1]).toBeInstanceOf(Array);
    expect(finalizedCall[1].length).toBe(1);
    const transferredObject = finalizedCall[1][0];
    expect(transferredObject).toBeInstanceOf(ArrayBuffer);
    // Ensure the transferred ArrayBuffer has the same content as the output Uint8Array's buffer
    expect(new Uint8Array(transferredObject as ArrayBuffer)).toEqual(
      expectedOutputArray,
    );
    // The transferred ArrayBuffer should be the .buffer of the msg.output Uint8Array
    expect(transferredObject).toBe(expectedOutputArray.buffer);
  });

  it("connects audio port and handles messages", async () => {
    if (!global.self.onmessage)
      throw new Error("Worker onmessage handler not set up");
    const port: any = { postMessage: vi.fn(), onmessage: null, close: vi.fn() };
    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    const connectMsg = { type: "connectAudioPort", port } as any;
    await global.self.onmessage({ data: connectMsg } as MessageEvent);
    expect(port.onmessage).toBeTypeOf("function");
    mockSelf.AudioEncoder.mock.results[0].value.encode.mockClear();

    const addAudioMsg: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: [new Float32Array(1), new Float32Array(1)],
      timestamp: 0,
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: 1,
      numberOfChannels: 2,
    };
    if (port.onmessage)
      await port.onmessage({ data: addAudioMsg } as MessageEvent);
    expect(
      mockSelf.AudioEncoder.mock.results[0].value.encode,
    ).toHaveBeenCalled();
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

    // After cancellation, other messages should be ignored
    mockSelf.postMessage.mockClear();
    const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
    await global.self.onmessage({ data: finalizeMessage } as MessageEvent);
    expect(mockSelf.postMessage).not.toHaveBeenCalled();

    // Reinitialize should reset the cancelled state
    const initMessage2: InitializeWorkerMessage = {
      type: "initialize",
      config,
    };
    await global.self.onmessage({ data: initMessage2 } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "initialized",
        actualVideoCodec: "avc1.42001f",
        actualAudioCodec: "mp4a.40.2",
      },
      undefined,
    );
  });

  // Add more tests for addVideoData, addAudioData, error handling, etc.
  describe("worker error handling during initialization", () => {
    it("should post an error if video codec is not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: false, config: null }),
      );

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: Video codec avc config not supported.",
            type: "not-supported",
          },
        },
        undefined,
      );
    });

    it("should post an error if audio codec is not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: false, config: null }),
      );

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: Audio codec aac config not supported.",
            type: "not-supported",
          },
        },
        undefined,
      );
    });

    it("should post an error if video encoder configuration fails", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const configureError = new Error("Video configure failed");
      // @ts-ignore
      mockSelf.VideoEncoder = vi.fn(() => ({
        configure: vi.fn().mockImplementation(() => {
          throw configureError;
        }),
        close: vi.fn(),
        state: "unconfigured",
      }));
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "avc1.42001f" } }),
      );
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message:
              "Worker: Failed to initialize VideoEncoder: Video configure failed",
            type: "initialization-failed",
            stack: expect.any(String),
          },
        },
        undefined,
      );
    });

    it("should post an error if audio encoder configuration fails", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const configureError = new Error("Audio configure failed");
      // @ts-ignore
      mockSelf.AudioEncoder = vi.fn(() => ({
        configure: vi.fn().mockImplementation(() => {
          throw configureError;
        }),
        close: vi.fn(),
        state: "unconfigured",
      }));
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
      );
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message:
              "Worker: Failed to initialize AudioEncoder: Audio configure failed",
            type: "initialization-failed",
            stack: expect.any(String),
          },
        },
        undefined,
      );
    });

    it("should post an error if config is missing", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      // @ts-ignore
      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: null as any,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: Configuration is missing.",
            type: "initialization-failed",
          },
        },
        undefined,
      );
    });

    it("should post an error if webm container is specified", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const webmConfig = { ...config, container: "webm" as const };
      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: webmConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: WebM container is not supported in this version.",
            type: "not-supported",
          },
        },
        undefined,
      );
    });

    it("should fallback to avc if preferred video codec (vp9) is not supported but avc is", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const vp9Config = {
        ...config,
        codec: { ...config.codec, video: "vp9" as const },
      };

      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        if (_cfg.codec.startsWith("vp09"))
          return { supported: false, config: null };
        if (_cfg.codec.startsWith("avc1"))
          return {
            supported: true,
            config: { ..._cfg, codec: "avc1.42001f.test" },
          };
        return { supported: false, config: null };
      });
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: vp9Config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Worker: Video codec vp9 not supported or config invalid. Falling back to AVC.",
      );
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "initialized",
          actualVideoCodec: "avc1.42001f.test",
        }),
        undefined,
      );
      consoleWarnSpy.mockRestore();
    });

    it("should post error if fallback video codec (avc) is also not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const vp9Config = {
        ...config,
        codec: { ...config.codec, video: "vp9" as const },
      };

      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        return { supported: false, config: null }; // All codecs unsupported
      });
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: vp9Config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message:
              "Worker: AVC (H.264) video codec is not supported after fallback.",
            type: "not-supported",
          },
        },
        undefined,
      );
    });

    it("should fallback to aac if preferred audio codec (opus) is not supported but aac is", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const opusConfig = {
        ...config,
        codec: { ...config.codec, audio: "opus" as const },
      };

      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        if (_cfg.codec === "opus") return { supported: false, config: null };
        if (_cfg.codec === "mp4a.40.2")
          return {
            supported: true,
            config: { ..._cfg, codec: "mp4a.40.2.test" },
          };
        return { supported: false, config: null };
      });
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: opusConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Worker: Audio codec opus not supported or config invalid. Falling back to AAC.",
      );
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "initialized",
          actualAudioCodec: "mp4a.40.2.test",
        }),
        undefined,
      );
      consoleWarnSpy.mockRestore();
    });

    it("should post error if fallback audio codec (aac) is also not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const opusConfig = {
        ...config,
        codec: { ...config.codec, audio: "opus" as const },
      };
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        return { supported: false, config: null }; // All codecs unsupported
      });
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: opusConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: AAC audio codec is not supported after fallback.",
            type: "not-supported",
          },
        },
        undefined,
      );
    });

    it("should post error if VideoEncoder API is not available", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const originalVideoEncoder = globalThis.VideoEncoder;
      delete (globalThis as any).VideoEncoder;
      delete (mockSelf as any).VideoEncoder; // Also remove from mockSelf

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: VideoEncoder not available",
            type: "not-supported",
          },
        },
        undefined,
      );
      globalThis.VideoEncoder = originalVideoEncoder; // Restore
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
    });

    it("should post error if AudioEncoder API is not available", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const originalAudioEncoder = globalThis.AudioEncoder;
      delete (globalThis as any).AudioEncoder;
      delete (mockSelf as any).AudioEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: AudioEncoder not available",
            type: "not-supported",
          },
        },
        undefined,
      );
      globalThis.AudioEncoder = originalAudioEncoder; // Restore
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
    });

    it("should post error if VideoEncoder constructor throws", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const originalVideoEncoderCtor = mockSelf.VideoEncoder;
      const constructorError = new Error("Video Constructor failed");

      const mockVideoEncoderConstructor = vi.fn();
      // @ts-ignore
      mockVideoEncoderConstructor.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "avc1.42001f.test" },
        }),
      );
      mockVideoEncoderConstructor.mockImplementation(() => {
        throw constructorError;
      });

      mockSelf.VideoEncoder = mockVideoEncoderConstructor;
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      const originalAudioEncoderCtor = mockSelf.AudioEncoder;
      // @ts-ignore
      const MockAudioEncoderInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        state: "unconfigured",
      };
      // @ts-ignore
      mockSelf.AudioEncoder = vi.fn(() => MockAudioEncoderInstance);
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
      );
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `Worker: Failed to initialize VideoEncoder: ${constructorError.message}`,
            type: "initialization-failed",
            stack: expect.any(String),
          }),
        }),
        undefined,
      );

      mockSelf.VideoEncoder = originalVideoEncoderCtor;
      globalThis.VideoEncoder = mockSelf.VideoEncoder;
      mockSelf.AudioEncoder = originalAudioEncoderCtor;
      globalThis.AudioEncoder = mockSelf.AudioEncoder;
    });

    it("should post error if AudioEncoder constructor throws", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      // === リセットフェーズ ===
      const originalVideoEncoderCtorForThisTest = mockSelf.VideoEncoder;
      const originalAudioEncoderCtorForThisTest = mockSelf.AudioEncoder;

      const MockVideoInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        state: "unconfigured",
      };
      const MockAudioInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        state: "unconfigured",
      };

      // @ts-ignore
      mockSelf.VideoEncoder = vi.fn(() => MockVideoInstance);
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "avc1.42001f.default" },
        }),
      );
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      // @ts-ignore
      mockSelf.AudioEncoder = vi.fn(() => MockAudioInstance);
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "mp4a.40.2.default" },
        }),
      );
      globalThis.AudioEncoder = mockSelf.AudioEncoder;
      // === リセットフェーズここまで ===

      // === VideoEncoder をこのテスト用に正常動作させる設定 ===
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "avc1.42001f.test" },
        }),
      );
      // @ts-ignore
      mockSelf.VideoEncoder.mockImplementation(() => MockVideoInstance);
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      // === AudioEncoder がエラーを投げるように設定 ===
      const constructorError = new Error("Audio Constructor failed for test");
      const mockAudioEncoderConstructorThatThrows = vi.fn();
      // @ts-ignore
      mockAudioEncoderConstructorThatThrows.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "mp4a.40.2.test" },
        }),
      );
      mockAudioEncoderConstructorThatThrows.mockImplementation(() => {
        throw constructorError;
      });

      mockSelf.AudioEncoder = mockAudioEncoderConstructorThatThrows;
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `Worker: Failed to initialize AudioEncoder: ${constructorError.message}`,
            type: "initialization-failed",
            stack: expect.any(String),
          }),
        }),
        undefined,
      );

      // リストア
      mockSelf.VideoEncoder = originalVideoEncoderCtorForThisTest;
      globalThis.VideoEncoder = mockSelf.VideoEncoder;
      mockSelf.AudioEncoder = originalAudioEncoderCtorForThisTest;
      globalThis.AudioEncoder = mockSelf.AudioEncoder;
    });
  });

  describe("handleAddVideoFrame", () => {
    let initMessage: InitializeWorkerMessage;
    let videoEncoderErrorCallback: ((error: any) => void) | null = null; // error コールバックを保持する変数

    beforeEach(async () => {
      videoEncoderErrorCallback = null; // 各テスト前にリセット
      // VideoEncoder のモックを修正して error コールバックをキャプチャ
      // @ts-ignore
      mockSelf.VideoEncoder = vi.fn((options: { error: (e: any) => void }) => {
        videoEncoderErrorCallback = options.error; // error コールバックを保存
        return {
          configure: vi.fn(),
          encode: vi.fn(), // encode 自体はここでは何もしないか、成功をシミュレート
          flush: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
          state: "configured", // 初期化済み状態を模倣
        };
      });
      // @ts-ignore (isConfigSupported は既存のままで良いはず)
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "avc1.42001f" } }),
      );
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      initMessage = { type: "initialize", config };
      if (global.self.onmessage) {
        await global.self.onmessage({ data: initMessage } as MessageEvent);
        mockSelf.postMessage.mockClear();
      } else {
        throw new Error(
          "Worker onmessage handler not set up for handleAddVideoFrame tests",
        );
      }
    });

    it("should return early if cancelled", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      // キャンセル状態にする
      const cancelMessage: CancelWorkerMessage = { type: "cancel" };
      await global.self.onmessage({ data: cancelMessage } as MessageEvent);
      mockSelf.postMessage.mockClear();

      const videoFrame = new globalThis.VideoFrame(
        new Uint8Array(config.width * config.height * 4),
        {
          timestamp: 0,
          duration: 33333,
          codedWidth: config.width,
          codedHeight: config.height,
          format: "RGBA",
        },
      );
      const addFrameMessage = {
        type: "addVideoFrame",
        frame: videoFrame,
        timestamp: 0,
      };
      await global.self.onmessage({ data: addFrameMessage } as MessageEvent);

      expect(mockSelf.postMessage).not.toHaveBeenCalled();
      videoFrame.close(); // テスト後は閉じる
    });

    it("should post an error if videoEncoder.encode triggers error callback", async () => {
      if (!global.self.onmessage || !videoEncoderErrorCallback)
        throw new Error("Worker or VideoEncoder error callback not set up");

      const encodeError = new Error("Video encode failed by callback");

      const videoFrame = new globalThis.VideoFrame(
        new Uint8Array(config.width * config.height * 4),
        {
          timestamp: 0,
          duration: 33333,
          codedWidth: config.width,
          codedHeight: config.height,
          format: "RGBA",
        },
      );
      const addFrameMessage = {
        type: "addVideoFrame",
        frame: videoFrame,
        timestamp: 0,
      };

      // addVideoFrame を呼び出す前に、encode がエラーを発生させる準備をする
      // (実際には addVideoFrame の中で encode が呼ばれ、その結果 error コールバックが呼ばれる)
      // ここでは、addVideoFrame を呼び出した後に、error コールバックを直接呼び出してシミュレートする
      global.self.onmessage({ data: addFrameMessage } as MessageEvent); // まずフレームを追加

      // error コールバックが呼ばれたと仮定して、それを実行
      if (videoEncoderErrorCallback) {
        videoEncoderErrorCallback(encodeError);
      }

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "VideoEncoder error: Video encode failed by callback", // worker.ts のエラーメッセージ形式に合わせる
            type: "video-encoding-error",
            stack: expect.any(String),
          },
        },
        undefined,
      );
      // videoFrame.close(); // エラーなのでフレームがcloseされるかは不定。workerの実装による
    });

    it("should post progress if totalFramesToProcess is set and latencyMode is quality", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      // totalFramesToProcess を設定して再初期化
      const newConfig = { ...config, latencyMode: "quality" as const };
      const newInitMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: newConfig,
        totalFrames: 10,
      };
      await global.self.onmessage({ data: newInitMessage } as MessageEvent);
      mockSelf.postMessage.mockClear();

      const videoFrame = new globalThis.VideoFrame(
        new Uint8Array(config.width * config.height * 4),
        {
          timestamp: 0,
          duration: 33333,
          codedWidth: config.width,
          codedHeight: config.height,
          format: "RGBA",
        },
      );
      const addFrameMessage = {
        type: "addVideoFrame",
        frame: videoFrame,
        timestamp: 0,
      };
      await global.self.onmessage({ data: addFrameMessage } as MessageEvent); // 1フレーム送信

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "progress",
          processedFrames: 1,
          totalFrames: 10,
        },
        undefined,
      );
      videoFrame.close();
    });
  });

  describe("handleAddAudioData", () => {
    let initMessage: InitializeWorkerMessage;
    let audioEncoderErrorCallback: ((error: any) => void) | null = null;
    let mockAudioDataInstance: any;

    beforeEach(async () => {
      audioEncoderErrorCallback = null;
      mockAudioDataInstance = {
        close: vi.fn(),
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: 1024,
        numberOfChannels: 1,
        timestamp: 0,
        duration: 21333,
      };

      // @ts-ignore
      mockSelf.AudioEncoder = vi.fn((options: { error: (e: any) => void }) => {
        audioEncoderErrorCallback = options.error;
        return {
          configure: vi.fn(),
          encode: vi.fn(),
          flush: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
          state: "configured",
        };
      });
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
      );
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      // @ts-ignore
      globalThis.AudioData = vi.fn(() => mockAudioDataInstance);

      // 基本的な初期化
      const audioConfig = { ...config, audioBitrate: 128000 }; // audioBitrate を有効に
      initMessage = { type: "initialize", config: audioConfig };
      if (global.self.onmessage) {
        await global.self.onmessage({ data: initMessage } as MessageEvent);
        mockSelf.postMessage.mockClear();
      } else {
        throw new Error(
          "Worker onmessage handler not set up for handleAddAudioData tests",
        );
      }
    });

    it("should return early if cancelled", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const cancelMessage: CancelWorkerMessage = { type: "cancel" };
      await global.self.onmessage({ data: cancelMessage } as MessageEvent);
      mockSelf.postMessage.mockClear();

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: [new Float32Array(10)],
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: 10,
        numberOfChannels: 1,
        timestamp: 0,
      };
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
      expect(mockSelf.postMessage).not.toHaveBeenCalled();
    });

    it("should return early if audioBitrate is 0", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      config.audioBitrate = 0; // Disable audio

      // Initialize with audio disabled
      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      mockSelf.postMessage.mockClear(); // Clear init message

      const dummyAudioSamples = new Float32Array(512);
      const audioDataArray: Float32Array[] = [];
      for (let i = 0; i < config.channels; i++) {
        audioDataArray.push(dummyAudioSamples.slice()); // Use slice to create copies
      }

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: audioDataArray,
        timestamp: 0,
        format: "f32-planar", // Add format
        sampleRate: config.sampleRate, // Add sampleRate
        numberOfFrames: 512, // Add numberOfFrames
        numberOfChannels: config.channels, // Add numberOfChannels
      };
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
      expect(mockSelf.postMessage).not.toHaveBeenCalled();
    });

    it("should post error if AudioData API is not available", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const AudioDataOriginal = (globalThis as any).AudioData;
      delete (globalThis as any).AudioData; // Simulate AudioData API not available

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent); // Initialize
      mockSelf.postMessage.mockClear(); // Clear init message

      const dummyAudioSamples = new Float32Array(512);
      const audioDataArray: Float32Array[] = [];
      for (let i = 0; i < config.channels; i++) {
        audioDataArray.push(dummyAudioSamples.slice());
      }

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: audioDataArray, // Use the array of Float32Array
        timestamp: 0,
        format: "f32-planar",
        sampleRate: config.sampleRate,
        numberOfFrames: 512,
        numberOfChannels: config.channels,
      };
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: AudioData not available", // Removed period
            type: "not-supported",
          },
        },
        undefined,
      );

      (globalThis as any).AudioData = AudioDataOriginal; // Restore API
    });

    it("should post error if AudioData constructor throws", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const AudioDataOriginal = (globalThis as any).AudioData;
      const constructionErrorMessage = "AudioData construction failed";
      (globalThis as any).AudioData = vi.fn().mockImplementation(() => {
        throw new Error(constructionErrorMessage);
      });

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent); // Initialize
      mockSelf.postMessage.mockClear(); // Clear init message

      const dummyAudioSamples = new Float32Array(512);
      const audioDataArray: Float32Array[] = [];
      for (let i = 0; i < config.channels; i++) {
        audioDataArray.push(dummyAudioSamples.slice());
      }

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: audioDataArray, // Use the array of Float32Array
        timestamp: 0,
        format: "f32-planar",
        sampleRate: config.sampleRate,
        numberOfFrames: 512,
        numberOfChannels: config.channels,
      };
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `Error encoding audio data: ${constructionErrorMessage}`,
            type: "audio-encoding-error",
            // stack: expect.any(String) // Stack trace comparison removed
          }),
        }),
        undefined,
      );

      (globalThis as any).AudioData = AudioDataOriginal; // Restore
    });

    it("should post error if audioEncoder.encode triggers error callback", async () => {
      if (!global.self.onmessage || !audioEncoderErrorCallback)
        throw new Error("Worker or AudioEncoder error cb not set up");
      const encodeError = new Error("Audio encode failed by callback");

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: [new Float32Array(10)],
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: 10,
        numberOfChannels: 1,
        timestamp: 0,
      };
      global.self.onmessage({ data: addAudioMessage } as MessageEvent);

      if (audioEncoderErrorCallback) {
        audioEncoderErrorCallback(encodeError);
      }

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "AudioEncoder error: Audio encode failed by callback",
            type: "audio-encoding-error",
            stack: expect.any(String),
          },
        },
        undefined,
      );
    });

    it("should handle empty planarArrays in interleaveFloat32Arrays within handleAddAudioData", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: [], // Empty planarArrays
        timestamp: 0,
        format: "f32-planar",
        sampleRate: config.sampleRate,
        numberOfFrames: 0,
        numberOfChannels: 0, // Or config.channels, but frames is 0
      };
      // This should not throw an error and ideally not call postMessage with an error for this specific case,
      // as the guard `data.audioData.length === 0` should catch it.
      // If the guard is specific to `currentConfig.channels` mismatch, then an empty array might pass that.
      // The primary goal here is to cover the interleaveFloat32Arrays([]) case.
      // The worker's handleAddAudioData might return early due to `data.audioData.length === 0`.
      // We expect no error to be posted.
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
      expect(mockSelf.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
    });

    it("should post error if audio data channel count does not match configured channels", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: [new Float32Array(10)], // Only 1 channel of data
        timestamp: 0,
        format: "f32-planar",
        sampleRate: config.sampleRate,
        numberOfFrames: 10,
        numberOfChannels: 1, // Message claims 1 channel
      };
      // config.channels is 2 by default in beforeEach
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: `Audio data channel count (1) does not match configured channels (${config.channels}).`,
            type: "configuration-error",
          },
        },
        undefined,
      );
    });
  });

  describe("handleFinalize", () => {
    let mockVideoEncoderInstance: any;
    let mockAudioEncoderInstance: any;
    const defaultMuxerOutput = new Uint8Array([1, 2, 3, 4]);

    beforeEach(async () => {
      mockVideoEncoderInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        state: "configured",
      };
      mockAudioEncoderInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        state: "configured",
      };
      // @ts-ignore
      mockSelf.VideoEncoder = vi.fn(() => mockVideoEncoderInstance);
      // @ts-ignore
      mockSelf.AudioEncoder = vi.fn(() => mockAudioEncoderInstance);

      // isConfigSupported を VideoEncoder と AudioEncoder のコンストラクタモックに再度アタッチ
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "avc1.42001f" } }),
      );
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
      );

      // globalThis も更新
      globalThis.VideoEncoder = mockSelf.VideoEncoder;
      globalThis.AudioEncoder = mockSelf.AudioEncoder;

      const mp4muxerModule = await import("../src/mp4muxer");
      const currentMp4MuxerWrapperMock = vi.mocked(
        mp4muxerModule.Mp4MuxerWrapper,
      );
      currentMp4MuxerWrapperMock.mockImplementation(
        () => mockMuxerInstanceForWorker as any,
      );

      mockMuxerInstanceForWorker.addVideoChunk.mockClear();
      mockMuxerInstanceForWorker.addAudioChunk.mockClear();
      mockMuxerInstanceForWorker.finalize = vi.fn<() => Uint8Array | null>(
        () => defaultMuxerOutput,
      );

      // Default config for finalize tests, can be overridden in specific tests
      const currentTestConfig = { ...config, latencyMode: "quality" as const };
      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: currentTestConfig,
      };

      if (global.self.onmessage) {
        mockSelf.postMessage.mockClear();
        await global.self.onmessage({ data: initMessage } as MessageEvent);

        const initErrorPost = mockSelf.postMessage.mock.calls.find(
          (callArgs: [MainThreadMessage, Transferable[] | undefined]) =>
            callArgs[0].type === "error",
        );
        expect(
          initErrorPost,
          "Worker initialization in handleFinalize beforeEach should not post an error",
        ).toBeUndefined();

        expect(mockSelf.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "initialized" }),
          undefined,
        );
        mockSelf.postMessage.mockClear();
      } else {
        throw new Error(
          "Worker onmessage handler not set up for handleFinalize tests",
        );
      }
    });

    it("should call flush on encoders and finalize muxer, then post finalized message", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
      await global.self.onmessage({ data: finalizeMessage } as MessageEvent);

      expect(mockVideoEncoderInstance.flush).toHaveBeenCalled();
      expect(mockAudioEncoderInstance.flush).toHaveBeenCalled();
      expect(mockMuxerInstanceForWorker.finalize).toHaveBeenCalled();
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "finalized",
          output: defaultMuxerOutput,
        },
        [defaultMuxerOutput.buffer],
      );
    });

    it("should post error if muxer construction fails during initialization", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const muxerConstructionError = new Error("Muxer init failed for test");
      const specificTestMp4MuxerWrapperMock = vi.mocked(
        (await import("../src/mp4muxer")).Mp4MuxerWrapper,
      );
      specificTestMp4MuxerWrapperMock.mockImplementationOnce(() => {
        throw muxerConstructionError;
      });

      mockSelf.postMessage.mockClear();
      const faultyConfig = { ...config, width: 1 }; // Create a new config to ensure it's different
      const faultyInitMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: faultyConfig,
      };
      await global.self.onmessage({ data: faultyInitMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `Worker: Failed to initialize MP4 Muxer: ${muxerConstructionError.message}`,
            type: "initialization-failed",
          }),
        }),
        undefined,
      );
      mockSelf.postMessage.mockClear();

      const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
      await global.self.onmessage({ data: finalizeMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Muxer not initialized during finalize.",
            type: "muxing-failed",
          },
        },
        undefined,
      );
      specificTestMp4MuxerWrapperMock.mockImplementation(
        () => mockMuxerInstanceForWorker as any,
      );
    });

    it("should post error if muxer.finalize returns null in non-realtime mode", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      // Ensure latencyMode is 'quality' (non-realtime) - should be set by beforeEach default

      mockMuxerInstanceForWorker.finalize.mockReturnValueOnce(null);

      const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
      await global.self.onmessage({ data: finalizeMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Muxer finalized without output in non-realtime mode.",
            type: "muxing-failed",
          },
        },
        undefined,
      );
    });

    it("should post finalized with null output if muxer.finalize returns null in realtime mode", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const realtimeConfig = { ...config, latencyMode: "realtime" as const };
      const initRealtimeMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: realtimeConfig,
      };

      // Reset Mp4MuxerWrapper mock to ensure the new config re-initializes the muxer correctly
      // This is important because the beforeEach's init might have set up a muxer.
      // For a new config, a new muxer instance should be created.
      const mp4muxerModule = await import("../src/mp4muxer");
      const currentMp4MuxerWrapperMock = vi.mocked(
        mp4muxerModule.Mp4MuxerWrapper,
      );
      currentMp4MuxerWrapperMock.mockImplementation(
        () => mockMuxerInstanceForWorker as any,
      );
      // Ensure the mockMuxerInstanceForWorker's finalize is also fresh for this test's logic
      mockMuxerInstanceForWorker.finalize = vi.fn<() => Uint8Array | null>(
        () => null,
      );

      mockSelf.postMessage.mockClear();
      await global.self.onmessage({
        data: initRealtimeMessage,
      } as MessageEvent);

      const initErrorPost = mockSelf.postMessage.mock.calls.find(
        (call: [MainThreadMessage, Transferable[] | undefined]) =>
          call[0].type === "error",
      );
      expect(
        initErrorPost,
        "Error during realtime re-initialization",
      ).toBeUndefined();
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "initialized" }),
        undefined,
      );
      mockSelf.postMessage.mockClear();

      const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
      await global.self.onmessage({ data: finalizeMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        { type: "finalized", output: null },
        undefined,
      );
    });

    it("should handle general error during finalization (e.g. videoEncoder.flush throws)", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      const flushError = new Error("Flush failed for test");
      mockVideoEncoderInstance.flush.mockRejectedValueOnce(flushError);

      const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
      await global.self.onmessage({ data: finalizeMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: `Error during finalization: ${flushError.message}`,
            type: "muxing-failed",
            stack: expect.any(String),
          },
        },
        undefined,
      );
    });
  });

  describe("worker self.onmessage error handling and cancellation edge cases", () => {
    it("should ignore addVideoFrame if worker is cancelled", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      await global.self.onmessage({
        data: { type: "initialize", config },
      } as MessageEvent);
      await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent); // Cancel
      mockSelf.postMessage.mockClear();

      const videoFrame = new globalThis.VideoFrame(new Uint8Array(10), {
        timestamp: 0,
        codedWidth: 10,
        codedHeight: 10,
        format: "RGBA",
      });
      const addFrameMessage = {
        type: "addVideoFrame",
        frame: videoFrame,
        timestamp: 0,
      };
      await global.self.onmessage({ data: addFrameMessage } as MessageEvent);
      expect(mockSelf.postMessage).not.toHaveBeenCalled();
      videoFrame.close();
    });

    it("should ignore addAudioData if worker is cancelled (already tested, but good for this describe block too)", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      await global.self.onmessage({
        data: { type: "initialize", config },
      } as MessageEvent);
      await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent); // Cancel
      mockSelf.postMessage.mockClear();

      const addAudioMessage: AddAudioDataMessage = {
        type: "addAudioData",
        audioData: [new Float32Array(10)],
        timestamp: 0,
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: 10,
        numberOfChannels: 1,
      };
      await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
      expect(mockSelf.postMessage).not.toHaveBeenCalled();
    });

    it("should still process initialize even if isCancelled was somehow true before it", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      // @ts-ignore Manually set isCancelled to true internally in the worker module via a test hook if possible,
      // or rely on the fact that initialize should reset it.
      // For this test, we'll assume initialize resets it.
      // First, cancel to set isCancelled=true
      await global.self.onmessage({
        data: { type: "initialize", config },
      } as MessageEvent); // Initial init
      mockSelf.postMessage.mockClear(); // Clear "initialized" message

      await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent); // Sets isCancelled = true
      mockSelf.postMessage.mockClear(); // Clear cancel message

      // Then, send initialize again
      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "initialized" }),
        undefined,
      );
    });

    it("should still process cancel even if isCancelled was already true", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      await global.self.onmessage({
        data: { type: "initialize", config },
      } as MessageEvent);
      mockSelf.postMessage.mockClear(); // Clear "initialized" message

      await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent); // First cancel
      // The first cancel should have posted a "cancelled" message and called cleanup.
      // mockSelf.postMessage should have been called with { type: "cancelled" }.
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        { type: "cancelled" },
        undefined,
      );
      mockSelf.postMessage.mockClear(); // Clear first cancel's 'cancelled' message

      // Call cancel again
      await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent);
      // Worker's handleCancel has an early return: if (isCancelled) return;
      // So, postMessage should not be called again with "cancelled".
      expect(mockSelf.postMessage).not.toHaveBeenCalled();
    });

    it("should handle errors within self.onmessage itself (e.g., if a handler throws unexpectedly)", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");

      const onmessageInternalError = new Error(
        "Simulated internal error during init",
      );

      // Ensure VideoEncoder.isConfigSupported is mocked to reject for this test
      // @ts-ignore
      const originalVideoEncoderIsSupported =
        mockSelf.VideoEncoder.isConfigSupported;
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.reject(onmessageInternalError),
      );
      // Update globalThis as well if worker might use it
      globalThis.VideoEncoder = mockSelf.VideoEncoder;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `Unhandled error in worker onmessage: ${onmessageInternalError.message}`,
            type: "internal-error",
            stack: expect.any(String),
          }),
        }),
        undefined,
      );

      // Restore the original isConfigSupported mock for other tests
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = originalVideoEncoderIsSupported;
      globalThis.VideoEncoder = mockSelf.VideoEncoder; // Ensure globalThis is also restored
    });
  });
});
