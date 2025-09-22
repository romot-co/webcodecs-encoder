import WebMMuxer from "webm-muxer";
import type {
  EncoderConfig,
  MainThreadMessage,
  WorkerDataChunkMessage,
} from "../types";
import { EncoderErrorType } from "../types";

class CallbackWritableStream {
  private position = 0;
  constructor(private onData: (chunk: Uint8Array, position: number) => void) {}

  write({ data, position }: { data: Uint8Array; position: number }): void {
    this.onData(data, position);
    this.position = position + data.byteLength;
  }
}

export class WebMMuxerWrapper {
  private muxer: WebMMuxer;
  private videoConfigured = false;
  private audioConfigured = false;
  private firstAudioTimestamp: number | null = null;
  private firstVideoTimestamp: number | null = null;
  private firstTimestamp: number | null = null;
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
    options?: { disableAudio?: boolean },
  ) {
    this.config = config;
    this.postMessageToMain = postMessageCallback;
    let disableAudio = options?.disableAudio ?? false;

    const videoCodecOption = config.codec?.video ?? "vp9";
    let muxerVideoCodec: string;
    switch (videoCodecOption) {
      case "vp8":
        muxerVideoCodec = "V_VP8";
        break;
      case "vp9":
        muxerVideoCodec = "V_VP9";
        break;
      case "av1":
        muxerVideoCodec = "V_AV1";
        break;
      default:
        muxerVideoCodec = "V_VP9";
        break;
    }

    const requestedAudioCodec = config.codec?.audio ?? "opus";
    let muxerAudioCodec: string | null = null;
    switch (requestedAudioCodec) {
      case "opus":
        muxerAudioCodec = "A_OPUS";
        break;
      case "vorbis":
        muxerAudioCodec = "A_VORBIS";
        break;
      case "flac":
        muxerAudioCodec = "A_FLAC";
        break;
      default:
        if (!disableAudio) {
          console.warn(
            `WebM muxer: Audio codec ${requestedAudioCodec} is not supported. Disabling audio track.`,
          );
          disableAudio = true;
        }
        break;
    }

    const target =
      config.latencyMode === "realtime"
        ? new CallbackWritableStream((chunk, position) => {
            const chunkCopy = new Uint8Array(chunk.slice(0));
            const isHeader = position === 0;
            const message: WorkerDataChunkMessage = {
              type: "dataChunk",
              chunk: chunkCopy,
              offset: position,
              isHeader,
              container: "webm",
            };
            this.postMessageToMain(message, [chunkCopy.buffer]);
          })
        : ("buffer" as const);

    // Check if video is disabled (audio-only encoding)
    const videoDisabled =
      config.width === 0 || config.height === 0 || config.videoBitrate === 0;

    const optionsForMuxer: any = {
      target,
    };

    // Only add video configuration if video is enabled
    if (!videoDisabled) {
      optionsForMuxer.video = {
        codec: muxerVideoCodec,
        width: config.width,
        height: config.height,
        frameRate: config.frameRate,
      };
    }

    if (!disableAudio && muxerAudioCodec) {
      optionsForMuxer.audio = {
        codec: muxerAudioCodec,
        numberOfChannels: config.channels,
        sampleRate: config.sampleRate,
      };
    }

    this.muxer = new WebMMuxer(optionsForMuxer);
    this.videoConfigured = !videoDisabled;
    this.audioConfigured = !disableAudio;
  }

  addVideoChunk(
    chunk: EncodedVideoChunk,
    meta?: EncodedVideoChunkMetadata,
  ): void {
    if (!this.videoConfigured) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: "WebM: Video track not configured.",
          type: EncoderErrorType.ConfigurationError,
        },
      });
      return;
    }
    try {
      let adjustedChunk = chunk;
      const adjustedMeta = meta as any;

      if (
        this.config.firstTimestampBehavior === "offset" &&
        typeof chunk.timestamp === "number"
      ) {
        if (this.firstVideoTimestamp === null) {
          this.firstVideoTimestamp = chunk.timestamp;
          // Update shared firstTimestamp if not set
          if (this.firstTimestamp === null) {
            this.firstTimestamp = chunk.timestamp;
          } else {
            // Use the minimum of audio and video timestamps
            this.firstTimestamp = Math.min(
              this.firstTimestamp,
              chunk.timestamp,
            );
          }
        }

        // Always use the shared firstTimestamp for offset calculation
        const newTimestamp = Math.max(
          0,
          chunk.timestamp - (this.firstTimestamp || 0),
        );

        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data.buffer);
        (chunk as any).close?.();
        adjustedChunk = new EncodedVideoChunk({
          type: chunk.type,
          timestamp: newTimestamp,
          duration: chunk.duration ?? undefined,
          data: data.buffer,
        });
      }

      this.muxer.addVideoChunk(adjustedChunk, adjustedMeta);
    } catch (e: any) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: `WebM: Error adding video chunk: ${e.message}`,
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
    if (!this.audioConfigured) return;
    try {
      let adjustedChunk = chunk;
      const adjustedMeta = meta as any;

      if (
        this.config.firstTimestampBehavior === "offset" &&
        typeof chunk.timestamp === "number"
      ) {
        if (this.firstAudioTimestamp === null) {
          this.firstAudioTimestamp = chunk.timestamp;
          // Update shared firstTimestamp if not set
          if (this.firstTimestamp === null) {
            this.firstTimestamp = chunk.timestamp;
          } else {
            // Use the minimum of audio and video timestamps
            this.firstTimestamp = Math.min(
              this.firstTimestamp,
              chunk.timestamp,
            );
          }
        }

        // Always use the shared firstTimestamp for offset calculation
        const newTimestamp = Math.max(
          0,
          chunk.timestamp - (this.firstTimestamp || 0),
        );

        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data.buffer);
        (chunk as any).close?.();
        adjustedChunk = new EncodedAudioChunk({
          type: chunk.type,
          timestamp: newTimestamp,
          duration: chunk.duration ?? undefined,
          data: data.buffer,
        });
      }
      this.muxer.addAudioChunk(adjustedChunk, adjustedMeta);
    } catch (e: any) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: `WebM: Error adding audio chunk: ${e.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: e.stack,
        },
      });
    }
  }

  finalize(): Uint8Array | null {
    if (this.config.latencyMode === "realtime") {
      try {
        this.muxer.finalize();
      } catch (e: any) {
        this.postMessageToMain({
          type: "error",
          errorDetail: {
            message: `WebM: Error finalizing muxer (realtime): ${e.message}`,
            type: EncoderErrorType.MuxingFailed,
            stack: e.stack,
          },
        });
      }
      return null;
    }

    try {
      const buffer = this.muxer.finalize();
      if (buffer) return new Uint8Array(buffer);
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: "WebM: Muxer finalized without output in non-realtime mode.",
          type: EncoderErrorType.MuxingFailed,
        },
      });
      return null;
    } catch (e: any) {
      this.postMessageToMain({
        type: "error",
        errorDetail: {
          message: `WebM: Error finalizing muxer (non-realtime): ${e.message}`,
          type: EncoderErrorType.MuxingFailed,
          stack: e.stack,
        },
      });
      return null;
    }
  }
}
