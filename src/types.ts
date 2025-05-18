export interface EncoderConfig {
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number; // bps
  audioBitrate: number; // bps
  sampleRate: number;   // Hz
  channels: number;     // e.g., 1 for mono, 2 for stereo
  container?: 'mp4' | 'webm'; // Default: 'mp4' or auto-selected based on codec
  codec?: {
    video?: 'avc' | 'hevc' | 'vp9' | 'av1'; // Default: 'avc' (H.264)
    audio?: 'aac' | 'opus'; // Default: 'aac'
  };
  latencyMode?: 'quality' | 'realtime'; // Default: 'quality'
  /** Total frames for progress calculation if known in advance. */
  totalFrames?: number;
}

export type ProgressCallback = (processedFrames: number, totalFrames: number) => void;

// --- Custom Error for the library ---
export enum EncoderErrorType {
  NotSupported = 'not-supported',
  InitializationFailed = 'initialization-failed',
  ConfigurationError = 'configuration-error',
  EncodingFailed = 'encoding-failed',         // Generic encoding error
  VideoEncodingError = 'video-encoding-error', // Specific video encoding error
  AudioEncodingError = 'audio-encoding-error', // Specific audio encoding error
  MuxingFailed = 'muxing-failed',
  Cancelled = 'cancelled',
  Timeout = 'timeout',
  InternalError = 'internal-error',
  WorkerError = 'worker-error',
}

export class Mp4EncoderError extends Error {
  constructor(public type: EncoderErrorType, message: string, public cause?: any) {
    super(message);
    this.name = 'Mp4EncoderError';
    // Ensure the prototype chain is correct for custom errors
    Object.setPrototypeOf(this, Mp4EncoderError.prototype);
  }
}

// --- Message types for communication between main thread and worker ---

// Messages TO the Worker
export interface InitializeWorkerMessage {
  type: 'initialize';
  config: EncoderConfig;
  totalFrames?: number; // For progress calculation
}

export interface AddVideoFrameMessage {
  type: 'addVideoFrame';
  frameBitmap: ImageBitmap;
  timestamp: number; // microseconds
}

export interface AddAudioDataMessage {
  type: 'addAudioData';
  // Array of Float32Array for each channel (non-interleaved).
  // The ArrayBuffer of each Float32Array should be transferred.
  audioData: Float32Array[];
  timestamp: number; // microseconds
}

export interface FinalizeWorkerMessage {
  type: 'finalize';
}

export interface CancelWorkerMessage {
  type: 'cancel';
}

export type WorkerMessage =
  | InitializeWorkerMessage
  | AddVideoFrameMessage
  | AddAudioDataMessage
  | FinalizeWorkerMessage
  | CancelWorkerMessage;

// Messages FROM the Worker
export interface WorkerInitializedMessage {
  type: 'initialized';
  actualVideoCodec?: string;
  actualAudioCodec?: string;
}

export interface VideoChunkMessage { // Primarily for internal use or advanced scenarios
  type: 'videoChunk';
  chunk: EncodedVideoChunk;
  meta?: EncodedVideoChunkMetadata;
}

export interface AudioChunkMessage { // Primarily for internal use or advanced scenarios
  type: 'audioChunk';
  chunk: EncodedAudioChunk;
  meta?: EncodedAudioChunkMetadata;
}

export interface ProgressMessage {
  type: 'progress';
  processedFrames: number;
  totalFrames: number;
}

export interface WorkerFinalizedMessage {
  type: 'finalized';
  output: Uint8Array | null; // MP4 file data or null when streaming
}

export interface WorkerDataChunkMessage {
  type: 'dataChunk';
  chunk: Uint8Array;
  isHeader?: boolean; // Indicates if this chunk is a header (e.g., moov for MP4, EBML for WebM)
  offset?: number;    // For MP4 fragmented streaming
  container: 'mp4' | 'webm'; // To inform the main thread which muxer this chunk belongs to
}

export interface WorkerErrorMessage {
  type: 'error';
  errorDetail: { // Renamed from 'error' to avoid conflict with global Error
    message: string;
    type: EncoderErrorType;
    stack?: string;
  };
}

export interface WorkerCancelledMessage {
  type: 'cancelled';
}

export type MainThreadMessage =
  | WorkerInitializedMessage
  // | VideoChunkMessage // These are handled internally by the muxer in the worker
  // | AudioChunkMessage // These are handled internally by the muxer in the worker
  | ProgressMessage
  | WorkerFinalizedMessage
  | WorkerDataChunkMessage
  | WorkerErrorMessage
  | WorkerCancelledMessage;
