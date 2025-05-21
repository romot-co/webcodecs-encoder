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

export type ProgressCallback = (
  processedFrames: number,
  totalFrames?: number,
) => void;

// --- Custom Error for the library ---
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
}

export class WebCodecsEncoderError extends Error {
  constructor(
    public type: EncoderErrorType,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "WebCodecsEncoderError";
    // Ensure the prototype chain is correct for custom errors
    Object.setPrototypeOf(this, WebCodecsEncoderError.prototype);
  }
}

// --- Message types for communication between main thread and worker ---

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

export interface ConnectAudioPortMessage {
  type: "connectAudioPort";
  port: MessagePort;
}

export type WorkerMessage =
  | InitializeWorkerMessage
  | AddVideoFrameMessage
  | AddAudioDataMessage
  | FinalizeWorkerMessage
  | CancelWorkerMessage
  | ConnectAudioPortMessage;

// Messages FROM the Worker
export interface WorkerInitializedMessage {
  type: "initialized";
  actualVideoCodec?: string;
  actualAudioCodec?: string;
}

export interface VideoChunkMessage {
  // Primarily for internal use or advanced scenarios
  type: "videoChunk";
  chunk: EncodedVideoChunk;
  meta?: EncodedVideoChunkMetadata;
}

export interface AudioChunkMessage {
  // Primarily for internal use or advanced scenarios
  type: "audioChunk";
  chunk: EncodedAudioChunk;
  meta?: EncodedAudioChunkMetadata;
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
    // Renamed from 'error' to avoid conflict with global Error
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
  // | VideoChunkMessage // These are handled internally by the muxer in the worker
  // | AudioChunkMessage // These are handled internally by the muxer in the worker
  | ProgressMessage
  | WorkerFinalizedMessage
  | QueueSizeMessage
  | WorkerDataChunkMessage
  | WorkerErrorMessage
  | WorkerCancelledMessage;
