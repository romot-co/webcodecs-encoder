import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { EncoderConfig } from './types';

// MuxerOptions がエクスポートされていないため、ConstructorParameters を使用して型を推論し、
// fastStart プロパティを明示的に追加します。
type BaseOptions = ConstructorParameters<typeof Muxer<ArrayBufferTarget>>[0];
type InferredMuxerOptions = BaseOptions & {
  fastStart?: false | 'in-memory' | 'fragmented' | { expectedVideoChunks?: number, expectedAudioChunks?: number };
};

/**
 * A wrapper around the mp4-muxer library to simplify its usage
 * within the WebCodecs MP4 Encoder.
 */
export class Mp4MuxerWrapper {
  private muxer: Muxer<ArrayBufferTarget>;
  private target: ArrayBufferTarget;
  private videoConfigured: boolean = false;
  private audioConfigured: boolean = false;

  constructor(config: EncoderConfig) {
    this.target = new ArrayBufferTarget();

    const videoCodecOption = config.codec?.video ?? 'avc';
    // mp4-muxer expects 'avc' for H.264. Other video codecs might need mapping if supported in future.
    const muxerVideoCodec = videoCodecOption === 'avc' ? 'avc' : videoCodecOption;

    const audioCodecOption = config.codec?.audio ?? 'aac';
    // mp4-muxer directly supports 'aac' and 'opus'.
    const muxerAudioCodec = audioCodecOption;

    const muxerOptions: InferredMuxerOptions = {
      target: this.target,
      video: {
        codec: muxerVideoCodec as 'avc' | 'hevc' | 'vp9' | 'av1', // Cast as mp4-muxer expects specific strings
        width: config.width,
        height: config.height,
      },
      audio: {
        codec: muxerAudioCodec as 'aac' | 'opus',
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
      },
      fastStart: 'in-memory',
    };

    this.muxer = new Muxer(muxerOptions);
    this.videoConfigured = true;
    this.audioConfigured = true;
  }

  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    if (!this.videoConfigured) {
      console.warn('Video track not configured for muxer. Skipping addVideoChunk.');
      return;
    }
    this.muxer.addVideoChunk(chunk, meta);
  }

  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void {
    if (!this.audioConfigured) {
      console.warn('Audio track not configured for muxer. Skipping addAudioChunk.');
      return;
    }
    this.muxer.addAudioChunk(chunk, meta);
  }

  finalize(): Uint8Array {
    this.muxer.finalize();
    const buffer = this.target.buffer;
    // It's good practice to create a new target if the muxer were to be reused,
    // or to help with GC, though Mp4Muxer instances are typically for a single session.
    this.target = new ArrayBufferTarget();
    return new Uint8Array(buffer);
  }
}
