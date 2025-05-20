import { vi } from "vitest";

export const mockMuxerInstanceForWorker = {
  addVideoChunk: vi.fn(),
  addAudioChunk: vi.fn(),
  finalize: vi.fn<() => Uint8Array | null>(() => new Uint8Array([1, 2, 3, 4])),
};

vi.mock("../../src/mp4muxer", () => ({
  Mp4MuxerWrapper: vi.fn(() => mockMuxerInstanceForWorker),
}));

export const mockSelf = {
  postMessage: vi.fn(),
  VideoEncoder: {
    isConfigSupported: vi.fn(() => Promise.resolve(true)),
  },
  AudioEncoder: {
    isConfigSupported: vi.fn(() => Promise.resolve(true)),
  },
} as any;

export async function importWorker() {
  await import("../../src/worker");
}

export function setupGlobals() {
  global.self = mockSelf;

  // @ts-ignore
  mockSelf.VideoEncoder = vi.fn(() => ({
    configure: vi.fn(),
    encode: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    state: "unconfigured",
  }));
  // @ts-ignore
  mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
    Promise.resolve({ supported: true, config: { codec: "avc1.42001f" } }),
  );
  globalThis.VideoEncoder = mockSelf.VideoEncoder;

  // @ts-ignore
  mockSelf.AudioEncoder = vi.fn(() => ({
    configure: vi.fn(),
    encode: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    state: "unconfigured",
  }));
  // @ts-ignore
  mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
    Promise.resolve({ supported: true, config: { codec: "mp4a.40.2" } }),
  );
  globalThis.AudioEncoder = mockSelf.AudioEncoder;

  if (typeof globalThis.VideoFrame === "undefined") {
    globalThis.VideoFrame = class VideoFrameMock {
      source: any;
      constructor(source: any, init: any) {
        Object.assign(this, init);
        this.source = source;
      }
      close() {}
    } as any;
  }
  if (typeof globalThis.AudioData === "undefined") {
    globalThis.AudioData = class AudioDataMock {
      constructor(init: any) {
        Object.assign(this, init);
      }
      close() {}
    } as any;
  }
}

export function cleanupGlobals() {
  delete (globalThis as any).VideoEncoder;
  delete (globalThis as any).AudioEncoder;
  if ((globalThis as any).VideoFrame?.name === "VideoFrameMock")
    delete (globalThis as any).VideoFrame;
  if ((globalThis as any).AudioData?.name === "AudioDataMock")
    delete (globalThis as any).AudioData;
}

export function resetMocks() {
  mockSelf.postMessage.mockClear();
  mockMuxerInstanceForWorker.addVideoChunk.mockClear();
  mockMuxerInstanceForWorker.addAudioChunk.mockClear();
  mockMuxerInstanceForWorker.finalize.mockClear();
}
