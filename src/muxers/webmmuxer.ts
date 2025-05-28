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
    const disableAudio = options?.disableAudio ?? false;

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

    const muxerAudioCodec = "A_OPUS"; // only opus supported

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

    const optionsForMuxer: any = {
      target,
      video: {
        codec: muxerVideoCodec,
        width: config.width,
        height: config.height,
        frameRate: config.frameRate,
      },
    };

    if (!disableAudio) {
      optionsForMuxer.audio = {
        codec: muxerAudioCodec,
        numberOfChannels: config.channels,
        sampleRate: config.sampleRate,
      };
    }

    this.muxer = new WebMMuxer(optionsForMuxer);
    this.videoConfigured = true;
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
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data.buffer);
          (chunk as any).close?.();
          adjustedChunk = new EncodedVideoChunk({
            type: chunk.type,
            timestamp: 0,
            duration: chunk.duration ?? undefined,
            data: data.buffer,
          });
        } else {
          const newTimestamp = Math.max(
            0,
            chunk.timestamp - this.firstVideoTimestamp,
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
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data.buffer);
          (chunk as any).close?.();
          adjustedChunk = new EncodedAudioChunk({
            type: chunk.type,
            timestamp: 0,
            duration: chunk.duration ?? undefined,
            data: data.buffer,
          });
        } else {
          const newTimestamp = Math.max(
            0,
            chunk.timestamp - this.firstAudioTimestamp,
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
