import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
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

let config: EncoderConfig;
let Mp4MuxerWrapperMock: ReturnType<typeof vi.mocked<typeof ActualMp4MuxerWrapper>>;

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

describe("audio initialization", () => {
  it("falls back to opus if aac is unsupported", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // @ts-ignore
    mockSelf.AudioEncoder.isConfigSupported = vi.fn(async (cfg) => {
      if (cfg.codec === "mp4a.40.2") return { supported: false, config: null };
      if (cfg.codec === "opus")
        return {
          supported: true,
          config: { ...cfg, codec: "opus.test", numberOfChannels: cfg.numberOfChannels },
        };
      return { supported: false, config: null };
    });
    globalThis.AudioEncoder = mockSelf.AudioEncoder;

    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Worker: Audio codec aac not supported or config invalid. Falling back to Opus.",
    );
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      { type: "initialized", actualVideoCodec: "avc1.42001f", actualAudioCodec: "opus.test" },
      undefined,
    );
    consoleWarnSpy.mockRestore();
  });

  it("posts configuration error when channels differ", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    // @ts-ignore
    mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
      Promise.resolve({ supported: true, config: { codec: "mp4a.40.2", numberOfChannels: 1 } }),
    );
    globalThis.AudioEncoder = mockSelf.AudioEncoder;

    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);

    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "error",
        errorDetail: {
          message: `AudioEncoder returned numberOfChannels 1 that does not match configured channels (${config.channels}).`,
          type: "configuration-error",
        },
      },
      undefined,
    );
  });
});

describe("handleAddAudioData", () => {
  let initMessage: InitializeWorkerMessage;
  let audioEncoderErrorCallback: ((error: any) => void) | null = null;
  let mockAudioDataInstance: any;
  let mockAudioEncoderInstance: any;

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
    mockAudioEncoderInstance = {
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      state: "configured",
      encodeQueueSize: 0,
    };
    mockSelf.AudioEncoder = vi.fn((options: { error: (e: any) => void }) => {
      audioEncoderErrorCallback = options.error;
      return mockAudioEncoderInstance;
    }) as any;
    mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
      Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
    );
    globalThis.AudioEncoder = mockSelf.AudioEncoder;
    globalThis.AudioData = vi.fn(() => mockAudioDataInstance) as any;

    const audioConfig = { ...config, audioBitrate: 128000 };
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
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
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
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    config.audioBitrate = 0;

    const initMessage: InitializeWorkerMessage = {
      type: "initialize",
      config,
    };
    const beforeCalls = mockSelf.AudioEncoder.mock.calls.length;
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    mockSelf.postMessage.mockClear();
    mockMuxerInstanceForWorker.addAudioChunk.mockClear();
    expect(mockSelf.AudioEncoder.mock.calls.length).toBe(beforeCalls);

    const dummyAudioSamples = new Float32Array(512);
    const audioDataArray: Float32Array[] = [];
    for (let i = 0; i < config.channels; i++) {
      audioDataArray.push(dummyAudioSamples.slice());
    }

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: audioDataArray,
      timestamp: 0,
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: 512,
      numberOfChannels: config.channels,
    };
    await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
    expect(mockSelf.postMessage).not.toHaveBeenCalled();
    expect(mockMuxerInstanceForWorker.addAudioChunk).not.toHaveBeenCalled();
  });

  it("should encode provided AudioData when audio field is set", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audio: mockAudioDataInstance,
      timestamp: 0,
      format: "f32",
      sampleRate: 48000,
      numberOfFrames: 1024,
      numberOfChannels: 1,
    };
    await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
    expect(mockAudioEncoderInstance.encode).toHaveBeenCalledWith(mockAudioDataInstance);
    expect((globalThis as any).AudioData).not.toHaveBeenCalled();
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "queueSize",
        videoQueueSize: 0,
        audioQueueSize: 0,
      },
      undefined,
    );
  });

  it("should close AudioData after encoding when created internally", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    const dummyAudioSamples = new Float32Array(512);
    const audioDataArray: Float32Array[] = [];
    for (let i = 0; i < config.channels; i++) {
      audioDataArray.push(dummyAudioSamples.slice());
    }

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: audioDataArray,
      timestamp: 0,
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: 512,
      numberOfChannels: config.channels,
    };
    await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
    expect(mockAudioDataInstance.close).toHaveBeenCalled();
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "queueSize",
        videoQueueSize: 0,
        audioQueueSize: 0,
      },
      undefined,
    );
  });

  it("should post error if AudioData API is not available", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const AudioDataOriginal = (globalThis as any).AudioData;
    delete (globalThis as any).AudioData;

    const initMessage: InitializeWorkerMessage = {
      type: "initialize",
      config,
    };
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    mockSelf.postMessage.mockClear();

    const dummyAudioSamples = new Float32Array(512);
    const audioDataArray: Float32Array[] = [];
    for (let i = 0; i < config.channels; i++) {
      audioDataArray.push(dummyAudioSamples.slice());
    }

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: audioDataArray,
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
          message: "Worker: AudioData not available",
          type: "not-supported",
        },
      },
      undefined,
    );
    (globalThis as any).AudioData = AudioDataOriginal;
  });

  it("should post error if AudioData constructor throws", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const AudioDataOriginal = (globalThis as any).AudioData;
    const constructionErrorMessage = "AudioData construction failed";
    (globalThis as any).AudioData = vi.fn().mockImplementation(() => {
      throw new Error(constructionErrorMessage);
    });

    const initMessage: InitializeWorkerMessage = {
      type: "initialize",
      config,
    };
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    mockSelf.postMessage.mockClear();

    const dummyAudioSamples = new Float32Array(512);
    const audioDataArray: Float32Array[] = [];
    for (let i = 0; i < config.channels; i++) {
      audioDataArray.push(dummyAudioSamples.slice());
    }

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: audioDataArray,
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
        }),
      }),
      undefined,
    );
    (globalThis as any).AudioData = AudioDataOriginal;
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
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: [],
      timestamp: 0,
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: 0,
      numberOfChannels: 0,
    };
    await global.self.onmessage({ data: addAudioMessage } as MessageEvent);
    expect(mockSelf.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("should post error if audio data channel count does not match configured channels", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    const addAudioMessage: AddAudioDataMessage = {
      type: "addAudioData",
      audioData: [new Float32Array(10)],
      timestamp: 0,
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: 10,
      numberOfChannels: 1,
    };
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
