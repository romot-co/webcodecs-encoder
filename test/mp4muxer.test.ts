import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mp4MuxerWrapper } from '../src/mp4muxer';
import type { EncoderConfig } from '../src/types';

var muxerMethods: any;
var MuxerMock: any;
var ArrayBufferTargetMock: any;

vi.mock('mp4-muxer', () => {
  muxerMethods = {
    addVideoChunk: vi.fn(),
    addAudioChunk: vi.fn(),
    finalize: vi.fn(),
  };
  MuxerMock = vi.fn(() => muxerMethods);
  ArrayBufferTargetMock = vi.fn(function() { this.buffer = new ArrayBuffer(4); });
  return { Muxer: MuxerMock, ArrayBufferTarget: ArrayBufferTargetMock };
});

const config: EncoderConfig = {
  width: 320,
  height: 240,
  frameRate: 30,
  videoBitrate: 1000,
  audioBitrate: 64,
  sampleRate: 48000,
  channels: 2,
};

describe('Mp4MuxerWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds video chunks', () => {
    const wrapper = new Mp4MuxerWrapper(config);
    const chunk = {} as EncodedVideoChunk;
    const meta = {} as EncodedVideoChunkMetadata;
    wrapper.addVideoChunk(chunk, meta);
    expect(muxerMethods.addVideoChunk).toHaveBeenCalledWith(chunk, meta);
  });

  it('adds audio chunks', () => {
    const wrapper = new Mp4MuxerWrapper(config);
    const chunk = {} as EncodedAudioChunk;
    const meta = {} as EncodedAudioChunkMetadata;
    wrapper.addAudioChunk(chunk, meta);
    expect(muxerMethods.addAudioChunk).toHaveBeenCalledWith(chunk, meta);
  });

  it('finalizes and returns Uint8Array', () => {
    const wrapper = new Mp4MuxerWrapper(config);
    const output = wrapper.finalize();
    expect(muxerMethods.finalize).toHaveBeenCalled();
    expect(output).toBeInstanceOf(Uint8Array);
  });
});
