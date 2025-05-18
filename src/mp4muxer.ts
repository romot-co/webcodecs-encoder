import { Muxer, ArrayBufferTarget, StreamTarget } from "mp4-muxer";
import type {
  EncoderConfig,
  MainThreadMessage,
  WorkerDataChunkMessage,
} from "./types";
import { EncoderErrorType } from "./types";

// MuxerOptions がエクスポートされていないため、ConstructorParameters を使用して型を推論し、
// fastStart プロパティを明示的に追加します。
type BaseOptions = ConstructorParameters<
  typeof Muxer<ArrayBufferTarget | StreamTarget>
>[0];

// Infer the options type for Muxer constructor, which is not directly exported.
// It seems the InferredMuxerOptions might not be perfectly capturing all variations,
// especially with StreamTarget. Forcing a wider type for now.
interface ExtendedMuxerOptions
  extends Omit<BaseOptions, "target" | "video" | "audio"> {
  target: ArrayBufferTarget | StreamTarget;
  video: NonNullable<BaseOptions["video"]>;
  audio: NonNullable<BaseOptions["audio"]>;
  fastStart?:
    | false
    | "in-memory"
    | "fragmented"
    | { expectedVideoChunks?: number; expectedAudioChunks?: number };
  // Add other potential options if needed based on mp4-muxer documentation
}

/**
 * A wrapper around the mp4-muxer library to simplify its usage
 * within the WebCodecs MP4 Encoder.
 */
export class Mp4MuxerWrapper {
  private muxer: Muxer<ArrayBufferTarget | StreamTarget>;
  private target: ArrayBufferTarget | StreamTarget;
  private videoConfigured: boolean = false;
  private audioConfigured: boolean = false;
  private postMessageToMain: (
    message: MainThreadMessage,
    transfer?: Transferable[],
  ) => void;
  private config: EncoderConfig;

  constructor(
    config: EncoderConfig,
    postMessageCallback: (
      message: MainThreadMessage,
      transfer?: Transferable[],
    ) => void,
  ) {
    this.config = config;
    this.postMessageToMain = postMessageCallback;

    const videoCodecOption = config.codec?.video ?? "avc";
    // mp4-muxer expects 'avc' for H.264. Other video codecs might need mapping.
    // VP9 is 'vp09', AV1 is 'av01' in mp4-muxer.
    let muxerVideoCodec: "avc" | "hevc" | "vp9" | "av1";
    switch (videoCodecOption) {
      case "hevc":
        muxerVideoCodec = "hevc";
        break;
      case "vp9":
        muxerVideoCodec = "vp9"; // mp4-muxer uses 'vp09' for codec string, but VideoEncoder uses 'vp9' or 'vp09.xx.xx.xx'
        // Assuming VideoEncoder provides data compatible with 'vp9' in mp4-muxer
        break;
      case "av1":
        muxerVideoCodec = "av1";
        break;
      case "avc":
      default:
        muxerVideoCodec = "avc";
        break;
    }

    const audioCodecOption = config.codec?.audio ?? "aac";
    // mp4-muxer directly supports 'aac' and 'opus'.
    const muxerAudioCodec = audioCodecOption;

    const commonMuxerOptions = {
      video: {
        codec: muxerVideoCodec,
        width: config.width,
        height: config.height,
        // framerate is not directly a muxer option here, but good to have in config
      },
      audio: {
        codec: muxerAudioCodec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.channels,
      },
    };

    if (config.latencyMode === "realtime") {
      this.target = new StreamTarget({
        onData: (chunk: Uint8Array, position: number) => {
          const chunkCopy = new Uint8Array(chunk.slice(0)); // Ensure buffer is not reused by mp4-muxer
          const message: WorkerDataChunkMessage = {
            type: "dataChunk",
            chunk: chunkCopy,
            offset: position, // Use position as offset
            // isHeader cannot be determined from this signature, default to false or undefined
            isHeader: undefined,
            container: "mp4",
          };
          this.postMessageToMain(message, [chunkCopy.buffer]);
        },
      } as any); // Use `as any` to bypass the strict type check for StreamTargetOptions if it's causing issues
      // This is a temporary workaround if the locally available .d.ts for mp4-muxer is problematic.
      // Ideally, the types should align.

      this.muxer = new Muxer({
        target: this.target,
        ...commonMuxerOptions,
        fastStart: "fragmented",
      } as ExtendedMuxerOptions);
    } else {
      this.target = new ArrayBufferTarget();
      this.muxer = new Muxer({
        target: this.target,
        ...commonMuxerOptions,
        fastStart: "in-memory", // or false, depending on desired behavior for non-realtime
      } as ExtendedMuxerOptions);
    }

    this.videoConfigured = true;
    this.audioConfigured = true;
  }

  addVideoChunk(
    chunk: EncodedVideoChunk,
    meta?: EncodedVideoChunkMetadata,
  ): void {
    if (!this.videoConfigured) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: "MP4: Video track not configured.",
          type: EncoderErrorType.ConfigurationError,
        },
      });
      return;
    }
    try {
      this.muxer.addVideoChunk(chunk, meta);
    } catch (e: any) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: `MP4: Error adding video chunk: ${e.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: e.stack,
        },
      });
    }
  }

  addAudioChunk(
    chunk: EncodedAudioChunk,
    meta?: EncodedAudioChunkMetadata,
  ): void {
    if (!this.audioConfigured) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: "MP4: Audio track not configured.",
          type: EncoderErrorType.ConfigurationError,
        },
      });
      return;
    }
    try {
      this.muxer.addAudioChunk(chunk, meta);
    } catch (e: any) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: `MP4: Error adding audio chunk: ${e.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: e.stack,
        },
      });
    }
  }

  finalize(): Uint8Array | null {
    if (this.config.latencyMode === "realtime") {
      // In real-time mode, finalization might just mean flushing any remaining data.
      // The actual 'file' is streamed. mp4-muxer with StreamTarget doesn't produce a single blob at the end.
      // However, mp4-muxer's finalize() still needs to be called to write any pending data like the 'mfra' box.
      try {
        this.muxer.finalize();
      } catch (e: any) {
        this.postMessageToMain({
          type: "error",
          errorDetail: {
            message: `MP4: Error finalizing muxer (realtime): ${e.message}`,
            type: EncoderErrorType.MuxingFailed,
            stack: e.stack,
          },
        });
      }
      return null; // No single file output in this mode
    }

    if (!(this.target instanceof ArrayBufferTarget)) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message:
            "MP4: Muxer target is not ArrayBufferTarget in non-realtime mode.",
          type: EncoderErrorType.InternalError,
        },
      });
      return null;
    }

    try {
      this.muxer.finalize();
      const buffer = this.target.buffer;
      // It's good practice to create a new target if the muxer were to be reused,
      // or to help with GC.
      this.target = new ArrayBufferTarget(); // Reset for potential reuse, though typically not reused.
      return new Uint8Array(buffer);
    } catch (e: any) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: `MP4: Error finalizing muxer (non-realtime): ${e.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: e.stack,
        },
      });
      return null;
    }
  }
}
