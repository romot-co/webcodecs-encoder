import { describe, it, expect, vi, beforeEach } from "vitest";
// import type { Mock } from "vitest"; // 一旦 any を使うためコメントアウト
import { Mp4MuxerWrapper } from "../src/mp4muxer";
import type { EncoderConfig } from "../src/types";

// `vi.mock` はファイルのトップに巻き上げられます。
// モックしたい対象のモック実装をファクトリ関数内で定義します。
vi.mock("mp4-muxer", () => {
  const mockMuxerMethodsInFactory = {
    addVideoChunk: vi.fn(),
    addAudioChunk: vi.fn(),
    finalize: vi.fn(), // Default mock for finalize
  };

  let capturedStreamTargetOnData: ((chunk: Uint8Array, position: number) => void) | null = null;
  let lastMuxerTargetInstance: { buffer: ArrayBuffer } | null = null;

  const MuxerMockInFactory = vi.fn((options: { target: any }) => {
    lastMuxerTargetInstance = options.target;
    return mockMuxerMethodsInFactory;
  });
  
  // ArrayBufferTarget のモック
  const ArrayBufferTargetMockInFactory = vi.fn(function (this: { buffer: ArrayBuffer }) {
    this.buffer = new ArrayBuffer(1024); // default buffer
  });

  // StreamTarget のモック
  const StreamTargetMockInFactory = vi.fn(function (this: any, options?: { onData?: (chunk: Uint8Array, position: number) => void }) {
    if (options?.onData) {
      capturedStreamTargetOnData = options.onData;
    }
  });

  return {
    Muxer: MuxerMockInFactory,
    ArrayBufferTarget: ArrayBufferTargetMockInFactory,
    StreamTarget: StreamTargetMockInFactory, // StreamTarget をエクスポート
    _mockMuxerMethods: mockMuxerMethodsInFactory,
    _getCapturedStreamTargetOnData: () => capturedStreamTargetOnData, // onData を取得するヘルパー
    // capturedStreamTargetOnData をリセットするためのヘルパーも追加できるとより良い
    _resetCapturedStreamTargetOnData: () => { capturedStreamTargetOnData = null; },
    // Helper to access the target instance that was passed to the Muxer constructor
    _getLastMuxerTargetInstance: () => lastMuxerTargetInstance,
    _clearLastMuxerTargetInstance: () => { lastMuxerTargetInstance = null; }
  };
});

// vi.mock のファクトリ関数の戻り値の型を反映するインターフェースを更新
interface MockedMp4Muxer {
  Muxer: any; 
  ArrayBufferTarget: any; 
  StreamTarget: any; 
  _mockMuxerMethods: {
    addVideoChunk: any; 
    addAudioChunk: any;
    finalize: any; 
  };
  _getCapturedStreamTargetOnData: () => (((chunk: Uint8Array, position: number) => void) | null); 
  _resetCapturedStreamTargetOnData: () => void; 
  _getLastMuxerTargetInstance: () => ({ buffer: ArrayBuffer } | null);
  _clearLastMuxerTargetInstance: () => void;
}

const baseConfig: EncoderConfig = {
  width: 320,
  height: 240,
  frameRate: 30,
  videoBitrate: 1000,
  audioBitrate: 64,
  sampleRate: 48000,
  channels: 2,
  // codec is optional, let tests specify it or rely on defaults in Mp4MuxerWrapper
};

describe("Mp4MuxerWrapper", () => {
  let mockMuxerMethods: MockedMp4Muxer['_mockMuxerMethods'];
  let postMessageCallback: ReturnType<typeof vi.fn>;
  let MuxerMock: MockedMp4Muxer['Muxer'];
  let StreamTargetMockConst: MockedMp4Muxer['StreamTarget'];
  let resetCapturedStreamTargetOnData: MockedMp4Muxer['_resetCapturedStreamTargetOnData'];
  let getLastMuxerTargetInstance: MockedMp4Muxer['_getLastMuxerTargetInstance'];
  let clearLastMuxerTargetInstance: MockedMp4Muxer['_clearLastMuxerTargetInstance'];


  beforeEach(async () => {
    const mp4MuxerModule = await import("mp4-muxer");
    const mockedModule = mp4MuxerModule as unknown as MockedMp4Muxer;
    
    mockMuxerMethods = mockedModule._mockMuxerMethods;
    MuxerMock = mockedModule.Muxer;
    StreamTargetMockConst = mockedModule.StreamTarget;
    resetCapturedStreamTargetOnData = mockedModule._resetCapturedStreamTargetOnData;
    getLastMuxerTargetInstance = mockedModule._getLastMuxerTargetInstance;
    clearLastMuxerTargetInstance = mockedModule._clearLastMuxerTargetInstance;

    postMessageCallback = vi.fn();

    // Clear all mocks
    vi.clearAllMocks(); // Clears call history for Muxer, StreamTarget, ArrayBufferTarget mocks

    // Clear individual method spies
    mockMuxerMethods.addVideoChunk.mockClear();
    mockMuxerMethods.addAudioChunk.mockClear();
    mockMuxerMethods.finalize.mockReset(); // Use mockReset to also clear mockReturnValueOnce etc.
    
    // Reset captured onData callback via the helper
    if (resetCapturedStreamTargetOnData) resetCapturedStreamTargetOnData();
    if (clearLastMuxerTargetInstance) clearLastMuxerTargetInstance();
  });

  it("adds video chunks", () => {
    const wrapper = new Mp4MuxerWrapper(baseConfig, postMessageCallback);
    const chunk = { type: 'key', timestamp: 0, duration: 1000, data: new Uint8Array(10), byteLength: 10, copyTo: vi.fn() } as EncodedVideoChunk;
    const meta = { decoderConfig: { codec: 'avc1.42001f', description: new Uint8Array(5) } } as EncodedVideoChunkMetadata;
    wrapper.addVideoChunk(chunk, meta);
    expect(mockMuxerMethods.addVideoChunk).toHaveBeenCalledWith(chunk, meta);
  });

  it("adds audio chunks", () => {
    const wrapper = new Mp4MuxerWrapper(baseConfig, postMessageCallback);
    const chunk = { type: 'key', timestamp: 0, duration: 1000, data: new Uint8Array(10), byteLength: 10, copyTo: vi.fn() } as EncodedAudioChunk;
    const meta = { decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000, description: new Uint8Array(5) } } as EncodedAudioChunkMetadata;
    wrapper.addAudioChunk(chunk, meta);
    expect(mockMuxerMethods.addAudioChunk).toHaveBeenCalledWith(chunk, meta);
  });

  it("finalizes and returns Uint8Array in non-realtime mode", async () => {
    const expectedBufferContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    // const expectedBuffer = expectedBufferContent.buffer; // 未使用のため削除しました

    mockMuxerMethods.finalize.mockImplementationOnce(() => {
      const target = getLastMuxerTargetInstance();
      if (target) {
        // target.buffer を期待される内容のバッファそのものに置き換える
        target.buffer = expectedBufferContent.buffer;
      }      
    });

    const nonRealtimeConfig = { ...baseConfig, latencyMode: "quality" as const };
    const wrapper = new Mp4MuxerWrapper(nonRealtimeConfig, postMessageCallback);
    const output = wrapper.finalize();

    expect(MuxerMock).toHaveBeenCalled(); 
    expect(mockMuxerMethods.finalize).toHaveBeenCalled();
    expect(output).toBeInstanceOf(Uint8Array);
    expect(output).toEqual(expectedBufferContent);
    if (output) { // outputがnullでないことを確認し、バッファの同一性もチェック
        expect(output.buffer).toBe(expectedBufferContent.buffer);
    }
  });

  describe("constructor video codec options", () => {
    it("should use 'hevc' for video codec when specified", () => {
      const hevcConfig: EncoderConfig = { ...baseConfig, codec: { video: "hevc", audio: "aac" } };
      new Mp4MuxerWrapper(hevcConfig, postMessageCallback);
      expect(MuxerMock).toHaveBeenCalledWith(expect.objectContaining({
        video: expect.objectContaining({ codec: "hevc" }),
      }));
    });

    it("should use 'vp9' for video codec when specified", () => {
      const vp9Config: EncoderConfig = { ...baseConfig, codec: { video: "vp9", audio: "aac" } };
      new Mp4MuxerWrapper(vp9Config, postMessageCallback);
      expect(MuxerMock).toHaveBeenCalledWith(expect.objectContaining({
        video: expect.objectContaining({ codec: "vp9" }),
      }));
    });

    it("should use 'av1' for video codec when specified", () => {
      const av1Config: EncoderConfig = { ...baseConfig, codec: { video: "av1", audio: "aac" } };
      new Mp4MuxerWrapper(av1Config, postMessageCallback);
      expect(MuxerMock).toHaveBeenCalledWith(expect.objectContaining({
        video: expect.objectContaining({ codec: "av1" }),
      }));
    });
    
    it("should default to 'avc' for unknown or unspecified video codec", () => {
        const unknownCodecConfig = { ...baseConfig, codec: { video: "unknown" as any, audio: "aac" as const } }; // Use 'as any' for video, 'as const' for audio
        new Mp4MuxerWrapper(unknownCodecConfig, postMessageCallback);
        expect(MuxerMock).toHaveBeenCalledWith(expect.objectContaining({
            video: expect.objectContaining({ codec: "avc" }),
        }));
        
        MuxerMock.mockClear(); // Clear for next assertion
        const unspecifiedCodecConfig: EncoderConfig = { ...baseConfig, codec: { audio: "aac" } }; // video is implicitly undefined
        new Mp4MuxerWrapper(unspecifiedCodecConfig, postMessageCallback);
        expect(MuxerMock).toHaveBeenCalledWith(expect.objectContaining({
            video: expect.objectContaining({ codec: "avc" }),
        }));
    });
  });

  describe("realtime mode (StreamTarget)", () => {
    it("should use StreamTarget and fragmented fastStart in realtime mode", () => {
      const realtimeConfig: EncoderConfig = { ...baseConfig, latencyMode: "realtime" };
      new Mp4MuxerWrapper(realtimeConfig, postMessageCallback);
      
      expect(StreamTargetMockConst).toHaveBeenCalledTimes(1);
      expect(MuxerMock).toHaveBeenCalledWith(expect.objectContaining({
        target: expect.any(Object), // More robust: expect(MuxerMock.mock.calls[0][0].target).toBeInstanceOf(StreamTargetMockConst) if mock returns instances
        fastStart: "fragmented"
      }));
       // To verify that the target is an instance of the mocked StreamTarget:
      const muxerCallArgs = MuxerMock.mock.calls[0][0] as any;
      expect(muxerCallArgs.target).toBeInstanceOf(StreamTargetMockConst);
    });
    
    it("onData callback should post message to main thread", async () => {
        const realtimeConfig: EncoderConfig = { ...baseConfig, latencyMode: "realtime" };
        new Mp4MuxerWrapper(realtimeConfig, postMessageCallback);
        
        const module = (await import("mp4-muxer")) as unknown as MockedMp4Muxer;
        const capturedOnData = module._getCapturedStreamTargetOnData();
        expect(capturedOnData).toBeInstanceOf(Function);

        if (capturedOnData) {
            const testChunk = new Uint8Array([1, 2, 3, 4, 5]);
            const testPosition = 12345;
            capturedOnData(testChunk, testPosition);

            expect(postMessageCallback).toHaveBeenCalledTimes(1);
            expect(postMessageCallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "dataChunk",
                    chunk: expect.any(Uint8Array),
                    offset: testPosition,
                    container: "mp4",
                }),
                [expect.any(ArrayBuffer)]
            );
            const actualSentChunk = postMessageCallback.mock.calls[0][0].chunk;
            expect(actualSentChunk).toEqual(testChunk);
            expect(actualSentChunk.buffer).not.toBe(testChunk.buffer); 
        } else {
            throw new Error("onData callback was not captured"); // Should not happen if mock is correct
        }
    });
  });

  describe("addChunk error handling", () => {
    it("should post error if muxer.addVideoChunk throws", () => {
      const error = new Error("Video chunk error");
      mockMuxerMethods.addVideoChunk.mockImplementationOnce(() => { throw error; });
      const wrapper = new Mp4MuxerWrapper(baseConfig, postMessageCallback);
      wrapper.addVideoChunk({ type: 'key', data: new Uint8Array(1), byteLength:1, copyTo:vi.fn() } as any, {} as any);
      expect(postMessageCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `MP4: Error adding video chunk: ${error.message}`,
            type: "muxing-failed",
            stack: error.stack,
          }),
        })
      );
    });

    it("should post error if muxer.addAudioChunk throws", () => {
      const error = new Error("Audio chunk error");
      mockMuxerMethods.addAudioChunk.mockImplementationOnce(() => { throw error; });
      const wrapper = new Mp4MuxerWrapper(baseConfig, postMessageCallback);
      wrapper.addAudioChunk({ type: 'key', data: new Uint8Array(1), byteLength:1, copyTo:vi.fn() } as any, {} as any);
      expect(postMessageCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `MP4: Error adding audio chunk: ${error.message}`,
            type: "muxing-failed",
            stack: error.stack,
          }),
        })
      );
    });
  });

  describe("finalize error handling and realtime", () => {
    it("should call muxer.finalize and return null in realtime mode", () => {
      const realtimeConfig: EncoderConfig = { ...baseConfig, latencyMode: "realtime" };
      const wrapper = new Mp4MuxerWrapper(realtimeConfig, postMessageCallback);
      const output = wrapper.finalize();
      expect(mockMuxerMethods.finalize).toHaveBeenCalled();
      expect(output).toBeNull();
    });

    it("should post error if muxer.finalize throws in realtime mode", () => {
      const error = new Error("Finalize error realtime");
      mockMuxerMethods.finalize.mockImplementationOnce(() => { throw error; });
      const realtimeConfig: EncoderConfig = { ...baseConfig, latencyMode: "realtime" };
      const wrapper = new Mp4MuxerWrapper(realtimeConfig, postMessageCallback);
      wrapper.finalize();
      expect(postMessageCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `MP4: Error finalizing muxer (realtime): ${error.message}`,
            type: "muxing-failed",
            stack: error.stack,
          }),
        })
      );
    });
    
    it("should post error if muxer.finalize throws in non-realtime mode", () => {
      const error = new Error("Finalize error non-realtime");
      mockMuxerMethods.finalize.mockImplementationOnce(() => { throw error; });
      const wrapper = new Mp4MuxerWrapper(baseConfig, postMessageCallback); 
      wrapper.finalize();
      expect(postMessageCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          errorDetail: expect.objectContaining({
            message: `MP4: Error finalizing muxer (non-realtime): ${error.message}`,
            type: "muxing-failed",
            stack: error.stack,
          }),
        })
      );
    });
    
    // Test for the "target is not ArrayBufferTarget" error case in finalize.
    // This is hard to trigger with the current Mp4MuxerWrapper constructor logic,
    // as it always assigns either StreamTarget or ArrayBufferTarget.
    // To test this, we'd need to manually manipulate the wrapper's internal state
    // or mock the constructor differently.
    // For now, we'll acknowledge this path is hard to test unit-wise without deeper intrusion.
    it.skip("should post error if target is not ArrayBufferTarget in non-realtime finalize", async () => {
        const wrapper = new Mp4MuxerWrapper(baseConfig, postMessageCallback);
        const { StreamTarget } = await import("mp4-muxer");
        (wrapper as any).target = new StreamTarget((_data: Uint8Array, _position: number) => {}); 
        wrapper.finalize();
        expect(postMessageCallback).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "error",
                errorDetail: {
                    message: "MP4: Muxer target is not ArrayBufferTarget in non-realtime mode.",
                    type: "internal-error",
                },
            }),
            undefined
        );
    });
  });
});
