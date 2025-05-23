import { WebCodecsEncoder, WebCodecsEncoderInitializeOptions } from "./encoder";
import type { EncoderConfig } from "./types";

export class MediaStreamRecorder {
  private encoder: WebCodecsEncoder;
  private videoReader?: ReadableStreamDefaultReader<VideoFrame>;
  private audioReader?: ReadableStreamDefaultReader<AudioData>;
  private videoTrack?: MediaStreamTrack;
  private audioTrack?: MediaStreamTrack;
  private audioSource?: MediaStreamAudioSourceNode;
  private recording = false;
  private onErrorCallback?: (error: any) => void;

  constructor(
    private config: EncoderConfig & {
      firstTimestampBehavior?: "offset" | "strict";
    },
  ) {
    this.encoder = new WebCodecsEncoder(config);
  }

  static isSupported(): boolean {
    return (
      typeof MediaStreamTrackProcessor !== "undefined" &&
      WebCodecsEncoder.isSupported()
    );
  }

  async startRecording(
    stream: MediaStream,
    options?: WebCodecsEncoderInitializeOptions,
  ): Promise<void> {
    if (this.recording) {
      throw new Error("MediaStreamRecorder: already recording.");
    }

    this.onErrorCallback = options?.onError;
    const initializeOptions = {
      ...(this.config.firstTimestampBehavior && {
        firstTimestampBehavior: this.config.firstTimestampBehavior,
      }),
      ...(options ?? {}),
    };
    await this.encoder.initialize(initializeOptions);
    this.recording = true;

    const [vTrack] = stream.getVideoTracks();
    const [aTrack] = stream.getAudioTracks();

    if (vTrack) {
      this.videoTrack = vTrack;
      const processor = new MediaStreamTrackProcessor({
        track: vTrack,
      });
      this.videoReader =
        processor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;
      this.processVideo();
    }

    if (aTrack) {
      this.audioTrack = aTrack;
      if (options?.useAudioWorklet) {
        const node = this.encoder.getAudioWorkletNode();
        if (!node) {
          throw new Error(
            "MediaStreamRecorder: AudioWorkletNode not available from encoder.",
          );
        }
        const ctx = node.context as AudioContext;
        this.audioSource = ctx.createMediaStreamSource(stream);
        this.audioSource.connect(node);
      } else {
        const processor = new MediaStreamTrackProcessor({
          track: aTrack,
        });
        this.audioReader =
          processor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
        this.processAudio();
      }
    }
  }

  private async processVideo(): Promise<void> {
    if (!this.videoReader) return;
    const reader = this.videoReader;
    try {
      while (this.recording) {
        const { value, done } = await reader.read();
        if (done || !value) {
          if (this.recording) {
            await this.stopRecording();
          }
          break;
        }
        try {
          await this.encoder.addVideoFrame(value);
        } finally {
          value.close();
        }
      }
    } catch (err) {
      this.cancel();
      if (this.onErrorCallback) {
        this.onErrorCallback(err);
      } else {
        throw err;
      }
    } finally {
      reader.cancel();
      this.videoReader = undefined;
    }
  }

  private async processAudio(): Promise<void> {
    if (!this.audioReader) return;
    const reader = this.audioReader;
    try {
      while (this.recording) {
        const { value, done } = await reader.read();
        if (done || !value) {
          if (this.recording) {
            await this.stopRecording();
          }
          break;
        }
        try {
          await this.encoder.addAudioData(value);
        } finally {
          value.close();
        }
      }
    } catch (err) {
      this.cancel();
      if (this.onErrorCallback) {
        this.onErrorCallback(err);
      } else {
        throw err;
      }
    } finally {
      reader.cancel();
      this.audioReader = undefined;
    }
  }

  async stopRecording(): Promise<Uint8Array | null> {
    if (!this.recording) {
      throw new Error("MediaStreamRecorder: not recording.");
    }
    this.recording = false;
    this.videoReader?.cancel();
    this.audioReader?.cancel();
    this.audioSource?.disconnect();
    this.videoTrack?.stop();
    this.audioTrack?.stop();
    this.videoReader = undefined;
    this.audioReader = undefined;
    this.audioSource = undefined;
    this.videoTrack = undefined;
    this.audioTrack = undefined;
    return await this.encoder.finalize();
  }

  cancel(): void {
    if (!this.recording) return;
    this.recording = false;
    this.videoReader?.cancel();
    this.audioReader?.cancel();
    this.audioSource?.disconnect();
    this.videoTrack?.stop();
    this.audioTrack?.stop();
    this.videoReader = undefined;
    this.audioReader = undefined;
    this.audioSource = undefined;
    this.videoTrack = undefined;
    this.audioTrack = undefined;
    this.encoder.cancel();
  }

  getActualVideoCodec(): string | null {
    return this.encoder.getActualVideoCodec();
  }

  getActualAudioCodec(): string | null {
    return this.encoder.getActualAudioCodec();
  }
}
