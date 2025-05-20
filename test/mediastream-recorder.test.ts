import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EncoderConfig } from "../src/types";
import { MediaStreamRecorder } from "../src/mediastream-recorder";

let encoderInstance: any;
// eslint-disable-next-line no-var
var MockEncoder: any;

vi.mock("../src/encoder", () => {
  MockEncoder = vi.fn(() => {
    encoderInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      addVideoFrame: vi.fn().mockResolvedValue(undefined),
      addAudioData: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      cancel: vi.fn(),
      getActualVideoCodec: vi.fn(),
      getActualAudioCodec: vi.fn(),
    };
    return encoderInstance;
  });
  return { Mp4Encoder: MockEncoder };
});

class FakeVideoReader {
  read = vi
    .fn()
    .mockResolvedValueOnce({ value: { close: vi.fn() }, done: false })
    .mockResolvedValueOnce({ done: true });
  cancel = vi.fn();
}

class FakeAudioReader {
  read = vi
    .fn()
    .mockResolvedValueOnce({ value: { close: vi.fn() }, done: false })
    .mockResolvedValueOnce({ done: true });
  cancel = vi.fn();
}

class FakeProcessor {
  readable: any;
  constructor(opts: { track: MediaStreamTrack }) {
    if (opts.track.kind === "video") {
      this.readable = { getReader: () => new FakeVideoReader() };
    } else {
      this.readable = { getReader: () => new FakeAudioReader() };
    }
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface MediaStreamTrackProcessor<T = any> {
    readable: { getReader(): any };
  }
  // eslint-disable-next-line no-var
  var MediaStreamTrackProcessor: {
    new (opts: { track: MediaStreamTrack }): MediaStreamTrackProcessor<any>;
  };
}

vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor);

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

  beforeEach(() => {
    vi.clearAllMocks();
    videoTrack = { kind: "video", stop: vi.fn() } as any;
    audioTrack = { kind: "audio", stop: vi.fn() } as any;
    mediaStream = {
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    } as any;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records frames and finalizes", async () => {
    const recorder = new MediaStreamRecorder(config);
    await recorder.startRecording(mediaStream);

    await Promise.resolve();

    expect(MockEncoder).toHaveBeenCalledWith(config);
    expect(encoderInstance.initialize).toHaveBeenCalled();
    expect(encoderInstance.addVideoFrame).toHaveBeenCalled();
    expect(encoderInstance.addAudioData).toHaveBeenCalled();

    const data = await recorder.stopRecording();
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(encoderInstance.finalize).toHaveBeenCalled();
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
  });
});
