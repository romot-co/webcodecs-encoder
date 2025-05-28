import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
  CancelWorkerMessage,
  AddAudioDataMessage,
  ConnectAudioPortMessage,
} from "../src/types";
import {
  setupGlobals,
  cleanupGlobals,
  resetMocks,
  importWorker,
  mockSelf,
  mockMuxerInstanceForWorker,
} from "./helpers/worker-test-utils";
import { Mp4MuxerWrapper as ActualMp4MuxerWrapper } from "../src/muxers/mp4muxer";

let config: EncoderConfig;
let Mp4MuxerWrapperMock: ReturnType<typeof vi.mocked<typeof ActualMp4MuxerWrapper>>;

beforeEach(async () => {
  vi.resetModules();
  setupGlobals();
  resetMocks();
  const mp4muxerModule = await import("../src/muxers/mp4muxer");
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

describe("handleAddAudioData", () => {
  let initMessage: InitializeWorkerMessage;
  let audioEncoderErrorCallback: ((error: any) => void) | null = null;
  let mockAudioDataInstance: any;
  let mockAudioEncoderInstance: any;

  beforeEach(async () => {
    audioEncoderErrorCallback = null;
    // mockAudioDataInstance = { // 削除
    //   close: vi.fn(), // 削除
    //   format: "f32-planar", // 削除
    //   sampleRate: 48000, // 削除
    //   numberOfFrames: 1024, // 削除
    //   numberOfChannels: 1, // 削除
    //   timestamp: 0, // 削除
    //   duration: 21333, // 削除
    // }; // 削除
    // mockAudioEncoderInstance = { // 削除
    //   configure: vi.fn(), // 削除
    //   encode: vi.fn(), // 削除
    //   flush: vi.fn().mockResolvedValue(undefined), // 削除
    //   close: vi.fn(), // 削除
    //   state: "configured", // 削除
    //   encodeQueueSize: 0, // 削除
    // }; // 削除
    // mockSelf.AudioEncoder = vi.fn((options: { error: (e: any) => void }) => { // 削除
    //   audioEncoderErrorCallback = options.error; // 削除
    //   return mockAudioEncoderInstance; // 削除
    // }) as any; // 削除
    // mockSelf.AudioEncoder.isConfigSupported = vi.fn(() => // 削除
    //   Promise.resolve({ // 削除
    //     supported: true, // 削除
    //     config: { codec: "mp4a.40.2", numberOfChannels: config.channels }, // 削除
    //   }), // 削除
    // ); // 削除
    // globalThis.AudioEncoder = mockSelf.AudioEncoder; // 削除
    // globalThis.AudioData = vi.fn(() => mockAudioDataInstance) as any; // 削除

    // mockSelf.AudioEncoder は setupGlobals でモックコンストラクタとして設定される。
    // そのコンストラクタが返すインスタンスの error コールバックをキャプチャする。
    const aeMock = mockSelf.AudioEncoder as ReturnType<typeof vi.fn>;
    if (aeMock && aeMock.getMockImplementation()) {
        const originalImpl = aeMock.getMockImplementation();
        aeMock.mockImplementation((options: { error: (e: any) => void }) => {
            audioEncoderErrorCallback = options.error; // ここでコールバックを保存
            mockAudioEncoderInstance = originalImpl ? originalImpl(options) : {};
            // setupGlobalsのデフォルト実装をベースにテスト固有のモックをマージ
            Object.assign(mockAudioEncoderInstance, {
                configure: vi.fn(),
                encode: vi.fn(),
                flush: vi.fn().mockResolvedValue(undefined),
                close: vi.fn(),
                state: "configured",
                encodeQueueSize: 0,
            });
            return mockAudioEncoderInstance;
        });
    }
     // このテストスイート用にインスタンスを生成しておく (error callback 設定のため)
    if (typeof mockSelf.AudioEncoder === 'function') {
        mockAudioEncoderInstance = (mockSelf.AudioEncoder as any)({ error: (e:any) => { audioEncoderErrorCallback = e;} });
    }

    // AudioData のモックインスタンスの準備
    // globalThis.AudioData は setupGlobals でモックコンストラクタ (スパイ) として設定される。
    // そのプロトタイプの close がスパイになっている。
    // ここで特定のインスタンス mockAudioDataInstance を固定するのではなく、
    // テストケース内で AudioDataMock.prototype.close が呼ばれたかをチェックするように変更する。
    mockAudioDataInstance = { // ダミーのプレースホルダーとして
        close: globalThis.AudioData ? (globalThis.AudioData as any).prototype.close : vi.fn(),
        // 他のプロパティはテストケースに応じてモックされるか、実際のモックインスタンスのものが使われる
        format: "f32-planar",
        sampleRate: 48000,
        numberOfFrames: 1024,
        numberOfChannels: 1,
        timestamp: 0,
        duration: 21333,
    };

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
    expect((globalThis.AudioData as any).prototype.close).toHaveBeenCalled();
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "queueSize",
        videoQueueSize: 0,
        audioQueueSize: 0,
      },
    );
  });

  it("should post error if AudioData API is not available", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    mockSelf.postMessage.mockClear();

    const AudioDataOriginal = globalThis.AudioData;
    delete (globalThis as any).AudioData;
    (mockSelf as any).AudioData = undefined;

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
    );
    (globalThis as any).AudioData = AudioDataOriginal;
    (mockSelf as any).AudioData = AudioDataOriginal;
  });

  it("should post error if AudioData constructor throws", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    mockSelf.postMessage.mockClear();

    const AudioDataOriginal = globalThis.AudioData;
    const constructionErrorMessage = "AudioData construction failed";

    const mockAudioDataConstructorThatThrows = vi.fn().mockImplementation(() => {
      throw new Error(constructionErrorMessage);
    });
    (globalThis as any).AudioData = mockAudioDataConstructorThatThrows;
    (mockSelf as any).AudioData = mockAudioDataConstructorThatThrows;

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
    );
    (globalThis as any).AudioData = AudioDataOriginal;
    (mockSelf as any).AudioData = AudioDataOriginal;
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
    );
  });
});

describe("handleConnectAudioPort", () => {
  let initMessage: InitializeWorkerMessage;

  beforeEach(async () => {
    vi.resetModules();
    setupGlobals();
    resetMocks();
    const mp4muxerModule = await import("../src/muxers/mp4muxer");
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

    initMessage = { type: "initialize", config };
    if (global.self.onmessage) {
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      mockSelf.postMessage.mockClear();
    } else {
      throw new Error(
        "Worker onmessage handler not set up for handleConnectAudioPort tests",
      );
    }
  });

  it("should set up audioWorkletPort and handle messages", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    
    // モックポートの作成
    let savedMessageHandler: ((ev: MessageEvent) => any) | null = null;
    const mockPort = {
      set onmessage(handler: ((ev: MessageEvent) => any) | null) {
        savedMessageHandler = handler;
      },
      get onmessage() {
        return savedMessageHandler;
      },
      postMessage: vi.fn(),
      close: vi.fn(),
    };
    
    // AudioWorkletPortメッセージの送信
    const connectPortMessage: ConnectAudioPortMessage = {
      type: "connectAudioPort",
      port: mockPort as any,
    };
    
    await global.self.onmessage({ data: connectPortMessage } as MessageEvent);
    
    // ポートが設定され、onmessageハンドラが追加されたことを確認
    expect(savedMessageHandler).not.toBeNull();
    
    // オーディオメッセージをシミュレート
    const audioData = new Float32Array(512);
    const audioData2 = new Float32Array(512);
    if (savedMessageHandler) {
      await (savedMessageHandler as (ev: MessageEvent) => Promise<void>)({
        data: {
          type: "addAudioData",
          audioData: [audioData, audioData2],
          timestamp: 1000,
          format: "f32-planar",
          sampleRate: 48000,
          numberOfFrames: 512,
          numberOfChannels: 2,
        }
      } as MessageEvent);
    }
    
    // AudioDataが処理されたことを確認
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "queueSize",
        videoQueueSize: 0,
        audioQueueSize: 0,
      },
    );
  });
});
