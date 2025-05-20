import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import type { EncoderConfig } from "../src/types";
import { MediaStreamRecorder } from "../src/mediastream-recorder";
import { Mp4Encoder } from "../src/encoder";

let encoderInstance: any;

vi.mock("../src/encoder", () => {
  const MockMp4Encoder = vi.fn(() => {
    encoderInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      addVideoFrame: vi.fn().mockResolvedValue(undefined),
      addAudioData: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      cancel: vi.fn(),
      getActualVideoCodec: vi.fn().mockReturnValue("mock-video-codec"),
      getActualAudioCodec: vi.fn().mockReturnValue("mock-audio-codec"),
    };
    return encoderInstance;
  });
  (MockMp4Encoder as any).isSupported = vi.fn(() => true);
  return { Mp4Encoder: MockMp4Encoder };
});

// @ts-ignore - Ignoring VideoFrame/AudioData type complexity for mock values
class FakeVideoReader {
  read = vi
    .fn()
    .mockResolvedValueOnce({
      value: { close: vi.fn() } as unknown as VideoFrame,
      done: false as const,
    }) // 1. Valid frame
    .mockResolvedValueOnce({
      value: { close: vi.fn() } as unknown as VideoFrame,
      done: false as const,
    })
    .mockResolvedValue({ value: undefined, done: true as const }); // 3. Done
  cancel = vi.fn().mockResolvedValue(undefined);
  releaseLock = vi.fn();
  get closed() {
    return Promise.resolve();
  }
}

// @ts-ignore
class FakeAudioReader {
  read = vi
    .fn()
    .mockResolvedValueOnce({
      value: { close: vi.fn() } as unknown as AudioData,
      done: false as const,
    }) // 1. Valid data
    .mockResolvedValueOnce({
      value: { close: vi.fn() } as unknown as AudioData,
      done: false as const,
    })
    .mockResolvedValue({ value: undefined, done: true as const }); // 3. Done
  cancel = vi.fn().mockResolvedValue(undefined);
  releaseLock = vi.fn();
  get closed() {
    return Promise.resolve();
  }
}

interface MockReadableStreamDefaultReader<T> {
  read: () => Promise<ReadableStreamReadResult<T>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
  readonly closed: Promise<void>;
}

class FakeProcessor<T extends VideoFrame | AudioData> {
  readable: { getReader: () => MockReadableStreamDefaultReader<T> };
  constructor(init: { track: MediaStreamTrack }) {
    if (init.track.kind === "video") {
      this.readable = {
        getReader: () =>
          new FakeVideoReader() as unknown as MockReadableStreamDefaultReader<T>,
      };
    } else {
      this.readable = {
        getReader: () =>
          new FakeAudioReader() as unknown as MockReadableStreamDefaultReader<T>,
      };
    }
  }
}

declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }
  // @ts-ignore - Using a simplified mock type for MediaStreamTrackProcessor readable
  interface MediaStreamTrackProcessor<
    T extends VideoFrame | AudioData = VideoFrame | AudioData,
  > {
    readonly readable: { getReader(): MockReadableStreamDefaultReader<T> };
  }
  // @ts-ignore - Using a simplified mock type for MediaStreamTrackProcessor constructor
  let MediaStreamTrackProcessor: {
    new <T extends VideoFrame | AudioData>(
      init: MediaStreamTrackProcessorInit,
    ): MediaStreamTrackProcessor<T>;
  };
}

vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor as any);

describe("MediaStreamRecorder", () => {
  const config: EncoderConfig = {
    width: 320,
    height: 240,
    frameRate: 30,
    videoBitrate: 1,
    audioBitrate: 1,
    sampleRate: 48000,
    channels: 2,
  };
  let mediaStream: MediaStream;
  let videoTrack: any;
  let audioTrack: any;
  let originalMediaStreamTrackProcessor: any;

  beforeEach(() => {
    vi.clearAllMocks();
    (Mp4Encoder as any).isSupported.mockReturnValue(true);
    originalMediaStreamTrackProcessor = (globalThis as any)
      .MediaStreamTrackProcessor;
    (globalThis as any).MediaStreamTrackProcessor = FakeProcessor;
    videoTrack = { kind: "video", stop: vi.fn() } as any;
    audioTrack = { kind: "audio", stop: vi.fn() } as any;
    mediaStream = {
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    } as any;
  });

  afterEach(() => {
    (globalThis as any).MediaStreamTrackProcessor =
      originalMediaStreamTrackProcessor;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe("isSupported", () => {
    it("should return true if MediaStreamTrackProcessor and Mp4Encoder are supported", () => {
      expect(MediaStreamRecorder.isSupported()).toBe(true);
    });
    it("should return false if MediaStreamTrackProcessor is not defined", () => {
      (globalThis as any).MediaStreamTrackProcessor = undefined;
      expect(MediaStreamRecorder.isSupported()).toBe(false);
    });
    it("should return false if Mp4Encoder.isSupported() returns false", () => {
      (Mp4Encoder as any).isSupported.mockReturnValue(false);
      expect(MediaStreamRecorder.isSupported()).toBe(false);
    });
  });

  it("records frames and finalizes", async () => {
    const recorder = new MediaStreamRecorder(config);
    await recorder.startRecording(mediaStream);
    await Promise.resolve();
    expect(Mp4Encoder).toHaveBeenCalledWith(config);
    expect(encoderInstance.initialize).toHaveBeenCalled();
    expect(encoderInstance.addVideoFrame).toHaveBeenCalled();
    expect(encoderInstance.addAudioData).toHaveBeenCalled();
    const data = await recorder.stopRecording();
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(encoderInstance.finalize).toHaveBeenCalled();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  it("should throw if startRecording is called while already recording", async () => {
    const recorder = new MediaStreamRecorder(config);
    await recorder.startRecording(mediaStream);
    await expect(recorder.startRecording(mediaStream)).rejects.toThrow(
      "MediaStreamRecorder: already recording.",
    );
  });

  it("should throw if stopRecording is called when not recording", async () => {
    const recorder = new MediaStreamRecorder(config);
    await expect(recorder.stopRecording()).rejects.toThrow(
      "MediaStreamRecorder: not recording.",
    );
  });

  describe("cancel", () => {
    it("should do nothing if not recording", () => {
      const recorder = new MediaStreamRecorder(config);
      recorder.cancel();
      expect(encoderInstance.cancel).not.toHaveBeenCalled();
    });

    it("should cancel recording and encoder if recording", async () => {
      const recorder = new MediaStreamRecorder(config);
      await recorder.startRecording(mediaStream);
      const fakeVideoReaderInstance = new FakeVideoReader();
      const fakeAudioReaderInstance = new FakeAudioReader();
      // @ts-ignore
      recorder.videoReader = fakeVideoReaderInstance;
      // @ts-ignore
      recorder.audioReader = fakeAudioReaderInstance;

      recorder.cancel();
      expect(fakeVideoReaderInstance.cancel).toHaveBeenCalled();
      expect(fakeAudioReaderInstance.cancel).toHaveBeenCalled();
      expect(videoTrack.stop).toHaveBeenCalled();
      expect(audioTrack.stop).toHaveBeenCalled();
      expect(encoderInstance.cancel).toHaveBeenCalled();
      // @ts-ignore - check private property
      expect(recorder.recording).toBe(false);
    });
  });

  it("getActualVideoCodec should return codec from encoder", () => {
    const recorder = new MediaStreamRecorder(config);
    expect(recorder.getActualVideoCodec()).toBe("mock-video-codec");
    expect(encoderInstance.getActualVideoCodec).toHaveBeenCalled();
  });

  it("getActualAudioCodec should return codec from encoder", () => {
    const recorder = new MediaStreamRecorder(config);
    expect(recorder.getActualAudioCodec()).toBe("mock-audio-codec");
    expect(encoderInstance.getActualAudioCodec).toHaveBeenCalled();
  });

  it("automatically stops when tracks end", async () => {
    const recorder = new MediaStreamRecorder(config);
    await recorder.startRecording(mediaStream);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(encoderInstance.finalize).toHaveBeenCalled();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
    // @ts-ignore - check private property
    expect(recorder.recording).toBe(false);
  });

  it("propagates errors via onError and cancels", async () => {
    const error = new Error("encode fail");
    const onError = vi.fn();

    const recorder = new MediaStreamRecorder(config);
    encoderInstance.addVideoFrame.mockRejectedValueOnce(error);
    await recorder.startRecording(mediaStream, { onError });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
    expect(encoderInstance.cancel).toHaveBeenCalled();
    // @ts-ignore - check private property
    expect(recorder.recording).toBe(false);
  });
});
