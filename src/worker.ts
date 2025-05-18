import { Mp4MuxerWrapper } from './mp4muxer';
import type {
  EncoderConfig,
  WorkerMessage,
  InitializeWorkerMessage,
  AddVideoFrameMessage,
  AddAudioDataMessage,
  FinalizeWorkerMessage,
  CancelWorkerMessage,
  MainThreadMessage,
} from './types';
import { EncoderErrorType } from './types';

let videoEncoder: VideoEncoder | null = null;
let audioEncoder: AudioEncoder | null = null;
let mp4Muxer: Mp4MuxerWrapper | null = null;
let currentConfig: EncoderConfig | null = null;
let totalFramesToProcess: number | undefined;
let processedFrames: number = 0;
let isCancelled: boolean = false;

async function initializeEncoders(data: InitializeWorkerMessage): Promise<void> {
  currentConfig = data.config;
  totalFramesToProcess = data.totalFrames;
  processedFrames = 0;
  isCancelled = false;

  if (!currentConfig) {
    throw new Error('Configuration is missing for worker initialization.');
  }

  // Initialize Mp4MuxerWrapper
  mp4Muxer = new Mp4MuxerWrapper(currentConfig);

  // VideoEncoder configuration
  const videoEncoderConfig: VideoEncoderConfig = {
    codec: currentConfig.codec?.video === 'hevc' ? 'hev1.0.6.L93.B0' : // Example HEVC, adjust as needed
           currentConfig.codec?.video === 'vp9' ? 'vp09.00.50.08' :    // Example VP9, adjust as needed
           currentConfig.codec?.video === 'av1' ? 'av01.0.08M.08' :    // Example AV1, adjust as needed
           'avc1.42001f', // Default to H.264 Baseline
    width: currentConfig.width,
    height: currentConfig.height,
    framerate: currentConfig.frameRate,
    bitrate: currentConfig.videoBitrate,
    // Additional options like latencyMode, scalabilityMode, etc., can be added here if needed
    // For H.264, avc parameter might be needed for specific NAL unit formats if not default.
    // e.g., avc: { format: 'annexb' } // or 'avcc'
  };

  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (isCancelled) return;
      mp4Muxer?.addVideoChunk(chunk, meta);
      // Post progress (optional, could be too frequent)
    },
    error: (error) => {
      if (isCancelled) return;
      console.error('VideoEncoder error:', error);
      postMessage({
        type: 'error',
        errorDetail: { message: error.message, type: EncoderErrorType.VideoEncodingError, stack: error.stack }
      } as MainThreadMessage);
      cleanup();
    }
  });
  await videoEncoder.configure(videoEncoderConfig);

  // AudioEncoder configuration
  const audioEncoderConfig: AudioEncoderConfig = {
    codec: currentConfig.codec?.audio === 'opus' ? 'opus' : 'mp4a.40.2', // Default to AAC-LC
    sampleRate: currentConfig.sampleRate,
    numberOfChannels: currentConfig.channels,
    bitrate: currentConfig.audioBitrate, 
  };

  audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (isCancelled) return;
      mp4Muxer?.addAudioChunk(chunk, meta);
    },
    error: (error) => {
      if (isCancelled) return;
      console.error('AudioEncoder error:', error);
      postMessage({
        type: 'error',
        errorDetail: { message: error.message, type: 'audio-encode' as EncoderErrorType, stack: error.stack }
      } as MainThreadMessage);
      cleanup();
    }
  });
  await audioEncoder.configure(audioEncoderConfig);

  postMessage({ type: 'initialized' } as MainThreadMessage);
}

async function handleAddVideoFrame(data: AddVideoFrameMessage): Promise<void> {
  if (isCancelled || !videoEncoder || !currentConfig) return;

  const frame = new VideoFrame(data.frameBitmap, { timestamp: data.timestamp, duration: 1_000_000 / currentConfig.frameRate });
  // The ownership of data.frameBitmap is transferred to the VideoFrame, so it cannot be closed here by the caller.
  // It will be closed when the VideoFrame itself is closed.

  try {
    videoEncoder.encode(frame);
    frame.close(); // Close the frame after encoding (or after it's no longer needed by the encoder)
    processedFrames++;
    if (totalFramesToProcess) {
      postMessage({ type: 'progress', processedFrames, totalFrames: totalFramesToProcess } as MainThreadMessage);
    }
  } catch (error: any) {
    console.error('Error encoding video frame:', error);
    postMessage({
        type: 'error',
        errorDetail: { message: error.message, type: EncoderErrorType.VideoEncodingError, stack: error.stack }
      } as MainThreadMessage);
    cleanup();
  }
}

async function handleAddAudioData(data: AddAudioDataMessage): Promise<void> {
  if (isCancelled || !audioEncoder || !currentConfig) return;

  // Assuming data.audioData is an array of Float32Arrays (one for each channel, non-interleaved)
  // and needs to be converted to AudioData for the AudioEncoder.
  // The Web Audio API's AudioBuffer.copyFromChannel can be used in the main thread to get this.
  // Here, we need to ensure the data is in the correct format (interleaved or planar based on encoder needs).
  // Most AAC encoders expect interleaved data.

  // For simplicity, assuming a single planar Float32Array for now if mono, or needs interleaving for stereo.
  // This part needs careful implementation based on how AudioBuffer is processed in the main thread.
  // Let's assume for now data.audioData[0] is the Float32Array to use for a mono track or needs interleaving for stereo.
  // This example assumes we've prepared a single Float32Array that's ready for encoding.
  // A more robust solution would handle interleaving if `currentConfig.channels > 1`.

  const audioDataBuffer = data.audioData[0]; // This is a placeholder and needs proper channel handling.
  if (currentConfig.channels > 1 && data.audioData.length !== currentConfig.channels) {
     console.warn('Audio data channel count mismatch. Expected planar data per channel.');
     // Potentially throw an error or try to handle it if possible.
     // For now, we'll proceed assuming the first channel or that the data is already interleaved if mono.
  }
  
  // If audioData is planar (array of Float32Array per channel), it needs to be interleaved for many AAC encoders.
  // Let's create an AudioData object. The format (interleaved/planar) might depend on the encoder.
  // For AAC, mp4a.40.2, typically expects interleaved.
  // We'll make a simple AudioData assuming the provided Float32Array is what's needed.
  // The timestamp and duration calculation here is also simplified.
  // A proper implementation would segment AudioBuffer into frames.

  const audioEncoderFrame = new AudioData({
    format: 'f32-planar', // Or 'f32' if interleaved. 'f32-planar' if data.audioData is an array of channels.
    sampleRate: currentConfig.sampleRate,
    numberOfFrames: audioDataBuffer.length / currentConfig.channels, // This needs to be correct if planar
    numberOfChannels: currentConfig.channels,
    timestamp: data.timestamp, // microseconds
    data: audioDataBuffer // This needs to be the actual ArrayBuffer data.
                           // If planar, AudioData might expect data.audioData itself if the API supports it, 
                           // or it needs to be a single ArrayBuffer with all channels interleaved.
                           // The spec for AudioData with 'f32-planar' needs to be checked for exact data layout.
  });

  try {
    audioEncoder.encode(audioEncoderFrame);
    audioEncoderFrame.close(); // Close the AudioData after encoding
  } catch (error: any) {
    console.error('Error encoding audio data:', error);
    postMessage({
        type: 'error',
        errorDetail: { message: error.message, type: EncoderErrorType.AudioEncodingError, stack: error.stack }
      } as MainThreadMessage);
    cleanup();
  }
}

async function handleFinalize(): Promise<void> {
  if (isCancelled) return;

  try {
    if (videoEncoder) await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    if (mp4Muxer) {
      const output = mp4Muxer.finalize();
      postMessage({ type: 'finalized', output } as MainThreadMessage, { transfer: [output.buffer] });
    } else {
      throw new Error('Muxer not initialized during finalize.');
    }
  } catch (error: any) {
    console.error('Error during finalization:', error);
     postMessage({
        type: 'error',
        errorDetail: { message: error.message, type: EncoderErrorType.MuxingFailed, stack: error.stack }
      } as MainThreadMessage);
  } finally {
    cleanup();
  }
}

function handleCancel(): void {
  if (isCancelled) return;
  isCancelled = true;
  console.log('Worker: Received cancel signal.');
  // Further actions might include trying to abort ongoing encoder operations if possible,
  // though VideoEncoder/AudioEncoder don't have explicit abort methods.
  // Flushing might be problematic if cancellation is abrupt.
  cleanup();
  postMessage({ type: 'cancelled' } as MainThreadMessage);
}

function cleanup(): void {
  console.log('Worker: Cleaning up resources.');
  videoEncoder?.close();
  audioEncoder?.close();
  videoEncoder = null;
  audioEncoder = null;
  mp4Muxer = null; // Muxer doesn't have a close, rely on GC for its internal ArrayBufferTarget.
  currentConfig = null;
  totalFramesToProcess = undefined;
  processedFrames = 0;
  isCancelled = false; 
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (isCancelled && event.data.type !== 'cancel') {
    // If already cancelled, ignore other messages except for a redundant cancel.
    return;
  }

  try {
    switch (event.data.type) {
      case 'initialize':
        await initializeEncoders(event.data);
        break;
      case 'addVideoFrame':
        // Offload to avoid blocking the message loop for too long if bitmap processing is heavy
        // Though encode() itself is async.
        await handleAddVideoFrame(event.data);
        break;
      case 'addAudioData':
        await handleAddAudioData(event.data);
        break;
      case 'finalize':
        await handleFinalize();
        break;
      case 'cancel':
        handleCancel();
        break;
      default:
        console.warn('Worker received unknown message type:', (event.data as any).type);
    }
  } catch (error: any) {
    console.error('Unhandled error in worker onmessage:', error);
    postMessage({
      type: 'error',
      errorDetail: { message: error.message || 'Unknown worker error', type: EncoderErrorType.InternalError, stack: error.stack }
    } as MainThreadMessage);
    cleanup(); // General cleanup on unhandled errors
  }
};

console.log('Worker script loaded.'); 