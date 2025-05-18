import { describe, it, expect, vi, beforeEach } from "vitest";
import { Mp4MuxerWrapper } from "../src/mp4muxer";
import type { EncoderConfig } from "../src/types";

// `vi.mock` はファイルのトップに巻き上げられます。
// モックしたい対象のモック実装をファクトリ関数内で定義します。
vi.mock("mp4-muxer", () => {
  const mockMuxerMethodsInFactory = {
    addVideoChunk: vi.fn(),
    addAudioChunk: vi.fn(),
    finalize: vi.fn(() => new Uint8Array(4).buffer), // finalizeがArrayBufferを返すように
  };

  const MuxerMockInFactory = vi.fn(() => mockMuxerMethodsInFactory);
  const ArrayBufferTargetMockInFactory = vi.fn(function (this: {
    buffer: ArrayBuffer;
  }) {
    this.buffer = new ArrayBuffer(1024);
  });

  return {
    Muxer: MuxerMockInFactory,
    ArrayBufferTarget: ArrayBufferTargetMockInFactory,
    // テストケースからこれらのメソッドスパイにアクセスできるように、
    // モックされたモジュールの一部としてエクスポートするテクニックです。
    _mockMuxerMethods: mockMuxerMethodsInFactory,
  };
});

// vi.mock のファクトリ関数の戻り値の型を反映するインターフェース
interface MockedMp4Muxer {
  Muxer: ReturnType<typeof vi.fn>;
  ArrayBufferTarget: ReturnType<typeof vi.fn>;
  _mockMuxerMethods: {
    addVideoChunk: ReturnType<typeof vi.fn>;
    addAudioChunk: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
  };
}

const config: EncoderConfig = {
  width: 320,
  height: 240,
  frameRate: 30,
  videoBitrate: 1000,
  audioBitrate: 64,
  sampleRate: 48000,
  channels: 2,
};

describe("Mp4MuxerWrapper", () => {
  // この describe ブロック内で使用する mockMuxerMethods の型を定義
  let mockMuxerMethods: {
    addVideoChunk: ReturnType<typeof vi.fn>;
    addAudioChunk: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    // `vi.mock` でモックされたモジュールを動的にインポートして、
    // ファクトリ関数内で定義されたスパイを取得します。
    const mp4MuxerModule = await import("mp4-muxer");
    // mp4MuxerModule を unknown 経由で定義した型にキャストします
    mockMuxerMethods = (mp4MuxerModule as unknown as MockedMp4Muxer)._mockMuxerMethods;

    // すべてのモック呼び出し履歴等をクリア
    vi.clearAllMocks(); // これは MuxerMockInFactory や ArrayBufferTargetMockInFactory の呼び出し回数をクリアします

    // メソッドスパイ自体も個別にクリアします
    mockMuxerMethods.addVideoChunk.mockClear();
    mockMuxerMethods.addAudioChunk.mockClear();
    mockMuxerMethods.finalize.mockClear();
  });

  it("adds video chunks", () => {
    const wrapper = new Mp4MuxerWrapper(config, () => {});
    const chunk = {} as EncodedVideoChunk;
    const meta = {} as EncodedVideoChunkMetadata;
    wrapper.addVideoChunk(chunk, meta);
    expect(mockMuxerMethods.addVideoChunk).toHaveBeenCalledWith(chunk, meta);
  });

  it("adds audio chunks", () => {
    const wrapper = new Mp4MuxerWrapper(config, () => {});
    const chunk = {} as EncodedAudioChunk;
    const meta = {} as EncodedAudioChunkMetadata;
    wrapper.addAudioChunk(chunk, meta);
    expect(mockMuxerMethods.addAudioChunk).toHaveBeenCalledWith(chunk, meta);
  });

  it("finalizes and returns Uint8Array", () => {
    const wrapper = new Mp4MuxerWrapper(config, () => {});
    const output = wrapper.finalize();
    expect(mockMuxerMethods.finalize).toHaveBeenCalled();
    expect(output).toBeInstanceOf(Uint8Array);
    expect(output?.buffer.byteLength).toBeGreaterThan(0);
  });
});
