import { WebCodecsEncoder } from './encoder';
import { 
  VideoSource, 
  Frame, 
  EncodeOptions, 
  QualityPreset
} from './functional-types';
import { 
  EncoderConfig, 
  WebCodecsEncoderError, 
  EncoderErrorType 
} from './types';

/**
 * ビデオエンコードのメイン関数
 * 
 * @param source エンコードするビデオソース
 * @param options エンコードオプション
 * @returns エンコードされたバイナリデータ
 */
export async function encode(
  source: VideoSource,
  options?: EncodeOptions
): Promise<Uint8Array> {
  // 設定の推定と正規化
  const config = await inferAndBuildConfig(source, options);
  
  // エンコーダーの作成と初期化
  const encoder = new WebCodecsEncoder(config);
  
  try {
    await encoder.initialize({
      onProgress: options?.onProgress ? (processed, total) => {
        const percent = total ? (processed / total) * 100 : 0;
        options.onProgress!({
          percent,
          processedFrames: processed,
          totalFrames: total || 0,
          fps: 0, // 詳細計算は後で実装
          stage: 'encoding'
        });
      } : undefined,
      onError: options?.onError,
    });

    // ソースの種類に応じて処理
    await processVideoSource(encoder, source);

    // 結果の取得
    const result = await encoder.finalize();
    if (!result) {
      throw new WebCodecsEncoderError(
        EncoderErrorType.EncodingFailed,
        'Encoding failed to produce output'
      );
    }

    return result;
  } catch (error) {
    // エラーの統一的な処理
    if (options?.onError) {
      options.onError(error as Error);
    }
    throw error;
  }
}

/**
 * ストリーミングエンコード関数
 * 
 * @param source エンコードするビデオソース
 * @param options エンコードオプション
 * @returns エンコードされたチャンクのAsyncGenerator
 */
export async function* encodeStream(
  source: VideoSource,
  options?: EncodeOptions
): AsyncGenerator<Uint8Array> {
  const config = await inferAndBuildConfig(source, options);
  
  // リアルタイムモードに設定
  config.latencyMode = 'realtime';
  
  const encoder = new WebCodecsEncoder(config);
  const chunks: Uint8Array[] = [];
  let isFinalized = false;
  let streamError: Error | null = null;

  try {
    await encoder.initialize({
      onData: (chunk) => {
        chunks.push(chunk);
      },
      onProgress: options?.onProgress ? (processed, total) => {
        const percent = total ? (processed / total) * 100 : 0;
        options.onProgress!({
          percent,
          processedFrames: processed,
          totalFrames: total || 0,
          fps: 0,
          stage: 'streaming'
        });
      } : undefined,
      onError: (error) => {
        streamError = error;
        if (options?.onError) {
          options.onError(error as Error);
        }
      },
    });

    // バックグラウンドでソース処理を開始
    processVideoSource(encoder, source).then(() => {
      encoder.finalize().then(() => {
        isFinalized = true;
      }).catch((error) => {
        streamError = error;
      });
    }).catch((error) => {
      streamError = error;
    });

    // チャンクを順次yield
    while (!isFinalized && !streamError) {
      if (chunks.length > 0) {
        yield chunks.shift()!;
      } else {
        // 少し待ってから再チェック
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    // 残りのチャンクをyield
    while (chunks.length > 0) {
      yield chunks.shift()!;
    }

    if (streamError) {
      throw streamError;
    }

  } catch (error) {
    if (options?.onError) {
      options.onError(error as Error);
    }
    throw error;
  }
}

/**
 * エンコード可能性の検証
 * 
 * @param options エンコードオプション
 * @returns エンコード可能かどうか
 */
export async function canEncode(options?: EncodeOptions): Promise<boolean> {
  try {
    // WebCodecsのサポート確認
    if (!WebCodecsEncoder.isSupported()) {
      return false;
    }

    // 指定されたコーデックのサポート確認
    if (options?.video?.codec) {
      const testConfig: VideoEncoderConfig = {
        codec: getCodecString(options.video.codec),
        width: 640,
        height: 480,
        bitrate: 1_000_000,
        framerate: 30,
      };

      try {
        const isSupported = await VideoEncoder.isConfigSupported(testConfig);
        if (!isSupported.supported) {
          return false;
        }
      } catch {
        return false;
      }
    }

    if (options?.audio && typeof options.audio === 'object' && options.audio.codec) {
      const testConfig: AudioEncoderConfig = {
        codec: options.audio.codec === 'aac' ? 'mp4a.40.2' : 'opus',
        sampleRate: options.audio.sampleRate || 48000,
        numberOfChannels: options.audio.channels || 2,
        bitrate: options.audio.bitrate || 128_000,
      };

      try {
        const isSupported = await AudioEncoder.isConfigSupported(testConfig);
        if (!isSupported.supported) {
          return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * ビデオソースを処理してエンコーダーにフレームを送信
 */
async function processVideoSource(encoder: WebCodecsEncoder, source: VideoSource): Promise<void> {
  if (Array.isArray(source)) {
    // 静的フレーム配列の処理
    for (const frame of source) {
      await addFrameToEncoder(encoder, frame);
    }
  } else if (source instanceof MediaStream) {
    // MediaStreamの処理
    await processMediaStream(encoder, source);
  } else if ('file' in source) {
    // VideoFileの処理
    await processVideoFile(encoder, source);
  } else if (Symbol.asyncIterator in source) {
    // AsyncIterableの処理
    for await (const frame of source) {
      await addFrameToEncoder(encoder, frame);
    }
  } else {
    throw new WebCodecsEncoderError(
      EncoderErrorType.NotSupported,
      'Unsupported video source type'
    );
  }
}

/**
 * MediaStreamを処理してフレームを抽出
 */
async function processMediaStream(encoder: WebCodecsEncoder, stream: MediaStream): Promise<void> {
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];

  if (!videoTrack) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.ValidationError,
      'MediaStream must contain at least one video track'
    );
  }

  try {
    // MediaStreamTrackProcessorのサポート確認
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      throw new WebCodecsEncoderError(
        EncoderErrorType.NotSupported,
        'MediaStreamTrackProcessor is not supported in this browser'
      );
    }

    const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    const videoReader = videoProcessor.readable.getReader();

    let audioProcessor: any = null;
    let audioReader: ReadableStreamDefaultReader<any> | null = null;

    if (audioTrack) {
      audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
      audioReader = audioProcessor.readable.getReader();
    }

    const processVideo = async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await videoReader.read();
          if (done) break;
          
          await encoder.addVideoFrame(value);
          value.close(); // リソースの解放
        }
      } finally {
        videoReader.releaseLock();
      }
    };

    const processAudio = async () => {
      if (!audioReader) return;
      
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await audioReader.read();
          if (done) break;
          
          await encoder.addAudioData(value);
          value.close(); // リソースの解放
        }
      } finally {
        audioReader.releaseLock();
      }
    };

    // ビデオとオーディオを並行処理
    await Promise.all([
      processVideo(),
      audioTrack ? processAudio() : Promise.resolve()
    ]);

  } catch (error) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.EncodingFailed,
      `Failed to process MediaStream: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * VideoFileを処理してフレームを抽出
 */
async function processVideoFile(encoder: WebCodecsEncoder, videoFile: { file: File | Blob; type: string }): Promise<void> {
  try {
    // Blobからオブジェクトロール作成
    const url = URL.createObjectURL(videoFile.file);
    const video = document.createElement('video');
    
    return new Promise((resolve, reject) => {
      video.onloadedmetadata = async () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          if (!ctx) {
            throw new WebCodecsEncoderError(
              EncoderErrorType.EncodingFailed,
              'Failed to get canvas context for video processing'
            );
          }

          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;

          const duration = video.duration;
          const frameRate = 30; // デフォルトフレームレート
          const totalFrames = Math.floor(duration * frameRate);

          for (let i = 0; i < totalFrames; i++) {
            const time = (i / frameRate);
            video.currentTime = time;
            
            // seekedイベントを待つ
            await new Promise<void>((seekResolve) => {
              video.onseeked = () => seekResolve();
            });

            // キャンバスにフレームを描画
            ctx.drawImage(video, 0, 0);
            
            // エンコーダーにフレームを追加
            await encoder.addCanvasFrame(canvas);
          }

          URL.revokeObjectURL(url);
          resolve();
        } catch (error) {
          URL.revokeObjectURL(url);
          reject(error);
        }
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new WebCodecsEncoderError(
          EncoderErrorType.EncodingFailed,
          'Failed to load video file'
        ));
      };

      video.src = url;
      video.load();
    });

  } catch (error) {
    throw new WebCodecsEncoderError(
      EncoderErrorType.EncodingFailed,
      `Failed to process VideoFile: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * フレームをエンコーダーに追加
 */
async function addFrameToEncoder(encoder: WebCodecsEncoder, frame: Frame): Promise<void> {
  if (frame instanceof VideoFrame) {
    await encoder.addVideoFrame(frame);
  } else if (frame instanceof HTMLCanvasElement || frame instanceof OffscreenCanvas) {
    await encoder.addCanvasFrame(frame);
  } else if (frame instanceof ImageBitmap) {
    // ImageBitmapの場合はVideoFrameに変換
    const videoFrame = new VideoFrame(frame);
    try {
      await encoder.addVideoFrame(videoFrame);
    } finally {
      videoFrame.close();
    }
  } else {
    // ImageDataの場合はCanvasを経由してVideoFrameに変換
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(frame, 0, 0);
      await encoder.addCanvasFrame(canvas);
    } else {
      throw new WebCodecsEncoderError(
        EncoderErrorType.EncodingFailed,
        'Failed to get canvas context for ImageData conversion'
      );
    }
  }
}

/**
 * 設定の推定と正規化
 */
async function inferAndBuildConfig(source: VideoSource, options?: EncodeOptions): Promise<EncoderConfig> {
  // 最初のフレームから基本情報を取得
  const firstFrame = await getFirstFrame(source);
  const { width: inferredWidth, height: inferredHeight } = getFrameDimensions(firstFrame);
  
  // 品質プリセットの適用
  const qualityConfig = applyQualityPreset(options?.quality || 'medium', inferredWidth, inferredHeight);
  
  // 最終設定の構築
  const config: EncoderConfig = {
    width: options?.width || inferredWidth,
    height: options?.height || inferredHeight,
    frameRate: options?.frameRate || 30,
    videoBitrate: options?.video?.bitrate || qualityConfig.videoBitrate,
    audioBitrate: options?.audio === false ? 0 : (typeof options?.audio === 'object' ? options.audio.bitrate || qualityConfig.audioBitrate : qualityConfig.audioBitrate),
    sampleRate: options?.audio === false ? 0 : (typeof options?.audio === 'object' ? options.audio.sampleRate || 48000 : 48000),
    channels: options?.audio === false ? 0 : (typeof options?.audio === 'object' ? options.audio.channels || 2 : 2),
    container: options?.container || 'mp4',
    codec: {
      video: options?.video?.codec || (options?.container === 'webm' ? 'vp9' : 'avc'),
      audio: options?.audio === false ? undefined : (typeof options?.audio === 'object' && options.audio.codec ? options.audio.codec : (options?.container === 'webm' ? 'opus' : 'aac')),
    },
    latencyMode: options?.video?.latencyMode || 'quality',
    hardwareAcceleration: options?.video?.hardwareAcceleration || 'prefer-hardware',
    keyFrameInterval: options?.video?.keyFrameInterval,
    audioBitrateMode: options?.audio === false ? undefined : (typeof options?.audio === 'object' ? options.audio.bitrateMode : undefined),
  };

  return config;
}

/**
 * ソースから最初のフレームを取得
 */
async function getFirstFrame(source: VideoSource): Promise<Frame | null> {
  if (Array.isArray(source)) {
    return source[0] || null;
  } else if (source instanceof MediaStream) {
    // MediaStreamの場合は、基本的な解像度情報を取得
    const videoTrack = source.getVideoTracks()[0];
    if (videoTrack) {
      // MediaStreamは後で別途処理
      return null;
    }
    return null;
  } else if ('file' in source) {
    // VideoFileの場合も同様に、事前にフレーム取得は困難
    return null;
  } else if (Symbol.asyncIterator in source) {
    const iterator = source[Symbol.asyncIterator]();
    const result = await iterator.next();
    return result.done ? null : result.value;
  }
  return null;
}

/**
 * フレームから寸法を取得
 */
function getFrameDimensions(frame: Frame | null): { width: number; height: number } {
  if (!frame) {
    return { width: 1920, height: 1080 };
  }

  if (frame instanceof VideoFrame) {
    return { 
      width: frame.displayWidth || frame.codedWidth, 
      height: frame.displayHeight || frame.codedHeight 
    };
  } else if (frame instanceof HTMLCanvasElement || frame instanceof OffscreenCanvas) {
    return { width: frame.width, height: frame.height };
  } else if (frame instanceof ImageBitmap) {
    return { width: frame.width, height: frame.height };
  } else if (frame instanceof ImageData) {
    return { width: frame.width, height: frame.height };
  }

  return { width: 1920, height: 1080 };
}

/**
 * 品質プリセットを適用
 */
function applyQualityPreset(quality: QualityPreset, width: number, height: number) {
  const pixels = width * height;
  
  const qualityMultipliers = {
    'low': 0.05,
    'medium': 0.1,
    'high': 0.2,
    'lossless': 0.5,
  };
  
  const baseVideoBitrate = Math.min(pixels * qualityMultipliers[quality], 50_000_000);
  const baseAudioBitrate = quality === 'low' ? 64_000 : quality === 'high' ? 192_000 : 128_000;
  
  return {
    videoBitrate: Math.floor(baseVideoBitrate),
    audioBitrate: baseAudioBitrate,
  };
}

/**
 * コーデック文字列を取得
 */
function getCodecString(codec: string): string {
  const codecMap: Record<string, string> = {
    'avc': 'avc1.42E01E',
    'hevc': 'hev1.1.6.L93.B0',
    'vp8': 'vp8',
    'vp9': 'vp09.00.10.08',
    'av1': 'av01.0.04M.08',
  };
  
  return codecMap[codec] || codec;
} 