import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
  FinalizeWorkerMessage,
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
      encodeQueueSize: 0,
    };
    mockAudioEncoderInstance = {
      configure: vi.fn(),
      encode: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      state: "configured",
      encodeQueueSize: 0,
    };

    const veMock = mockSelf.VideoEncoder as ReturnType<typeof vi.fn>;
    if (veMock && veMock.getMockImplementation()) {
      const originalVeImpl = veMock.getMockImplementation();
      veMock.mockImplementation((options?: any) => {
        mockVideoEncoderInstance = originalVeImpl ? originalVeImpl(options) : {};
        Object.assign(mockVideoEncoderInstance, {
          configure: vi.fn(),
          encode: vi.fn(),
          flush: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
          state: "configured",
        });
        return mockVideoEncoderInstance;
      });
    }
    if (typeof mockSelf.VideoEncoder === 'function') mockVideoEncoderInstance = (mockSelf.VideoEncoder as any)();

    const aeMock = mockSelf.AudioEncoder as ReturnType<typeof vi.fn>;
    if (aeMock && aeMock.getMockImplementation()) {
      const originalAeImpl = aeMock.getMockImplementation();
      aeMock.mockImplementation((options?: any) => {
        mockAudioEncoderInstance = originalAeImpl ? originalAeImpl(options) : {};
        Object.assign(mockAudioEncoderInstance, {
          configure: vi.fn(),
          encode: vi.fn(),
          flush: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
          state: "configured",
        });
        return mockAudioEncoderInstance;
      });
    }
    if (typeof mockSelf.AudioEncoder === 'function') mockAudioEncoderInstance = (mockSelf.AudioEncoder as any)();

    const mp4muxerModule = await import("../src/muxers/mp4muxer");
    const currentMp4MuxerWrapperMock = vi.mocked(mp4muxerModule.Mp4MuxerWrapper);
    currentMp4MuxerWrapperMock.mockImplementation(() => mockMuxerInstanceForWorker as any);
    mockMuxerInstanceForWorker.addVideoChunk.mockClear();
    mockMuxerInstanceForWorker.addAudioChunk.mockClear();
    mockMuxerInstanceForWorker.finalize = vi.fn<() => Uint8Array | null>(() => defaultMuxerOutput);

    const currentTestConfig = { ...config, latencyMode: "quality" as const };
    const initMessage: InitializeWorkerMessage = { type: "initialize", config: currentTestConfig };

    if (global.self.onmessage) {
      mockSelf.postMessage.mockClear();
      await global.self.onmessage({ data: initMessage } as MessageEvent);
      const initErrorPost = mockSelf.postMessage.mock.calls.find(
        (callArgs: [any, any]) => callArgs[0].type === "error",
      );
      expect(initErrorPost, "Worker initialization in handleFinalize beforeEach should not post an error").toBeUndefined();
      expect(mockSelf.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "initialized" }),
      );
      mockSelf.postMessage.mockClear();
    } else {
      throw new Error("Worker onmessage handler not set up for handleFinalize tests");
    }
  });

  it("should call flush on encoders and finalize muxer, then post finalized message", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
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
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const muxerConstructionError = new Error("Muxer init failed for test");
    const specificTestMp4MuxerWrapperMock = vi.mocked((await import("../src/muxers/mp4muxer")).Mp4MuxerWrapper);
    specificTestMp4MuxerWrapperMock.mockImplementationOnce(() => {
      throw muxerConstructionError;
    });

    mockSelf.postMessage.mockClear();
    const faultyConfig = { ...config, width: 1 };
    const faultyInitMessage: InitializeWorkerMessage = { type: "initialize", config: faultyConfig };
    await global.self.onmessage({ data: faultyInitMessage } as MessageEvent);

    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        errorDetail: expect.objectContaining({
          message: `Worker: Failed to initialize Muxer: ${muxerConstructionError.message}`,
          type: "initialization-failed",
        }),
      }),
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
    );
    specificTestMp4MuxerWrapperMock.mockImplementation(() => mockMuxerInstanceForWorker as any);
  });

  it("should post error if muxer.finalize returns null in non-realtime mode", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
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
    );
  });

  it("should post finalized with null output if muxer.finalize returns null in realtime mode", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    const realtimeConfig = { ...config, latencyMode: "realtime" as const };
    const initRealtimeMessage: InitializeWorkerMessage = { type: "initialize", config: realtimeConfig };

    const mp4muxerModule = await import("../src/muxers/mp4muxer");
    const currentMp4MuxerWrapperMock = vi.mocked(mp4muxerModule.Mp4MuxerWrapper);
    currentMp4MuxerWrapperMock.mockImplementation(() => mockMuxerInstanceForWorker as any);
    mockMuxerInstanceForWorker.finalize = vi.fn<() => Uint8Array | null>(() => null);

    mockSelf.postMessage.mockClear();
    await global.self.onmessage({ data: initRealtimeMessage } as MessageEvent);
    const initErrorPost = mockSelf.postMessage.mock.calls.find((call: [any, any]) => call[0].type === "error");
    expect(initErrorPost, "Error during realtime re-initialization").toBeUndefined();
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialized" }),
    );
    mockSelf.postMessage.mockClear();

    const finalizeMessage: FinalizeWorkerMessage = { type: "finalize" };
    await global.self.onmessage({ data: finalizeMessage } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      { type: "finalized", output: null },
    );
  });

  it("should handle general error during finalization (e.g. videoEncoder.flush throws)", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
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
    );
  });

  it("should post error if muxer does not exist when attempting to finalize", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    
    // ワーカーをリセットして、muxerを初期化せずに finalize を呼び出す
    vi.resetModules();
    setupGlobals();
    resetMocks();
    await importWorker();
    
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
    );
  });
});
