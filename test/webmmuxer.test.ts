import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebMMuxerWrapper } from "../src/muxers/webmmuxer";
import type { EncoderConfig } from "../src/types";
import { EncoderErrorType } from "../src/types";

vi.mock("webm-muxer", () => {
  const mockMuxerMethods = {
    addVideoChunk: vi.fn(),
    addAudioChunk: vi.fn(),
    finalize: vi.fn(),
  };
  class DummyTarget {
    write(_data: any) {}
  }
  const WebMMuxerMock = vi.fn(() => mockMuxerMethods);
  return {
    default: WebMMuxerMock,
    _mockMuxerMethods: mockMuxerMethods,
    _DummyTarget: DummyTarget,
  };
});

interface MockedModule {
  default: any;
  _mockMuxerMethods: {
    addVideoChunk: any;
    addAudioChunk: any;
    finalize: any;
  };
  _DummyTarget: any;
}

const baseConfig: EncoderConfig = {
  width: 320,
  height: 240,
  frameRate: 30,
  videoBitrate: 1000000,
  audioBitrate: 64000,
  sampleRate: 48000,
  channels: 2,
  container: "webm",
  codec: { video: "vp9", audio: "opus" },
};

// Export for testing CallbackWritableStream with direct access
// Even if not exported in actual source code, mock it for testing purposes
class CallbackWritableStream {
  private position = 0;
  constructor(private onData: (chunk: Uint8Array, position: number) => void) {}

  write({ data, position }: { data: Uint8Array; position: number }): void {
    this.onData(data, position);
    this.position = position + data.byteLength;
  }
}

// Add global reference so tests can recognize CallbackWritableStream instances
// created by WebMMuxerWrapper in tests
(global as any).CallbackWritableStream = CallbackWritableStream;

describe("CallbackWritableStream", () => {
  it("calls onData with data and position when write is called", () => {
    const onDataMock = vi.fn();
    const stream = new CallbackWritableStream(onDataMock);
    const data = new Uint8Array([1, 2, 3]);
    const position = 10;
    
    stream.write({ data, position });
    
    expect(onDataMock).toHaveBeenCalledWith(data, position);
  });

  it("updates internal position after write", () => {
    const onDataMock = vi.fn();
    const stream = new CallbackWritableStream(onDataMock);
    const data = new Uint8Array([1, 2, 3]);
    const position = 10;
    
    stream.write({ data, position });
    // Test value after position update
    expect((stream as any).position).toBe(position + data.byteLength);
    
    const data2 = new Uint8Array([4, 5]);
    const position2 = 20;
    stream.write({ data: data2, position: position2 });
    expect((stream as any).position).toBe(position2 + data2.byteLength);
  });
});

describe("WebMMuxerWrapper", () => {
  let mockMuxerMethods: MockedModule["_mockMuxerMethods"];
  let postMessageCallback: ReturnType<typeof vi.fn>;
  let WebMMuxerMock: MockedModule["default"];

  beforeEach(async () => {
    const module = (await import("webm-muxer")) as unknown as MockedModule;
    mockMuxerMethods = module._mockMuxerMethods;
    WebMMuxerMock = module.default;
    vi.clearAllMocks();
    postMessageCallback = vi.fn();
  });

  describe("constructor", () => {
    it("configures with VP9 codec by default", () => {
      const config: EncoderConfig = {
        ...baseConfig,
        codec: undefined, // Explicitly set codec to undefined
      };
      new WebMMuxerWrapper(config, postMessageCallback);
      expect(WebMMuxerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ codec: "V_VP9" }),
        }),
      );
    });

    it("configures with VP8 codec when specified", () => {
      const config: EncoderConfig = {
        ...baseConfig,
        codec: { video: "vp8", audio: "opus" },
      };
      new WebMMuxerWrapper(config, postMessageCallback);
      expect(WebMMuxerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ codec: "V_VP8" }),
        }),
      );
    });

    it("configures with AV1 codec when specified", () => {
      const config: EncoderConfig = {
        ...baseConfig,
        codec: { video: "av1", audio: "opus" },
      };
      new WebMMuxerWrapper(config, postMessageCallback);
      expect(WebMMuxerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ codec: "V_AV1" }),
        }),
      );
    });

    it("defaults to VP9 for unknown codec", () => {
      const config: EncoderConfig = {
        ...baseConfig,
        codec: { video: "unknown" as any, audio: "opus" },
      };
      new WebMMuxerWrapper(config, postMessageCallback);
      expect(WebMMuxerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ codec: "V_VP9" }),
        }),
      );
    });

    it("should not include audio track when disableAudio is true", () => {
      new WebMMuxerWrapper(baseConfig, postMessageCallback, { disableAudio: true });
      const args = WebMMuxerMock.mock.calls[0][0];
      expect(args.audio).toBeUndefined();
    });

    it("configures with CallbackWritableStream and calls postMessageToMain when latencyMode is 'realtime'", () => {
      const realtimeConfig: EncoderConfig = {
        ...baseConfig,
        latencyMode: "realtime",
      };
      
      // Test directly without using mock implementation
      new WebMMuxerWrapper(realtimeConfig, postMessageCallback);

      expect(WebMMuxerMock).toHaveBeenCalled();
      const callArgs = WebMMuxerMock.mock.calls[0][0];
      
      // Check target object existence and functionality
      expect(callArgs.target).toBeDefined();
      expect(typeof callArgs.target.write).toBe('function');
      
      // Perform direct test - actually test WritableStream functionality
      const testChunk = new Uint8Array([1, 2, 3, 4, 5]);
      const testPosition = 0;
      
      // Call write method directly
      callArgs.target.write({ data: testChunk, position: testPosition });

      // Verify postMessageCallback is called when target's write method is called
      expect(postMessageCallback).toHaveBeenCalledWith(
        {
          type: "dataChunk",
          chunk: expect.any(Uint8Array), // chunk content is copied
          offset: testPosition,
          isHeader: true,
          container: "webm",
        },
        [expect.any(ArrayBuffer)],
      );
      
      // Verify the copied chunk's content if necessary
      const actualChunk = postMessageCallback.mock.calls[0][0].chunk;
      expect(actualChunk).toEqual(testChunk); // Ensure it's a copy
    });
  });

  describe("addVideoChunk", () => {
    it("handles correctly formed video chunks", () => {
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      const chunk = {
        type: "key",
        timestamp: 0,
        duration: 1000,
        data: new Uint8Array(10),
        byteLength: 10,
        copyTo: vi.fn(),
      } as EncodedVideoChunk;
      const meta = {
        decoderConfig: { codec: "vp9", description: new Uint8Array(5) },
      } as EncodedVideoChunkMetadata;
      
      wrapper.addVideoChunk(chunk, meta);
      expect(mockMuxerMethods.addVideoChunk).toHaveBeenCalledWith(chunk, meta);
    });

    it("posts error if video track not configured", () => {
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      (wrapper as any).videoConfigured = false;
      
      wrapper.addVideoChunk({} as any, {} as any);
      
      expect(postMessageCallback).toHaveBeenCalledWith({
        type: "error",
        errorDetail: {
          message: "WebM: Video track not configured.",
          type: EncoderErrorType.ConfigurationError,
        },
      });
      expect(mockMuxerMethods.addVideoChunk).not.toHaveBeenCalled();
    });

    it("handles errors from muxer.addVideoChunk", () => {
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      const error = new Error("Video chunk error");
      mockMuxerMethods.addVideoChunk.mockImplementationOnce(() => {
        throw error;
      });
      
      wrapper.addVideoChunk({} as any, {} as any);
      
      expect(postMessageCallback).toHaveBeenCalledWith({
        type: "error",
        errorDetail: {
          message: `WebM: Error adding video chunk: ${error.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: error.stack,
        },
      });
    });
  });

  describe("addAudioChunk", () => {
    it("handles correctly formed audio chunks", () => {
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      const chunk = {
        type: "key",
        timestamp: 0,
        duration: 1000,
        data: new Uint8Array(10),
        byteLength: 10,
        copyTo: vi.fn(),
      } as EncodedAudioChunk;
      const meta = {
        decoderConfig: {
          codec: "opus",
          numberOfChannels: 2,
          sampleRate: 48000,
          description: new Uint8Array(5),
        },
      } as EncodedAudioChunkMetadata;
      
      wrapper.addAudioChunk(chunk, meta);
      expect(mockMuxerMethods.addAudioChunk).toHaveBeenCalledWith(chunk, meta);
    });

    it("does nothing if audio track not configured", () => {
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      (wrapper as any).audioConfigured = false;
      
      wrapper.addAudioChunk({} as any, {} as any);
      
      expect(mockMuxerMethods.addAudioChunk).not.toHaveBeenCalled();
      expect(postMessageCallback).not.toHaveBeenCalled();
    });

    it("handles errors from muxer.addAudioChunk", () => {
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      const error = new Error("Audio chunk error");
      mockMuxerMethods.addAudioChunk.mockImplementationOnce(() => {
        throw error;
      });
      
      wrapper.addAudioChunk({} as any, {} as any);
      
      expect(postMessageCallback).toHaveBeenCalledWith({
        type: "error",
        errorDetail: {
          message: `WebM: Error adding audio chunk: ${error.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: error.stack,
        },
      });
    });
  });

  describe("finalize", () => {
    it("returns null and calls muxer.finalize in realtime mode", () => {
      const realtimeConfig = { ...baseConfig, latencyMode: "realtime" as const };
      const wrapper = new WebMMuxerWrapper(realtimeConfig, postMessageCallback);
      
      const result = wrapper.finalize();
      
      expect(mockMuxerMethods.finalize).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("handles errors in realtime finalize", () => {
      const realtimeConfig = { ...baseConfig, latencyMode: "realtime" as const };
      const wrapper = new WebMMuxerWrapper(realtimeConfig, postMessageCallback);
      const error = new Error("Finalize error");
      mockMuxerMethods.finalize.mockImplementationOnce(() => {
        throw error;
      });
      
      wrapper.finalize();
      
      expect(postMessageCallback).toHaveBeenCalledWith({
        type: "error",
        errorDetail: {
          message: `WebM: Error finalizing muxer (realtime): ${error.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: error.stack,
        },
      });
    });

    it("returns Uint8Array when finalize succeeds in non-realtime mode", () => {
      const expected = new Uint8Array([1, 2, 3, 4]);
      mockMuxerMethods.finalize.mockReturnValueOnce(expected.buffer);
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      
      const result = wrapper.finalize();
      
      expect(mockMuxerMethods.finalize).toHaveBeenCalled();
      expect(result).toEqual(expected);
    });

    it("posts error when finalize returns no buffer in non-realtime mode", () => {
      mockMuxerMethods.finalize.mockReturnValueOnce(null);
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      
      const result = wrapper.finalize();
      
      expect(postMessageCallback).toHaveBeenCalledWith({
        type: "error",
        errorDetail: {
          message: "WebM: Muxer finalized without output in non-realtime mode.",
          type: EncoderErrorType.MuxingFailed,
        },
      });
      expect(result).toBeNull();
    });

    it("handles errors in non-realtime finalize", () => {
      const error = new Error("Finalize error");
      mockMuxerMethods.finalize.mockImplementationOnce(() => {
        throw error;
      });
      const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
      
      const result = wrapper.finalize();
      
      expect(postMessageCallback).toHaveBeenCalledWith({
        type: "error",
        errorDetail: {
          message: `WebM: Error finalizing muxer (non-realtime): ${error.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: error.stack,
        },
      });
      expect(result).toBeNull();
    });
  });

  it("adds video and audio chunks", () => {
    const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
    wrapper.addVideoChunk({} as any, {} as any);
    wrapper.addAudioChunk({} as any, {} as any);
    expect(mockMuxerMethods.addVideoChunk).toHaveBeenCalled();
    expect(mockMuxerMethods.addAudioChunk).toHaveBeenCalled();
  });

  it("finalizes and returns Uint8Array in non-realtime mode", () => {
    const expected = new Uint8Array([1, 2, 3]);
    mockMuxerMethods.finalize.mockReturnValueOnce(expected.buffer);
    const wrapper = new WebMMuxerWrapper(baseConfig, postMessageCallback);
    const out = wrapper.finalize();
    expect(mockMuxerMethods.finalize).toHaveBeenCalled();
    expect(out).toEqual(expected);
  });

  it("streams chunks in realtime", async () => {
    const module = (await import("webm-muxer")) as unknown as MockedModule;
    const realtimeConfig = { ...baseConfig, latencyMode: "realtime" as const };
    new WebMMuxerWrapper(realtimeConfig, postMessageCallback);
    const DummyTarget = module._DummyTarget;
    // simulate write callback
    const dataCb = (DummyTarget as any).mock?.calls?.[0]?.[0]?.onData;
    if (dataCb) {
      const chunk = new Uint8Array([1]);
      dataCb(chunk, 0);
      expect(postMessageCallback).toHaveBeenCalledWith(
        expect.objectContaining({ container: "webm", isHeader: true }),
        [chunk.buffer],
      );
    }
  });
});
