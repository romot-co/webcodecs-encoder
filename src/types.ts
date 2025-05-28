// 新しい関数ファーストAPI用の型定義

// 基本的なフレーム型
export type Frame = VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData;

// ビデオファイル型
export interface VideoFile {
  file: File | Blob;
  type: string;
}

// ビデオソース型（すべての入力形式）
export type VideoSource = 
  | Frame[]                    // 静的フレーム配列
  | AsyncIterable<Frame>       // ストリーミングフレーム
  | MediaStream               // カメラ/画面共有
  | VideoFile;                // 既存の動画ファイル

// 品質プリセット
export type QualityPreset = 'low' | 'medium' | 'high' | 'lossless';

// ビデオ設定
export interface VideoConfig {
  codec?: 'avc' | 'hevc' | 'vp9' | 'vp8' | 'av1';
  bitrate?: number;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  latencyMode?: 'quality' | 'realtime';
  keyFrameInterval?: number;
}

// オーディオ設定
export interface AudioConfig {
  codec?: 'aac' | 'opus';
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  bitrateMode?: 'constant' | 'variable';
}

// プログレス情報
export interface ProgressInfo {
  percent: number;
  processedFrames: number;
  totalFrames?: number;
  fps: number;
  stage: string;
  estimatedRemainingMs?: number;
}

// エンコードオプション
export interface EncodeOptions {
  // 基本設定（自動検出可能）
  width?: number;
  height?: number;
  frameRate?: number;

  // 品質プリセット
  quality?: QualityPreset;

  // 詳細設定（オプショナル）
  video?: VideoConfig;
  audio?: AudioConfig | false; // falseでオーディオ無効化
  container?: 'mp4' | 'webm';

  // コールバック
  onProgress?: (progress: ProgressInfo) => void;
  onError?: (error: EncodeError) => void;
}

// エラータイプ
export type EncodeErrorType =
  | 'not-supported'
  | 'initialization-failed'
  | 'configuration-error'
  | 'invalid-input' // 入力ソースやフレームデータが不正
  | 'encoding-failed'
  | 'video-encoding-error'
  | 'audio-encoding-error'
  | 'muxing-failed'
  | 'cancelled'
  | 'timeout'
  | 'worker-error'
  | 'filesystem-error' // VideoFileアクセス時など
  | 'unknown';

// カスタムエラークラス
export class EncodeError extends Error {
  type: EncodeErrorType;
  cause?: unknown;

  constructor(type: EncodeErrorType, message: string, cause?: unknown) {
    super(message);
    this.name = 'EncodeError';
    this.type = type;
    this.cause = cause;
    Object.setPrototypeOf(this, EncodeError.prototype);
  }
}

// --- 内部実装用の型定義（ワーカー通信など） ---

// ワーカー通信用の基本設定型（内部実装用）
export interface EncoderConfig {
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number; // bps
  audioBitrate: number; // bps
  /**
   * Controls bitrate distribution for AAC. "constant" produces constant
   * bitrate (CBR) output while "variable" enables variable bitrate (VBR).
   * Not all browsers respect this setting. Chrome 119+ improves CBR support.
   */
  audioBitrateMode?: "constant" | "variable";
  sampleRate: number; // Hz
  channels: number; // e.g., 1 for mono, 2 for stereo
  container?: "mp4" | "webm"; // Default: 'mp4'. Set 'webm' for WebM output.
  codec?: {
    video?: "avc" | "hevc" | "vp9" | "vp8" | "av1"; // Default: 'avc' (H.264)
    audio?: "aac" | "opus"; // Default: 'aac'
  };
  /**
   * Optional codec string overrides passed directly to the encoders.
   * For example: `{ video: 'avc1.640028', audio: 'mp4a.40.2' }`.
   */
  codecString?: {
    video?: string;
    audio?: string;
  };
  latencyMode?: "quality" | "realtime"; // Default: 'quality'
  /** Preference for hardware or software encoding. */
  hardwareAcceleration?:
    | "prefer-hardware"
    | "prefer-software"
    | "no-preference";
  /** Drop new video frames when the number of queued frames exceeds `maxQueueDepth`. */
  dropFrames?: boolean;
  /** Maximum number of queued video frames before dropping. Defaults to `Infinity`. */
  maxQueueDepth?: number;
  /** Total frames for progress calculation if known in advance. */
  totalFrames?: number;
  /** Force a key frame every N video frames. */
  keyFrameInterval?: number;
  /**
   * How to handle the first timestamp of a track.
   * 'offset': Offsets all timestamps so the first one is 0.
   * 'strict': Requires the first timestamp to be 0 (default).
   */
  firstTimestampBehavior?: "offset" | "strict";
  /** Additional VideoEncoder configuration overrides. */
  videoEncoderConfig?: Partial<VideoEncoderConfig>;
  /** Additional AudioEncoder configuration overrides. */
  audioEncoderConfig?: Partial<AudioEncoderConfig>;
}

// 処理ステージの定義
export enum ProcessingStage {
  Initializing = "initializing",
  VideoEncoding = "video-encoding",
  AudioEncoding = "audio-encoding",
  Muxing = "muxing",
  Finalizing = "finalizing",
}

// エンコーダーのエラータイプ（内部実装用）
export enum EncoderErrorType {
  NotSupported = "not-supported",
  InitializationFailed = "initialization-failed",
  ConfigurationError = "configuration-error",
  EncodingFailed = "encoding-failed", // Generic encoding error
  VideoEncodingError = "video-encoding-error", // Specific video encoding error
  AudioEncodingError = "audio-encoding-error", // Specific audio encoding error
  MuxingFailed = "muxing-failed",
  Cancelled = "cancelled",
  Timeout = "timeout",
  InternalError = "internal-error",
  WorkerError = "worker-error",
  ValidationError = "validation-error",
}

// --- ワーカー通信用のメッセージ型 ---

// Messages TO the Worker
export interface InitializeWorkerMessage {
  type: "initialize";
  config: EncoderConfig;
  totalFrames?: number; // For progress calculation
}

export interface AddVideoFrameMessage {
  type: "addVideoFrame";
  frame: VideoFrame;
  timestamp: number; // microseconds
}

export interface AddAudioDataMessage {
  type: "addAudioData";
  // Array of Float32Array for each channel (non-interleaved).
  // The ArrayBuffer of each Float32Array should be transferred.
  audioData?: Float32Array[];
  /** Optional AudioData object to be encoded directly. */
  audio?: AudioData;
  timestamp: number; // microseconds
  format: AudioSampleFormat; // e.g., "f32-planar" or "s16" etc. (AudioSampleFormat from WebCodecs)
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
}

export interface FinalizeWorkerMessage {
  type: "finalize";
}

export interface CancelWorkerMessage {
  type: "cancel";
}

export type WorkerMessage =
  | InitializeWorkerMessage
  | AddVideoFrameMessage
  | AddAudioDataMessage
  | FinalizeWorkerMessage
  | CancelWorkerMessage;

// Messages FROM the Worker
export interface WorkerInitializedMessage {
  type: "initialized";
  actualVideoCodec?: string;
  actualAudioCodec?: string;
}

export interface ProgressMessage {
  type: "progress";
  processedFrames: number;
  totalFrames?: number;
}

export interface WorkerFinalizedMessage {
  type: "finalized";
  output: Uint8Array | null; // MP4 file data or null when streaming
}

export interface QueueSizeMessage {
  type: "queueSize";
  videoQueueSize: number;
  audioQueueSize: number;
}

export interface WorkerDataChunkMessage {
  type: "dataChunk";
  chunk: Uint8Array;
  isHeader?: boolean; // Indicates if this chunk is a header (e.g., moov for MP4, EBML for WebM)
  offset?: number; // For MP4 fragmented streaming
  container: "mp4" | "webm"; // To inform the main thread which muxer this chunk belongs to
}

export interface WorkerErrorMessage {
  type: "error";
  errorDetail: {
    message: string;
    type: EncoderErrorType;
    stack?: string;
  };
}

export interface WorkerCancelledMessage {
  type: "cancelled";
}

export type MainThreadMessage =
  | WorkerInitializedMessage
  | ProgressMessage
  | WorkerFinalizedMessage
  | QueueSizeMessage
  | WorkerDataChunkMessage
  | WorkerErrorMessage
  | WorkerCancelledMessage;

// --- Helper Types for environment-dependent constructors ---
export type VideoEncoderConstructor = typeof VideoEncoder;
export type AudioEncoderConstructor = typeof AudioEncoder;
export type AudioDataConstructor = typeof AudioData;

export type VideoEncoderGetter = () => VideoEncoderConstructor | undefined;
export type AudioEncoderGetter = () => AudioEncoderConstructor | undefined;
export type AudioDataGetter = () => AudioDataConstructor | undefined;
