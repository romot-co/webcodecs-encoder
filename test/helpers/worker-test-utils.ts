import { vi } from "vitest";
// import * as WorkerModule from "../../src/worker"; // 削除

export const mockMuxerInstanceForWorker = {
  addVideoChunk: vi.fn(),
  addAudioChunk: vi.fn(),
  finalize: vi.fn<() => Uint8Array | null>(() => new Uint8Array([1, 2, 3, 4])),
};

vi.mock("../../src/muxers/mp4muxer", () => ({
  Mp4MuxerWrapper: vi.fn(() => mockMuxerInstanceForWorker),
}));
vi.mock("../../src/muxers/webmmuxer", () => ({
  WebMMuxerWrapper: vi.fn(() => mockMuxerInstanceForWorker),
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
  await import("../../src/worker/encoder-worker");
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
    encodeQueueSize: 0,
  }));
  // @ts-ignore
  mockSelf.VideoEncoder.isConfigSupported = vi.fn(() =>
    Promise.resolve({ supported: true, config: { codec: "avc1.42001f" } }),
  );

  // @ts-ignore
  mockSelf.AudioEncoder = vi.fn(() => ({
    configure: vi.fn(),
    encode: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    state: "unconfigured",
    encodeQueueSize: 0,
  }));
  // @ts-ignore
  mockSelf.AudioEncoder.isConfigSupported = vi.fn(() =>
    Promise.resolve({
      supported: true,
      config: { codec: "mp4a.40.2", numberOfChannels: 2 },
    }),
  );

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

  // AudioDataMock を vi.fn() でラップしてコンストラクタ呼び出しを追跡可能にする
  const AudioDataMock = vi.fn(function (this: any, init: any) {
    Object.assign(this, init);
    // モックインスタンスが close メソッドを持つようにする
    // this.close = vi.fn(); // こちらではなくプロトタイプに設定する
  });
  AudioDataMock.prototype.close = vi.fn(); // close メソッドをプロトタイプにモックとして設定
  globalThis.AudioData = AudioDataMock as any;
}

export function cleanupGlobals() {
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
