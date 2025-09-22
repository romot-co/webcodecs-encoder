import { vi } from "vitest";
// import * as WorkerModule from "../../src/worker"; // Removed

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

const workerEventListeners = new Map<string, Set<EventListener>>();

function storeEventListener(type: string, handler: EventListener) {
  if (!workerEventListeners.has(type)) {
    workerEventListeners.set(type, new Set());
  }
  workerEventListeners.get(type)!.add(handler);
}

function removeStoredEventListener(type: string, handler: EventListener) {
  workerEventListeners.get(type)?.delete(handler);
  if (workerEventListeners.get(type)?.size === 0) {
    workerEventListeners.delete(type);
  }
}

export function getWorkerEventListeners(type: string): EventListener[] {
  return Array.from(workerEventListeners.get(type) ?? []);
}

export async function importWorker() {
  await import("../../src/worker/encoder-worker");
}

export function setupGlobals() {
  global.self = mockSelf;

  workerEventListeners.clear();

  mockSelf.addEventListener = vi.fn((type: string, handler: EventListener) => {
    storeEventListener(type, handler);
  });
  mockSelf.removeEventListener = vi.fn(
    (type: string, handler: EventListener) => {
      removeStoredEventListener(type, handler);
    },
  );
  mockSelf.dispatchEvent = vi.fn((event: Event) => {
    const listeners = getWorkerEventListeners(event.type);
    listeners.forEach((listener) => listener(event));
    return true;
  });

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
  mockSelf.AudioEncoder.isConfigSupported = vi.fn((cfg: any) =>
    Promise.resolve({
      supported: true,
      config: { ...cfg },
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

  // Wrap AudioDataMock with vi.fn() to make constructor calls trackable
  const AudioDataMock = vi.fn(function (this: any, init: any) {
    Object.assign(this, init);
    // Make mock instance have close method
    // this.close = vi.fn(); // Set on prototype instead of here
  });
  AudioDataMock.prototype.close = vi.fn(); // Set close method as mock on prototype
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
  mockSelf.addEventListener?.mockClear?.();
  mockSelf.removeEventListener?.mockClear?.();
  mockSelf.dispatchEvent?.mockClear?.();
  mockMuxerInstanceForWorker.addVideoChunk.mockClear();
  mockMuxerInstanceForWorker.addAudioChunk.mockClear();
  mockMuxerInstanceForWorker.finalize.mockClear();
}
