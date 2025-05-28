import type { EncodeOptions, ProgressInfo } from "./types";
import { EncodeError } from "./types";
import { WorkerCommunicator } from "./worker/worker-communicator";
import { inferAndBuildConfig } from "./utils/config-parser";

export interface MediaStreamRecorderOptions extends EncodeOptions {
  /** 最初のタイムスタンプの処理方法 */
  firstTimestampBehavior?: "offset" | "strict";
}

export class MediaStreamRecorder {
  private communicator: WorkerCommunicator | null = null;
  private videoReader?: ReadableStreamDefaultReader<VideoFrame>;
  private audioReader?: ReadableStreamDefaultReader<AudioData>;
  private videoTrack?: MediaStreamTrack;
  private audioTrack?: MediaStreamTrack;
  private audioSource?: MediaStreamAudioSourceNode;
  private recording = false;
  private onErrorCallback?: (error: EncodeError) => void;
  private onProgressCallback?: (progress: ProgressInfo) => void;
  private config: any = null;
  
  constructor(private options: MediaStreamRecorderOptions = {}) {
    // 新しいAPIでは設定はstartRecording時に決定
  }

  static isSupported(): boolean {
    return (
      typeof MediaStreamTrackProcessor !== "undefined" &&
      typeof VideoEncoder !== "undefined" &&
      typeof AudioEncoder !== "undefined" &&
      typeof Worker !== "undefined"
    );
  }

  async startRecording(
    stream: MediaStream,
    additionalOptions?: Partial<MediaStreamRecorderOptions>,
  ): Promise<void> {
    if (this.recording) {
      throw new EncodeError("invalid-input", "MediaStreamRecorder: already recording.");
    }

    // オプションをマージ
    const mergedOptions = { ...this.options, ...additionalOptions };
    this.onErrorCallback = mergedOptions.onError;
    this.onProgressCallback = mergedOptions.onProgress;

    try {
      // 設定の推定と正規化（MediaStreamベース）
      this.config = await inferAndBuildConfig(stream, mergedOptions);
      
      // ワーカーとの通信を開始
      this.communicator = new WorkerCommunicator();
      
      // ワーカーの初期化
      await this.initializeWorker();
      
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
        const processor = new MediaStreamTrackProcessor({
          track: aTrack,
        });
        this.audioReader =
          processor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
        this.processAudio();
      }
    } catch (error) {
      this.cleanup();
      const encodeError = error instanceof EncodeError 
        ? error 
        : new EncodeError(
            'initialization-failed',
            `Failed to start recording: ${error instanceof Error ? error.message : String(error)}`,
            error
          );
      if (this.onErrorCallback) {
        this.onErrorCallback(encodeError);
      }
      throw encodeError;
    }
  }

  private async initializeWorker(): Promise<void> {
    if (!this.communicator) {
      throw new EncodeError('initialization-failed', 'Worker communicator not available');
    }

    return new Promise<void>((resolve, reject) => {
      if (!this.communicator) {
        reject(new EncodeError('initialization-failed', 'Worker communicator not available'));
        return;
      }

      // ワーカーからのメッセージを処理
      this.communicator.on('initialized', () => {
        resolve();
      });

      this.communicator.on('progress', (data: { processedFrames: number; totalFrames?: number }) => {
        if (this.onProgressCallback) {
          const progressInfo: ProgressInfo = {
            percent: data.totalFrames ? (data.processedFrames / data.totalFrames) * 100 : 0,
            processedFrames: data.processedFrames,
            totalFrames: data.totalFrames,
            fps: 0, // リアルタイムでは計算が複雑
            stage: 'encoding',
          };
          this.onProgressCallback(progressInfo);
        }
      });

      this.communicator.on('error', (data: { errorDetail: any }) => {
        const error = new EncodeError(
          data.errorDetail.type || 'encoding-failed',
          data.errorDetail.message || 'Worker error',
          data.errorDetail
        );
        if (this.onErrorCallback) {
          this.onErrorCallback(error);
        }
        reject(error);
      });

      // ワーカーを初期化
      this.communicator.send('initialize', { config: this.config });
    });
  }

  private async processVideo(): Promise<void> {
    if (!this.videoReader || !this.communicator) return;
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
          // 新しいAPIを使用してフレームを送信
          this.communicator.send('addVideoFrame', {
            frame: value,
            timestamp: value.timestamp || 0
          });
        } finally {
          value.close();
        }
      }
    } catch (err) {
      this.cancel();
      const error = err instanceof EncodeError 
        ? err 
        : new EncodeError(
            'video-encoding-error',
            `Video processing error: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
      if (this.onErrorCallback) {
        this.onErrorCallback(error);
      } else {
        throw error;
      }
    } finally {
      reader.cancel();
      this.videoReader = undefined;
    }
  }

  private async processAudio(): Promise<void> {
    if (!this.audioReader || !this.communicator) return;
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
          // 新しいAPIを使用してオーディオデータを送信
          this.communicator.send('addAudioData', {
            audio: value,
            timestamp: value.timestamp || 0,
            format: "f32",
            sampleRate: value.sampleRate,
            numberOfFrames: value.numberOfFrames,
            numberOfChannels: value.numberOfChannels,
          });
        } finally {
          value.close();
        }
      }
    } catch (err) {
      this.cancel();
      const error = err instanceof EncodeError 
        ? err 
        : new EncodeError(
            'audio-encoding-error',
            `Audio processing error: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
      if (this.onErrorCallback) {
        this.onErrorCallback(error);
      } else {
        throw error;
      }
    } finally {
      reader.cancel();
      this.audioReader = undefined;
    }
  }

  async stopRecording(): Promise<Uint8Array | null> {
    if (!this.recording) {
      throw new EncodeError("invalid-input", "MediaStreamRecorder: not recording.");
    }
    
    this.recording = false;
    this.cleanup();

    if (!this.communicator) {
      return null;
    }

    return new Promise<Uint8Array | null>((resolve, reject) => {
      if (!this.communicator) {
        resolve(null);
        return;
      }

      this.communicator.on('finalized', (data: { output: Uint8Array | null }) => {
        resolve(data.output);
        this.communicator?.terminate();
        this.communicator = null;
      });

      this.communicator.on('error', (data: { errorDetail: any }) => {
        const error = new EncodeError(
          data.errorDetail.type || 'encoding-failed',
          data.errorDetail.message || 'Finalization error',
          data.errorDetail
        );
        reject(error);
        this.communicator?.terminate();
        this.communicator = null;
      });

      this.communicator.send('finalize');
    });
  }

  cancel(): void {
    if (!this.recording) return;
    this.recording = false;
    this.cleanup();
    if (this.communicator) {
      this.communicator.terminate();
      this.communicator = null;
    }
  }

  private cleanup(): void {
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
  }

  // 古いAPIとの互換性のため、仮の実装を提供
  getActualVideoCodec(): string | null {
    // 新しいAPIでは設定情報から推定
    return this.config?.codec?.video || null;
  }

  getActualAudioCodec(): string | null {
    // 新しいAPIでは設定情報から推定
    return this.config?.codec?.audio || null;
  }
}
