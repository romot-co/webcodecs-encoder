/**
 * Streaming encode function implementation
 */

import {
  VideoSource,
  EncodeOptions,
  EncodeError,
  ProgressInfo,
  VideoFile,
} from "../types";
import { inferAndBuildConfig } from "../utils/config-parser";
import { WorkerCommunicator } from "../worker/worker-communicator";
import { convertToVideoFrame } from "../utils/video-frame-converter";

/**
 * Streaming encode function
 *
 * @param source Video source to encode
 * @param options Encoding options
 * @returns AsyncGenerator of encoded chunks
 */
export async function* encodeStream(
  source: VideoSource,
  options?: EncodeOptions,
): AsyncGenerator<Uint8Array> {
  let communicator: WorkerCommunicator | null = null;
  const chunks: Uint8Array[] = [];
  let isFinalized = false;
  let streamError: EncodeError | null = null;
  let processedFrames = 0;
  let totalFrames: number | undefined;
  const startTime = Date.now();

  try {
    // Configuration inference and normalization (prioritize realtime mode)
    const baseConfig = await inferAndBuildConfig(source, options);
    const config = { ...baseConfig, latencyMode: "realtime" as const }; // Force setting for streaming

    // Calculate totalFrames upfront for progress tracking
    try {
      totalFrames = await calculateTotalFrames(source, config);
    } catch (error) {
      console.warn("Failed to calculate total frames for streaming:", error);
    }

    // Start communication with worker
    communicator = new WorkerCommunicator();

    // Update progress information
    const updateProgress = (stage: string) => {
      if (options?.onProgress) {
        const elapsed = Date.now() - startTime;
        const fps =
          processedFrames > 0 ? (processedFrames / elapsed) * 1000 : 0;
        const percent = totalFrames ? (processedFrames / totalFrames) * 100 : 0;
        const estimatedRemainingMs =
          totalFrames && fps > 0
            ? ((totalFrames - processedFrames) / fps) * 1000
            : undefined;

        const progressInfo: ProgressInfo = {
          percent,
          processedFrames,
          totalFrames,
          fps,
          stage,
          estimatedRemainingMs,
        };

        options.onProgress(progressInfo);
      }
    };

    // Manage encoding process start with Promise
    const encodingPromise = new Promise<void>((resolve, reject) => {
      // Handle messages from worker
      communicator!.on("initialized", () => {
        updateProgress("streaming");
        // Start frame processing
        processVideoSource(communicator!, source, config)
          .then(() => {
            updateProgress("finalizing");
            communicator!.send("finalize");
          })
          .catch(reject);
      });

      communicator!.on(
        "progress",
        (data: { processedFrames: number; totalFrames?: number }) => {
          processedFrames = data.processedFrames;
          if (data.totalFrames !== undefined) {
            totalFrames = data.totalFrames;
          }
          updateProgress("streaming");
        },
      );

      communicator!.on("dataChunk", (data: { chunk: Uint8Array }) => {
        chunks.push(data.chunk);
      });

      communicator!.on("finalized", () => {
        isFinalized = true;
        updateProgress("finalizing");
        resolve();
      });

      communicator!.on("error", (data: { errorDetail: any }) => {
        streamError = new EncodeError(
          data.errorDetail.type || "encoding-failed",
          data.errorDetail.message || "Worker error",
          data.errorDetail,
        );
        reject(streamError);
      });

      // Start encoding
      communicator!.send("initialize", { config, totalFrames });
    });

    // Error handling for encoding process
    // Note: Don't use .catch() here as it would swallow the error
    // Instead, let errors propagate and handle them later

    // Yield chunks sequentially
    while (!isFinalized && !streamError) {
      if (chunks.length > 0) {
        const chunk = chunks.shift()!;
        yield chunk;
      } else {
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // Yield remaining chunks
    while (chunks.length > 0) {
      const chunk = chunks.shift()!;
      yield chunk;
    }

    // Throw exception if error occurred
    if (streamError) {
      throw streamError;
    }

    // Wait for encoding process completion
    try {
      await encodingPromise;
    } catch (error) {
      // If error occurred during encoding process
      const encodeError =
        error instanceof EncodeError
          ? error
          : new EncodeError(
              "encoding-failed",
              `Streaming failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            );

      if (options?.onError) {
        options.onError(encodeError);
      }

      throw encodeError;
    }
  } catch (error) {
    // Unified error handling
    const encodeError =
      error instanceof EncodeError
        ? error
        : new EncodeError(
            "encoding-failed",
            `Stream encoding failed: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );

    if (options?.onError) {
      options.onError(encodeError);
    }

    throw encodeError;
  } finally {
    // Resource cleanup
    if (communicator) {
      communicator.terminate();
    }
  }
}

/**
 * Process VideoSource and send to worker (for streaming)
 */
async function processVideoSource(
  communicator: WorkerCommunicator,
  source: VideoSource,
  config: any,
): Promise<void> {
  if (Array.isArray(source)) {
    // Process static frame array
    await processFrameArray(communicator, source, config);
  } else if (source instanceof MediaStream) {
    // Process MediaStream (realtime)
    await processMediaStreamRealtime(communicator, source, config);
  } else if (Symbol.asyncIterator in source) {
    // Process AsyncIterable
    await processAsyncIterable(communicator, source, config);
  } else {
    // Process VideoFile
    await processVideoFile(communicator, source as VideoFile, config);
  }
}

/**
 * Process frame array (for streaming)
 */
async function processFrameArray(
  communicator: WorkerCommunicator,
  frames: import("../types").Frame[],
  config?: any,
): Promise<void> {
  const frameRate = config?.frameRate || 30;
  const frameDelay = 1000 / frameRate;

  let lastFrameTime = performance.now();

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const timestamp = (i * 1000000) / frameRate;

    await addFrameToWorker(communicator, frame, timestamp);

    const now = performance.now();
    const elapsedTime = now - lastFrameTime;
    const delay = Math.max(0, frameDelay - elapsedTime);

    await new Promise((resolve) => setTimeout(resolve, delay));
    lastFrameTime = performance.now();
  }
}

/**
 * Process AsyncIterable (for streaming)
 */
async function processAsyncIterable(
  communicator: WorkerCommunicator,
  source: AsyncIterable<import("../types").Frame>,
  config?: any,
): Promise<void> {
  let frameIndex = 0;
  const frameRate = config?.frameRate || 30;

  for await (const frame of source) {
    const timestamp = (frameIndex * 1000000) / frameRate; // Use frameRate from config
    await addFrameToWorker(communicator, frame, timestamp);
    frameIndex++;
  }
}

/**
 * Process MediaStream in realtime
 */
async function processMediaStreamRealtime(
  communicator: WorkerCommunicator,
  stream: MediaStream,
  config: any,
): Promise<void> {
  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();

  const readers: ReadableStreamDefaultReader<any>[] = [];
  const processingPromises: Promise<void>[] = [];

  try {
    // Process video tracks
    if (videoTracks.length > 0) {
      const videoTrack = videoTracks[0];
      const processor = new MediaStreamTrackProcessor({ track: videoTrack });
      const reader =
        processor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;
      readers.push(reader);

      processingPromises.push(
        processVideoTrackRealtime(communicator, reader, config),
      );
    }

    // Process audio tracks
    if (audioTracks.length > 0) {
      const audioTrack = audioTracks[0];
      const processor = new MediaStreamTrackProcessor({ track: audioTrack });
      const reader =
        processor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
      readers.push(reader);

      processingPromises.push(processAudioTrackRealtime(communicator, reader));
    }

    // Wait for all processing to complete
    await Promise.all(processingPromises);
  } finally {
    // Clean up readers
    for (const reader of readers) {
      try {
        reader.cancel();
      } catch (e) {
        // Ignore errors (may already be cancelled)
      }
    }
  }
}

/**
 * Process VideoTrack in realtime
 */
async function processVideoTrackRealtime(
  communicator: WorkerCommunicator,
  reader: ReadableStreamDefaultReader<VideoFrame>,
  _config: any,
): Promise<void> {
  // Frame drop functionality planned for future implementation
  // const maxQueueDepth = config.maxQueueDepth || 10;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;

      try {
        await addFrameToWorker(communicator, value, value.timestamp || 0);
      } finally {
        value.close();
      }
    }
  } catch (error) {
    throw new EncodeError(
      "video-encoding-error",
      `Real-time video stream processing error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Process AudioTrack in realtime
 */
async function processAudioTrackRealtime(
  communicator: WorkerCommunicator,
  reader: ReadableStreamDefaultReader<AudioData>,
): Promise<void> {
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;

      try {
        communicator.send("addAudioData", {
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
  } catch (error) {
    throw new EncodeError(
      "audio-encoding-error",
      `Real-time audio stream processing error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Send frame to worker
 */
async function addFrameToWorker(
  communicator: WorkerCommunicator,
  frame: import("../types").Frame,
  timestamp: number,
): Promise<void> {
  // Convert frame to VideoFrame
  const videoFrame = await convertToVideoFrame(frame, timestamp);

  try {
    communicator.send("addVideoFrame", {
      frame: videoFrame,
      timestamp,
    });
  } finally {
    // convertToVideoFrame always returns a new VideoFrame that we own
    videoFrame.close();
  }
}

/**
 * Process VideoFile and extract frames (for streaming)
 */
async function processVideoFile(
  communicator: WorkerCommunicator,
  videoFile: VideoFile,
  config: any,
): Promise<void> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";

  let objectUrl: string | null = null;
  let audioContext: AudioContext | null = null;

  try {
    objectUrl = URL.createObjectURL(videoFile.file);
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      const handleLoaded = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error("Failed to load video file"));
      };
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
      };
      video.onloadedmetadata = handleLoaded;
      video.onerror = handleError;
    });

    const { duration, videoWidth, videoHeight } = video;
    const frameRate =
      config.frameRate && config.frameRate > 0 ? config.frameRate : 30;
    const totalFrames = Math.max(1, Math.floor(duration * frameRate) || 1);

    if (config.audioBitrate > 0 && typeof AudioContext !== "undefined") {
      try {
        audioContext = new AudioContext();
        const arrayBuffer = await videoFile.file.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        await processAudioFromFile(
          communicator,
          audioBuffer,
          duration,
          frameRate,
        );
      } catch (audioError) {
        console.warn("Failed to process audio from VideoFile:", audioError);
      }
    }

    const targetWidth =
      config.width && config.width > 0 ? config.width : videoWidth || 640;
    const targetHeight =
      config.height && config.height > 0 ? config.height : videoHeight || 480;

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new EncodeError(
        "initialization-failed",
        "Failed to get canvas context",
      );
    }

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const timestampSeconds = Math.min(duration || 0, frameIndex / frameRate);
      video.currentTime = Number.isFinite(timestampSeconds)
        ? timestampSeconds
        : 0;

      await new Promise<void>((resolve, reject) => {
        const handleSeeked = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error("Video seek failed"));
        };
        const cleanup = () => {
          video.removeEventListener("seeked", handleSeeked);
          video.removeEventListener("error", handleError);
        };
        video.addEventListener("seeked", handleSeeked, { once: true });
        video.addEventListener("error", handleError, { once: true });
      });

      ctx.drawImage(
        video,
        0,
        0,
        videoWidth || canvas.width,
        videoHeight || canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );

      const chunkTimestamp = Math.round(frameIndex * (1_000_000 / frameRate));
      await addFrameToWorker(communicator, canvas, chunkTimestamp);

      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  } catch (error) {
    throw new EncodeError(
      "invalid-input",
      `VideoFile processing failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    if (audioContext) {
      try {
        await audioContext.close();
      } catch (closeError) {
        console.warn("Failed to close AudioContext", closeError);
      }
    }

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    video.src = "";
    video.remove();
  }
}

/**
 * Process audio data from AudioBuffer and send to worker (for streaming)
 */
async function processAudioFromFile(
  communicator: WorkerCommunicator,
  audioBuffer: AudioBuffer,
  duration: number,
  frameRate: number,
): Promise<void> {
  const sampleRate = audioBuffer.sampleRate;
  const numberOfChannels = audioBuffer.numberOfChannels;
  const totalSamples = audioBuffer.length;

  const chunkDurationMs = Math.min(20, 1000 / frameRate);
  const samplesPerChunk = Math.floor((sampleRate * chunkDurationMs) / 1000);

  for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
    const remainingSamples = Math.min(samplesPerChunk, totalSamples - offset);
    const timestamp = (offset / sampleRate) * 1000000;

    const channelData: Float32Array[] = [];
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sourceData = audioBuffer.getChannelData(channel);
      const chunkData = new Float32Array(remainingSamples);
      chunkData.set(sourceData.subarray(offset, offset + remainingSamples));
      channelData.push(chunkData);
    }

    try {
      const interleavedData = new Float32Array(
        remainingSamples * numberOfChannels,
      );
      for (let frame = 0; frame < remainingSamples; frame++) {
        for (let channel = 0; channel < numberOfChannels; channel++) {
          interleavedData[frame * numberOfChannels + channel] =
            channelData[channel][frame];
        }
      }

      const audioData = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: remainingSamples,
        numberOfChannels,
        timestamp,
        data: interleavedData,
      });

      communicator.send("addAudioData", {
        audio: audioData,
        timestamp,
        format: "f32",
        sampleRate,
        numberOfFrames: remainingSamples,
        numberOfChannels,
      });

      audioData.close();
      channelData.length = 0;
    } catch (error) {
      console.warn("Failed to create AudioData chunk:", error);
    }

    // Don't block main thread
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Calculate total frames for different video sources (streaming)
 */
async function calculateTotalFrames(
  source: VideoSource,
  config: any,
): Promise<number | undefined> {
  try {
    if (Array.isArray(source)) {
      // Static frame array
      return source.length;
    } else if (source instanceof MediaStream) {
      // MediaStream - cannot predict total frames
      return undefined;
    } else if (Symbol.asyncIterator in source) {
      // AsyncIterable - cannot predict total frames
      return undefined;
    } else {
      // VideoFile - calculate from duration and frame rate
      const videoFile = source as VideoFile;
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "metadata";

      const objectUrl = URL.createObjectURL(videoFile.file);
      video.src = objectUrl;

      try {
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () =>
            reject(new Error("Failed to load video metadata"));
        });

        const frameRate = config.frameRate || 30;
        const totalFrames = Math.floor(video.duration * frameRate);

        URL.revokeObjectURL(objectUrl);
        return totalFrames;
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
    }
  } catch (error) {
    console.warn("Failed to calculate total frames for streaming:", error);
    return undefined;
  }
}
