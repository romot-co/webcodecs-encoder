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
let muxer: Mp4MuxerWrapper | null = null;
let currentConfig: EncoderConfig | null = null;
let totalFramesToProcess: number | undefined;
let processedFrames: number = 0;
let isCancelled: boolean = false;

function postMessageToMainThread(message: MainThreadMessage, transfer?: Transferable[]): void {
  postMessage(message, transfer as any);
}

async function initializeEncoders(data: InitializeWorkerMessage): Promise<void> {
  currentConfig = data.config;
  totalFramesToProcess = data.totalFrames;
  processedFrames = 0;
  isCancelled = false;

  if (!currentConfig) {
    postMessageToMainThread({ type: 'error', errorDetail: { message: 'Worker: Configuration is missing.', type: EncoderErrorType.InitializationFailed }});
    return;
  }

  if (currentConfig.container === 'webm') {
    postMessageToMainThread({ type: 'error', errorDetail: { message: 'Worker: WebM container is not supported in this version.', type: EncoderErrorType.NotSupported }});
    return;
  }

  try {
    muxer = new Mp4MuxerWrapper(currentConfig, postMessageToMainThread);
  } catch (e: any) {
    postMessageToMainThread({ type: 'error', errorDetail: { message: `Worker: Failed to initialize MP4 Muxer: ${e.message}`, type: EncoderErrorType.InitializationFailed, stack: e.stack }});
    cleanup();
    return;
  }
  
  let videoCodec = currentConfig.codec?.video ?? 'avc';
  let finalVideoEncoderConfig: VideoEncoderConfig | null = null;

  const baseVideoConfig = {
    width: currentConfig.width,
    height: currentConfig.height,
    framerate: currentConfig.frameRate,
    bitrate: currentConfig.videoBitrate,
    ...(currentConfig.latencyMode && { latencyMode: currentConfig.latencyMode }),
    ...(videoCodec === 'vp9' && { codec: 'vp09.00.50.08', scalabilityMode: 'L1T2' }), 
    ...(videoCodec === 'avc' && { codec: 'avc1.42001f', avc: { format: 'avcc' } }),
  };

  let videoSupport = await VideoEncoder.isConfigSupported(baseVideoConfig as any); 
  if (videoSupport?.supported) {
    finalVideoEncoderConfig = videoSupport.config as VideoEncoderConfig;
  } else if (videoCodec === 'vp9' || videoCodec === 'av1' || videoCodec === 'hevc') {
    console.warn(`Worker: Video codec ${videoCodec} not supported or config invalid. Falling back to AVC.`);
    videoCodec = 'avc';
    const fallbackVideoConfig = {
        ...baseVideoConfig,
        codec: 'avc1.42001f',
        avc: { format: 'avcc' }
    };
    delete (fallbackVideoConfig as any).scalabilityMode;
    videoSupport = await VideoEncoder.isConfigSupported(fallbackVideoConfig as any);
    if (videoSupport?.supported) {
      finalVideoEncoderConfig = videoSupport.config as VideoEncoderConfig;
    } else {
      postMessageToMainThread({ type: 'error', errorDetail: { message: 'Worker: AVC (H.264) video codec is not supported after fallback.', type: EncoderErrorType.NotSupported }});
      cleanup();
      return;
    }
  } else {
    postMessageToMainThread({ type: 'error', errorDetail: { message: `Worker: Video codec ${videoCodec} config not supported.`, type: EncoderErrorType.NotSupported }});
    cleanup();
    return;
  }

  try {
    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (isCancelled || !muxer) return;
        muxer.addVideoChunk(chunk, meta);
      },
      error: (error) => {
        if (isCancelled) return;
        postMessageToMainThread({ type: 'error', errorDetail: { message: `VideoEncoder error: ${error.message}`, type: EncoderErrorType.VideoEncodingError, stack: error.stack }});
        cleanup();
      }
    });
    videoEncoder.configure(finalVideoEncoderConfig as any);
  } catch (e: any) {
    postMessageToMainThread({ type: 'error', errorDetail: { message: `Worker: Failed to initialize VideoEncoder: ${e.message}`, type: EncoderErrorType.InitializationFailed, stack: e.stack }});
    cleanup();
    return;
  }

  let audioCodec = currentConfig.codec?.audio ?? 'aac';
  let finalAudioEncoderConfig: AudioEncoderConfig | null = null;

  const baseAudioConfig = {
    sampleRate: currentConfig.sampleRate,
    numberOfChannels: currentConfig.channels,
    bitrate: currentConfig.audioBitrate,
    ...(currentConfig.latencyMode && { latencyMode: currentConfig.latencyMode }),
    ...(audioCodec === 'opus' && { codec: 'opus' }),
    ...(audioCodec === 'aac' && { codec: 'mp4a.40.2' }),
  };

  let audioSupport = await AudioEncoder.isConfigSupported(baseAudioConfig as any);
  if (audioSupport?.supported) {
    finalAudioEncoderConfig = audioSupport.config as AudioEncoderConfig;
  } else if (audioCodec === 'opus') {
    console.warn(`Worker: Audio codec ${audioCodec} not supported or config invalid. Falling back to AAC.`);
    audioCodec = 'aac';
    const fallbackAudioConfig = { ...baseAudioConfig, codec: 'mp4a.40.2' };
    audioSupport = await AudioEncoder.isConfigSupported(fallbackAudioConfig as any);
    if (audioSupport?.supported) {
      finalAudioEncoderConfig = audioSupport.config as AudioEncoderConfig;
    } else {
      postMessageToMainThread({ type: 'error', errorDetail: { message: 'Worker: AAC audio codec is not supported after fallback.', type: EncoderErrorType.NotSupported }});
      cleanup();
      return;
    }
  } else {
     postMessageToMainThread({ type: 'error', errorDetail: { message: `Worker: Audio codec ${audioCodec} config not supported.`, type: EncoderErrorType.NotSupported }});
     cleanup();
     return;
  }
  
  try {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (isCancelled || !muxer) return;
        muxer.addAudioChunk(chunk, meta);
      },
      error: (error) => {
        if (isCancelled) return;
        postMessageToMainThread({ type: 'error', errorDetail: { message: `AudioEncoder error: ${error.message}`, type: EncoderErrorType.AudioEncodingError, stack: error.stack }});
        cleanup();
      }
    });
    audioEncoder.configure(finalAudioEncoderConfig as any);
  } catch (e: any) {
    postMessageToMainThread({ type: 'error', errorDetail: { message: `Worker: Failed to initialize AudioEncoder: ${e.message}`, type: EncoderErrorType.InitializationFailed, stack: e.stack }});
    cleanup();
    return;
  }

  postMessageToMainThread({ 
    type: 'initialized',
  } as MainThreadMessage);
}

async function handleAddVideoFrame(data: AddVideoFrameMessage): Promise<void> {
  if (isCancelled || !videoEncoder || !currentConfig) return;
  try {
    const frameDuration = 1_000_000 / currentConfig.frameRate; 
    const frame = new VideoFrame(data.frameBitmap, { timestamp: data.timestamp, duration: frameDuration });
    videoEncoder.encode(frame);
    frame.close();
    processedFrames++;
    if (totalFramesToProcess) {
      postMessageToMainThread({ type: 'progress', processedFrames, totalFrames: totalFramesToProcess } as MainThreadMessage);
    }
  } catch (error: any) {
    postMessageToMainThread({
        type: 'error',
        errorDetail: { message: `Error encoding video frame: ${error.message}`, type: EncoderErrorType.VideoEncodingError, stack: error.stack }
      } as MainThreadMessage);
    cleanup();
  }
}

async function handleAddAudioData(data: AddAudioDataMessage): Promise<void> {
  if (isCancelled || !audioEncoder || !currentConfig || !data.audioData || data.audioData.length === 0) return;
  
  if (data.audioData.length !== currentConfig.channels) {
    postMessageToMainThread({
      type: 'error',
      errorDetail: { message: `Audio data channel count (${data.audioData.length}) does not match configured channels (${currentConfig.channels}).`, type: EncoderErrorType.ConfigurationError }
    } as MainThreadMessage);
    return;
  }

  const firstChannelData = data.audioData[0];
  const numberOfFrames = firstChannelData.length;

  const totalSamples = numberOfFrames * currentConfig.channels;
  const interleavedOrConcatenatedPlanarData = new Float32Array(totalSamples);
  let offset = 0;
  if (currentConfig.channels === 1) {
    interleavedOrConcatenatedPlanarData.set(firstChannelData);
  } else {
    for (let i = 0; i < currentConfig.channels; i++) {
        interleavedOrConcatenatedPlanarData.set(data.audioData[i], offset);
        offset += data.audioData[i].length;
    }
  }
  
  try {
    const audioDataInit: AudioDataInit = {
      format: 'f32-planar',
      sampleRate: currentConfig.sampleRate,
      numberOfFrames: numberOfFrames,
      numberOfChannels: currentConfig.channels,
      timestamp: data.timestamp,
      data: interleavedOrConcatenatedPlanarData.buffer
    };
    const audioFrame = new AudioData(audioDataInit);
    audioEncoder.encode(audioFrame);
    audioFrame.close();
  } catch (error: any) {
    postMessageToMainThread({
        type: 'error',
        errorDetail: { message: `Error encoding audio data: ${error.message}`, type: EncoderErrorType.AudioEncodingError, stack: error.stack }
      } as MainThreadMessage);
    cleanup();
  }
}

async function handleFinalize(): Promise<void> {
  if (isCancelled) return;

  try {
    if (videoEncoder) await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    
    if (muxer) {
      const output = muxer.finalize();
      if (output) {
        postMessageToMainThread({ type: 'finalized', output } as MainThreadMessage, [output.buffer]);
      } else if (currentConfig?.latencyMode === 'realtime') {
        postMessageToMainThread({ type: 'finalized', output: null as any } as MainThreadMessage);
      } else {
         postMessageToMainThread({ type: 'error', errorDetail: { message: 'Muxer finalized without output in non-realtime mode.', type: EncoderErrorType.MuxingFailed }});
      }
    } else {
      postMessageToMainThread({ type: 'error', errorDetail: { message: 'Muxer not initialized during finalize.', type: EncoderErrorType.MuxingFailed }});
    }
  } catch (error: any) {
    postMessageToMainThread({
        type: 'error',
        errorDetail: { message: `Error during finalization: ${error.message}`, type: EncoderErrorType.MuxingFailed, stack: error.stack }
      } as MainThreadMessage);
  } finally {
    cleanup();
  }
}

function handleCancel(): void {
  if (isCancelled) return;
  isCancelled = true;
  console.log('Worker: Received cancel signal.');
  videoEncoder?.close();
  audioEncoder?.close();
  cleanup();
  postMessageToMainThread({ type: 'cancelled' } as MainThreadMessage);
}

function cleanup(): void {
  console.log('Worker: Cleaning up resources.');
  if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close();
  if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
  videoEncoder = null;
  audioEncoder = null;
  muxer = null; 
  currentConfig = null;
  totalFramesToProcess = undefined;
  processedFrames = 0;
  isCancelled = false; 
}

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (isCancelled && event.data.type !== 'initialize' && event.data.type !== 'cancel') {
    console.warn(`Worker: Ignoring message type '${event.data.type}' because worker is cancelled.`);
    return;
  }

  try {
    switch (event.data.type) {
      case 'initialize':
        isCancelled = false;
        cleanup();
        await initializeEncoders(event.data);
        break;
      case 'addVideoFrame':
        if (isCancelled) break;
        await handleAddVideoFrame(event.data);
        break;
      case 'addAudioData':
        if (isCancelled) break;
        await handleAddAudioData(event.data);
        break;
      case 'finalize':
        if (isCancelled) break;
        await handleFinalize();
        break;
      case 'cancel':
        handleCancel();
        break;
      default:
        console.warn('Worker received unknown message type:', (event.data as any)?.type);
    }
  } catch (error: any) {
    postMessageToMainThread({
        type: 'error',
        errorDetail: { message: `Unhandled error in worker onmessage: ${error.message}`, type: EncoderErrorType.InternalError, stack: error.stack }
      } as MainThreadMessage);
    cleanup();
  }
};

console.log('Worker script loaded.');
