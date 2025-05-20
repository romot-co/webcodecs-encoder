import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EncoderConfig,
  InitializeWorkerMessage,
  CancelWorkerMessage,
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

describe("handleAddVideoFrame", () => {
  let initMessage: InitializeWorkerMessage;
  let videoEncoderErrorCallback: ((error: any) => void) | null = null;
  let videoEncoderInstance: any;

  beforeEach(async () => {
    videoEncoderErrorCallback = null;
    mockSelf.VideoEncoder = vi.fn((options: { error: (e: any) => void }) => {
      videoEncoderErrorCallback = options.error;
      videoEncoderInstance = {
        configure: vi.fn(),
        encode: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
        state: "configured",
      };
      return videoEncoderInstance;
    }) as any;
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
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const cancelMessage: CancelWorkerMessage = { type: "cancel" };
    await global.self.onmessage({ data: cancelMessage } as MessageEvent);
    mockSelf.postMessage.mockClear();

    const videoFrame = new globalThis.VideoFrame(new Uint8Array(config.width * config.height * 4), {
      timestamp: 0,
      duration: 33333,
      codedWidth: config.width,
      codedHeight: config.height,
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

  it("should post an error if videoEncoder.encode triggers error callback", async () => {
    if (!global.self.onmessage || !videoEncoderErrorCallback)
      throw new Error("Worker or VideoEncoder error callback not set up");

    const encodeError = new Error("Video encode failed by callback");

    const videoFrame = new globalThis.VideoFrame(new Uint8Array(config.width * config.height * 4), {
      timestamp: 0,
      duration: 33333,
      codedWidth: config.width,
      codedHeight: config.height,
      format: "RGBA",
    });
    const addFrameMessage = {
      type: "addVideoFrame",
      frame: videoFrame,
      timestamp: 0,
    };

    global.self.onmessage({ data: addFrameMessage } as MessageEvent);
    if (videoEncoderErrorCallback) {
      videoEncoderErrorCallback(encodeError);
    }

    expect(mockSelf.postMessage).toHaveBeenCalledWith(
      {
        type: "error",
        errorDetail: {
          message: "VideoEncoder error: Video encode failed by callback",
          type: "video-encoding-error",
          stack: expect.any(String),
        },
      },
      undefined,
    );
  });

  it("should post progress if totalFramesToProcess is set and latencyMode is quality", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const newConfig = { ...config, latencyMode: "quality" as const };
    const newInitMessage: InitializeWorkerMessage = {
      type: "initialize",
      config: newConfig,
      totalFrames: 10,
    };
    await global.self.onmessage({ data: newInitMessage } as MessageEvent);
    mockSelf.postMessage.mockClear();

    const videoFrame = new globalThis.VideoFrame(new Uint8Array(config.width * config.height * 4), {
      timestamp: 0,
      duration: 33333,
      codedWidth: config.width,
      codedHeight: config.height,
      format: "RGBA",
    });
    const addFrameMessage = {
      type: "addVideoFrame",
      frame: videoFrame,
      timestamp: 0,
    };
    await global.self.onmessage({ data: addFrameMessage } as MessageEvent);

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

  it("should pass keyFrame hint based on interval", async () => {
    if (!global.self.onmessage) throw new Error("Worker onmessage handler not set up");
    const cfg = { ...config, keyFrameInterval: 2 };
    const newInit: InitializeWorkerMessage = { type: "initialize", config: cfg };
    await global.self.onmessage({ data: newInit } as MessageEvent);
    videoEncoderInstance.encode.mockClear();

    const createFrame = () =>
      new globalThis.VideoFrame(new Uint8Array(cfg.width * cfg.height * 4), {
        timestamp: 0,
        duration: 33333,
        codedWidth: cfg.width,
        codedHeight: cfg.height,
        format: "RGBA",
      });

    const f1 = createFrame();
    await global.self.onmessage({ data: { type: "addVideoFrame", frame: f1, timestamp: 0 } } as MessageEvent);
    const f2 = createFrame();
    await global.self.onmessage({ data: { type: "addVideoFrame", frame: f2, timestamp: 0 } } as MessageEvent);
    const f3 = createFrame();
    await global.self.onmessage({ data: { type: "addVideoFrame", frame: f3, timestamp: 0 } } as MessageEvent);

    expect(videoEncoderInstance.encode.mock.calls[0][1]).toEqual({ keyFrame: true });
    expect(videoEncoderInstance.encode.mock.calls[1][1]).toBeUndefined();
    expect(videoEncoderInstance.encode.mock.calls[2][1]).toEqual({ keyFrame: true });

    f1.close();
    f2.close();
    f3.close();
  });
});
