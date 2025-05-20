import { Mp4Encoder, Mp4EncoderInitializeOptions } from "./encoder";
import type { EncoderConfig } from "./types";

export class MediaStreamRecorder {
  private encoder: Mp4Encoder;
  private videoReader?: ReadableStreamDefaultReader<VideoFrame>;
  private audioReader?: ReadableStreamDefaultReader<AudioData>;
  private videoTrack?: MediaStreamTrack;
  private audioTrack?: MediaStreamTrack;
  private recording = false;

  constructor(private config: EncoderConfig) {
    this.encoder = new Mp4Encoder(config);
  }

  static isSupported(): boolean {
    return (
      typeof MediaStreamTrackProcessor !== "undefined" &&
      Mp4Encoder.isSupported()
    );
  }

  async startRecording(
    stream: MediaStream,
    options?: Mp4EncoderInitializeOptions,
  ): Promise<void> {
    if (this.recording) {
      throw new Error("MediaStreamRecorder: already recording.");
    }

    await this.encoder.initialize(options ?? {});
    this.recording = true;

    const [vTrack] = stream.getVideoTracks();
    const [aTrack] = stream.getAudioTracks();

    if (vTrack) {
      this.videoTrack = vTrack;
      const processor = new MediaStreamTrackProcessor({
        track: vTrack,
      });
      this.videoReader = processor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;
      this.processVideo();
    }

    if (aTrack) {
      this.audioTrack = aTrack;
      const processor = new MediaStreamTrackProcessor({
        track: aTrack,
      });
      this.audioReader = processor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
      this.processAudio();
    }
  }

  private async processVideo(): Promise<void> {
    if (!this.videoReader) return;
    while (this.recording) {
      const { value, done } = await this.videoReader.read();
      if (done || !value) break;
      await this.encoder.addVideoFrame(value);
      if (typeof value.close === "function") value.close();
    }
  }

  private async processAudio(): Promise<void> {
    if (!this.audioReader) return;
    while (this.recording) {
      const { value, done } = await this.audioReader.read();
      if (done || !value) break;
      await this.encoder.addAudioData(value);
      if (typeof value.close === "function") value.close();
    }
  }

  async stopRecording(): Promise<Uint8Array | null> {
    if (!this.recording) {
      throw new Error("MediaStreamRecorder: not recording.");
    }
    this.recording = false;
    this.videoReader?.cancel();
    this.audioReader?.cancel();
    this.videoTrack?.stop();
    this.audioTrack?.stop();
    return await this.encoder.finalize();
  }

  cancel(): void {
    if (!this.recording) return;
    this.recording = false;
    this.videoReader?.cancel();
    this.audioReader?.cancel();
    this.videoTrack?.stop();
    this.audioTrack?.stop();
    this.encoder.cancel();
  }

  getActualVideoCodec(): string | null {
    return this.encoder.getActualVideoCodec();
  }

  getActualAudioCodec(): string | null {
    return this.encoder.getActualAudioCodec();
  }
}
