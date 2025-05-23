import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
  FinalizeWorkerMessage,
  CancelWorkerMessage,
  AddAudioDataMessage,
} from "../src/types";
import {
  setupGlobals,
  cleanupGlobals,
  resetMocks,
  importWorker,
  mockSelf,
  mockMuxerInstanceForWorker,
} from "./helpers/worker-test-utils";
import { Mp4MuxerWrapper as ActualMp4MuxerWrapper } from "../src/mp4muxer";

describe("worker", () => {
  let config: EncoderConfig;
  let Mp4MuxerWrapperMock: ReturnType<
    typeof vi.mocked<typeof ActualMp4MuxerWrapper>
  >;

  beforeEach(async () => {
    vi.resetModules();
    setupGlobals();
    resetMocks();
    const mp4muxerModule = await import("../src/mp4muxer");
    Mp4MuxerWrapperMock = vi.mocked(mp4muxerModule.Mp4MuxerWrapper);
    Mp4MuxerWrapperMock.mockImplementation(() => mockMuxerInstanceForWorker as any);
    await importWorker();
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
    cleanupGlobals();
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
    expect(mockSelf.postMessage).toHaveBeenCalledWith({
      type: "initialized",
      actualVideoCodec: "avc1.42001f",
      actualAudioCodec: "mp4a.40.2",
    });

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
    expect(mockSelf.postMessage).toHaveBeenCalledWith({
      type: "initialized",
      actualVideoCodec: "avc1.42001f",
      actualAudioCodec: "mp4a.40.2",
    });
    mockSelf.postMessage.mockClear();

    // Simulate receiving a cancel message
    const cancelMessage: CancelWorkerMessage = { type: "cancel" };
    await global.self.onmessage({ data: cancelMessage } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith({ type: "cancelled" });

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
    );
  });

  it("uses codec string override when provided", async () => {
    if (!global.self.onmessage)
      throw new Error("Worker onmessage handler not set up");

    const cfg = {
      ...config,
      codecString: { video: "avc1.deadbeef" },
    };

    const spy = vi.fn(async (c: any) => {
      return { supported: true, config: { ...c } };
    });
    mockSelf.VideoEncoder.isConfigSupported = spy;

    const initMessage: InitializeWorkerMessage = { type: "initialize", config: cfg };
    await global.self.onmessage({ data: initMessage } as MessageEvent);

    // コーデックが"avc1.deadbeef"で呼び出されることを確認
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0].codec).toBe("avc1.deadbeef");
    
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ 
        type: "initialized", 
        actualVideoCodec: "avc1.deadbeef" 
      }),
    );
  });

  it("computes default avc profile/level when codec string is not supplied", async () => {
    if (!global.self.onmessage)
      throw new Error("Worker onmessage handler not set up");

    const spy = vi.fn(async (c: any) => ({ supported: true, config: c }));
    mockSelf.VideoEncoder.isConfigSupported = spy;

    const initMessage: InitializeWorkerMessage = {
      type: "initialize",
      config: {
        width: 1920, // defaultAvcCodecString で "high" プロファイルが選ばれる解像度
        height: 1080,
        frameRate: 30,
        videoBitrate: 3_000_000,
        audioBitrate: 128_000,
        sampleRate: 48000,
        channels: 2,
        container: "mp4",
        codec: { video: "avc" },
      } as EncoderConfig,
    };

    await global.self.onmessage({ data: initMessage } as MessageEvent);

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toMatchObject({
      width: 1920,
      height: 1080,
      framerate: 30
    });
    
    // メッセージが送信されることを確認
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "initialized"
      }),
    );
  });

  it("falls back through AVC profiles when unsupported", async () => {
    if (!global.self.onmessage)
      throw new Error("Worker onmessage handler not set up");

    const spy = vi.fn(async (_c: any) => {
      // このモックは常に非対応とする
      return { supported: false, config: null };
    });
    mockSelf.VideoEncoder.isConfigSupported = spy;

    const initMessage: InitializeWorkerMessage = {
      type: "initialize",
      config: {
        width: 1920,
        height: 1080,
        frameRate: 30,
        videoBitrate: 3_000_000,
        audioBitrate: 128_000,
        sampleRate: 48000,
        channels: 2,
        container: "mp4",
        codec: { video: "avc" },
      } as EncoderConfig,
    };

    await global.self.onmessage({ data: initMessage } as MessageEvent);

    expect(spy).toHaveBeenCalled();
    
    // 初期化が失敗し、エラーが postMessage されることを確認
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "error",
        errorDetail: {
          message: "Worker: Video codec avc config not supported.",
          type: "not-supported",
        },
      },
    );
  });

  it("disables audio when audio parameters are invalid", async () => {
    if (!global.self.onmessage)
      throw new Error("Worker onmessage handler not set up");

    const invalid = { ...config, audioBitrate: 0 };
    const initMessage: InitializeWorkerMessage = { type: "initialize", config: invalid };
    await global.self.onmessage({ data: initMessage } as MessageEvent);

    expect(mockSelf.AudioEncoder).not.toHaveBeenCalled();
    expect(Mp4MuxerWrapperMock).toHaveBeenCalledWith(
      invalid,
      expect.any(Function),
      { disableAudio: true },
    );
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      { type: "initialized", actualVideoCodec: "avc1.42001f", actualAudioCodec: null },
    );
  });

  // Add more tests for addVideoData, addAudioData, error handling, etc.
  describe("worker error handling during initialization", () => {
    it("should post an error if video codec is not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

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
      );
    });

    it("should post an error if audio codec is not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

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
      );
    });

    it("should post an error if video encoder configuration fails", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

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
      );
    });

    it("should post an error if audio encoder configuration fails", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

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
        Promise.resolve({
          supported: true,
          config: { codec: "mp4a.40.2", numberOfChannels: config.channels },
        }),
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
            message:
              "Worker: Failed to initialize AudioEncoder: Audio configure failed",
            type: "initialization-failed",
            stack: expect.any(String),
          },
        },
      );
    });

    it("should post an error if config is missing", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
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
      );
    });

    it("should initialize WebM container and use WebMMuxerWrapper", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const webmConfig = { ...config, container: "webm" as const };
      // Adjust codec support mocks for VP9/Opus
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(async (_cfg) => ({
        supported: true,
        config: { codec: "vp09.00.50.08" },
      }));
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(async () => ({
        supported: true,
        config: { codec: "opus", numberOfChannels: webmConfig.channels },
      }));
      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: webmConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        { type: "initialized", actualVideoCodec: "vp09.00.50.08", actualAudioCodec: "opus" },
      );
    });

    it("should fallback to avc if preferred video codec (vp9) is not supported but avc is", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const vp9WorkerConfig: EncoderConfig = { // EncoderConfig型であることを明示
        ...config,
        codec: { ...config.codec, video: "vp9" as const },
      };

      const mockIsConfigSupported = vi.fn()
        .mockImplementationOnce(async (_cfg: VideoEncoderConfig) => {
          // VP9は非サポート
          return { supported: false, config: null };
        })
        .mockImplementationOnce(async (_cfg: VideoEncoderConfig) => {
          // AVCはサポート
          return {
            supported: true,
            config: { ..._cfg, codec: "avc1.42001f.test-hw" },
          };
        });
        
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = mockIsConfigSupported;

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: vp9WorkerConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockIsConfigSupported).toHaveBeenCalled();
      
      // 最後に postMessage される actualVideoCodec は、最初に成功したAVCのものを期待
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "initialized",
          actualVideoCodec: expect.stringMatching(/^avc1\./),
        }),
      );
      consoleWarnSpy.mockRestore();
    });

    it("should post error if fallback video codec (avc) is also not supported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const vp9WorkerConfig = { // test
        ...config,
        codec: { ...config.codec, video: "vp9" as const },
      };

      const mockIsConfigSupported = vi.fn().mockImplementation(async () => {
        return { supported: false, config: null }; // すべてのコーデックを非対応にする
      });
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = mockIsConfigSupported; // test

      const initMessage: InitializeWorkerMessage = { // test
        type: "initialize",
        config: vp9WorkerConfig, // test
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent); // test

      // isConfigSupportedが呼ばれたことを確認
      expect(mockIsConfigSupported).toHaveBeenCalled();
      
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            type: "not-supported",
          }),
        }),
      );
    });

    it("should fallback to aac if preferred audio codec (opus) is not supported but aac is", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
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
            config: {
              ..._cfg,
              codec: "mp4a.40.2.test",
              numberOfChannels: opusConfig.channels,
            },
          };
        return { supported: false, config: null };
      });

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
      );
      consoleWarnSpy.mockRestore();
    });

    it("should fallback to opus if fallback audio codec (aac) is not supported but opus is", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const opusConfig = {
        ...config,
        codec: { ...config.codec, audio: "opus" as const },
      };
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // @ts-ignore
      let opusCalled = false;
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        if (_cfg.codec === "opus") {
          if (!opusCalled) {
            opusCalled = true;
            return { supported: false, config: null };
          }
          return {
            supported: true,
            config: { ..._cfg, codec: "opus.test", numberOfChannels: opusConfig.channels },
          };
        }
        return { supported: false, config: null }; // AAC unsupported
      });

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: opusConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Worker: AAC audio codec is not supported. Falling back to Opus.",
      );
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "initialized",
          actualAudioCodec: "opus.test",
        }),
      );
      consoleWarnSpy.mockRestore();
    });

    it("should post error if both aac and opus are unsupported", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const opusConfig = {
        ...config,
        codec: { ...config.codec, audio: "opus" as const },
      };
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        return { supported: false, config: null }; // All codecs unsupported
      });

      const initMessage: InitializeWorkerMessage = {
        type: "initialize",
        config: opusConfig,
      };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: "Worker: Opus audio codec is not supported after fallback.",
            type: "not-supported",
          },
        },
      );
    });

    it("should post configuration error if encoder reports different channel count", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(async (_cfg) => {
        return {
          supported: true,
          config: { ..._cfg, numberOfChannels: 1 },
        };
      });

      const initMessage: InitializeWorkerMessage = { type: "initialize", config };
      await global.self.onmessage({ data: initMessage } as MessageEvent);

      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: {
            message: `AudioEncoder reported numberOfChannels (1) does not match configured channels (${config.channels}).`,
            type: "configuration-error",
          },
        },
      );
    });

    it("should post error if VideoEncoder API is not available", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const originalVideoEncoder = globalThis.VideoEncoder;
      const originalMockSelfVideoEncoder = mockSelf.VideoEncoder;
      delete (globalThis as any).VideoEncoder;
      delete (mockSelf as any).VideoEncoder;

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
      );
      globalThis.VideoEncoder = originalVideoEncoder;
      mockSelf.VideoEncoder = originalMockSelfVideoEncoder;
    });

    it("should post error if AudioEncoder API is not available", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      const originalAudioEncoder = globalThis.AudioEncoder;
      const originalMockSelfAudioEncoder = mockSelf.AudioEncoder;
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
      );
      globalThis.AudioEncoder = originalAudioEncoder;
      mockSelf.AudioEncoder = originalMockSelfAudioEncoder;
    });

    it("should post error if VideoEncoder constructor throws", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
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

      (mockSelf as any).VideoEncoder = mockVideoEncoderConstructor;

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
      (mockSelf as any).AudioEncoder = vi.fn(() => MockAudioEncoderInstance) as any;
      // @ts-ignore
      mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "mp4a.40.2", numberOfChannels: config.channels },
        }),
      );

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
      );

      (mockSelf as any).VideoEncoder = originalVideoEncoderCtor as any;
      (mockSelf as any).AudioEncoder = originalAudioEncoderCtor as any;
    });

    it("should post error if AudioEncoder constructor throws", async () => {
      if (!global.self.onmessage)
        throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

      const originalVideoEncoderCtorForThisTest = mockSelf.VideoEncoder;
      const originalAudioEncoderCtorForThisTest = mockSelf.AudioEncoder;

      const MockVideoInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        state: "unconfigured",
      };

      // @ts-ignore
      (mockSelf as any).VideoEncoder = vi.fn(() => MockVideoInstance) as any;
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "avc1.42001f.default" },
        }),
      );

      const constructorError = new Error("Audio Constructor failed for test");
      const mockAudioEncoderConstructorThatThrows = vi.fn();
      // @ts-ignore
      mockAudioEncoderConstructorThatThrows.isConfigSupported = vi.fn(() =>
        Promise.resolve({
          supported: true,
          config: { codec: "mp4a.40.2.test", numberOfChannels: config.channels },
        }),
      );
      mockAudioEncoderConstructorThatThrows.mockImplementation(() => {
        throw constructorError;
      });

      (mockSelf as any).AudioEncoder = mockAudioEncoderConstructorThatThrows as any;

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
      );

      (mockSelf as any).VideoEncoder = originalVideoEncoderCtorForThisTest as any;
      (mockSelf as any).AudioEncoder = originalAudioEncoderCtorForThisTest as any;
    });

    // isConfigSupportedWithHwFallback関数のブランチカバレッジを向上させるテスト
    it("should handle hardware acceleration preference fallbacks correctly", async () => {
      if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

      const prefHwConfig: EncoderConfig = { 
        ...config, 
        codec: { video: "avc", audio: "aac" }, 
        hardwareAcceleration: "prefer-hardware" 
      };
      
      mockSelf.VideoEncoder.isConfigSupported = vi.fn(async (cfg: any) => {
        return { supported: true, config: { ...cfg, codec: cfg.codec + ".hw-test" } };
      });
      
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      await global.self.onmessage({ 
        data: { type: "initialize", config: prefHwConfig } 
      } as MessageEvent);
      
      expect(mockSelf.VideoEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({ hardwareAcceleration: "prefer-hardware" })
      );
      
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ 
          type: "initialized",
          actualVideoCodec: expect.stringContaining(".hw-test")
        })
      );
      consoleWarnSpy.mockRestore();
    });
    
    it("should try no hardware acceleration preference when both prefer-hardware and prefer-software are not supported", async () => {
      if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();
      
      const defaultAvc = "avc1.42001f"; // configのデフォルト解像度に基づくAVC文字列

      const prefHwConfig: EncoderConfig = { 
        ...config, 
        codec: { video: "avc", audio: "aac" },
        hardwareAcceleration: "prefer-hardware" 
      };
      
      const mockIsConfigSupported = vi.fn()
        .mockImplementationOnce(async (_cfg: VideoEncoderConfig) => {
          return { supported: true, config: { ..._cfg, codec: defaultAvc + ".no-pref-fallback" } };
        });
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = mockIsConfigSupported;
      
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      await global.self.onmessage({ 
        data: { type: "initialize", config: prefHwConfig } 
      } as MessageEvent);
      
      expect(mockIsConfigSupported).toHaveBeenCalledWith(expect.any(Object));
      
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ 
          type: "initialized",
          actualVideoCodec: expect.stringMatching(/\.no-pref-fallback$|^avc1\./)
        })
      );
      consoleWarnSpy.mockRestore();
    });

    it("should post error when all hardware acceleration options fail", async () => {
      if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
      mockSelf.postMessage.mockClear();

      // VP9とAVCの両方で、全てのHWアクセラレーション試行が失敗する設定
      const failingConfig: EncoderConfig = { 
        ...config, 
        codec: { video: "vp9", audio: "aac" }, // videoCodec を vp9 に
        hardwareAcceleration: "prefer-hardware" 
      };

      const mockIsConfigSupported = vi.fn(async (_cfg: VideoEncoderConfig) => {
        // どのコーデック、どのHW設定でも失敗させる
        return { supported: false };
      });
      // @ts-ignore
      mockSelf.VideoEncoder.isConfigSupported = mockIsConfigSupported;
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await global.self.onmessage({ data: { type: "initialize", config: failingConfig } } as MessageEvent);

      expect(mockIsConfigSupported).toHaveBeenCalled();
      
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        {
          type: "error",
          errorDetail: expect.objectContaining({
            type: "not-supported",
          }),
        },
      );
      consoleWarnSpy.mockRestore();
    });
  });

});
