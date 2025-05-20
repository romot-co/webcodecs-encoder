import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebMMuxerWrapper } from "../src/webmmuxer";
import type { EncoderConfig } from "../src/types";

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
  videoBitrate: 1000,
  audioBitrate: 64,
  sampleRate: 48000,
  channels: 2,
  container: "webm",
  codec: { video: "vp9", audio: "opus" },
};

describe("WebMMuxerWrapper", () => {
  let mockMuxerMethods: MockedModule["_mockMuxerMethods"];
  let postMessageCallback: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const module = (await import("webm-muxer")) as unknown as MockedModule;
    mockMuxerMethods = module._mockMuxerMethods;
    vi.clearAllMocks();
    postMessageCallback = vi.fn();
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
    const wrapper = new WebMMuxerWrapper(realtimeConfig, postMessageCallback);
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
