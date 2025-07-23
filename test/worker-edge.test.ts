import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
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

describe("worker self.onmessage error handling and cancellation edge cases", () => {
  it("should ignore addVideoFrame if worker is cancelled", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    await global.self.onmessage({ data: { type: "initialize", config } } as MessageEvent);
    await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent);
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
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    await global.self.onmessage({ data: { type: "initialize", config } } as MessageEvent);
    await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent);
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

  it("should handle unknown message type with a warning", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    await global.self.onmessage({ data: { type: "initialize", config } } as MessageEvent);
    mockSelf.postMessage.mockClear();
    
    // Create mock console.warn to spy on it
    const originalConsoleWarn = console.warn;
    console.warn = vi.fn();
    
    try {
      // Send non-existent message type
      await global.self.onmessage({ data: { type: "unknownMessageType" } } as any);
      
      // Verify warning was output
      expect(console.warn).toHaveBeenCalledWith(
        "Worker received unknown message type:",
        "unknownMessageType"
      );
      
      // Verify postMessage is not called
      expect(mockSelf.postMessage).not.toHaveBeenCalled();
    } finally {
      // Clean up mock
      console.warn = originalConsoleWarn;
    }
  });

  it("should still process initialize even if isCancelled was somehow true before it", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    await global.self.onmessage({ data: { type: "initialize", config } } as MessageEvent);
    mockSelf.postMessage.mockClear();
    await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent);
    mockSelf.postMessage.mockClear();

    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialized" }),
    );
  });

  it("should still process cancel even if isCancelled was already true", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    await global.self.onmessage({ data: { type: "initialize", config } } as MessageEvent);
    mockSelf.postMessage.mockClear();
    await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent);
    expect(mockSelf.postMessage).toHaveBeenCalledWith({ type: "cancelled" });
    mockSelf.postMessage.mockClear();
    await global.self.onmessage({ data: { type: "cancel" } } as MessageEvent);
    expect(mockSelf.postMessage).not.toHaveBeenCalled();
  });

  it("should handle errors within self.onmessage itself (e.g., if a handler throws unexpectedly)", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");

    const onmessageInternalError = new Error("Simulated internal error during init");
    const originalVideoEncoderIsSupported = mockSelf.VideoEncoder.isConfigSupported;
    mockSelf.VideoEncoder.isConfigSupported = vi.fn(() => Promise.reject(onmessageInternalError));
    globalThis.VideoEncoder = mockSelf.VideoEncoder;

    const initMessage: InitializeWorkerMessage = { type: "initialize", config };
    await global.self.onmessage({ data: initMessage } as MessageEvent);

    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        errorDetail: expect.objectContaining({
          message: `Unhandled error in worker onmessage: ${onmessageInternalError.message}`,
          type: "unknown",
          stack: expect.any(String),
        }),
      }),
    );
    mockSelf.VideoEncoder.isConfigSupported = originalVideoEncoderIsSupported;
    globalThis.VideoEncoder = mockSelf.VideoEncoder;
  });

  it("should handle unknown message type", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    
    // Mock console warning
    const originalConsoleWarn = console.warn;
    console.warn = vi.fn();
    
    try {
      // Send unknown type message
      const unknownMessage = { type: "unknownType" } as any;
      await global.self.onmessage({ data: unknownMessage } as MessageEvent);
      
      // Verify warning is output for unknown message type
      expect(console.warn).toHaveBeenCalledWith(
        "Worker received unknown message type:",
        "unknownType"
      );
    } finally {
      // Restore console warning
      console.warn = originalConsoleWarn;
    }
  });
});
