/**
 * Core encode function implementation
 */

import {
  VideoSource,
  EncodeOptions,
  EncodeError,
  Frame,
  ProgressInfo,
  VideoFile,
} from "../types";
import { inferAndBuildConfig } from "../utils/config-parser";
import { WorkerCommunicator } from "../worker/worker-communicator";
import { convertToVideoFrame } from "../utils/video-frame-converter";

/**
 * Main video encoding function
 *
 * @param source Video source to encode
 * @param options Encoding options
 * @returns Encoded binary data
 */
export async function encode(
  source: VideoSource,
  options?: EncodeOptions,
): Promise<Uint8Array> {
  let communicator: WorkerCommunicator | null = null;

  try {
    // Configuration inference and normalization
    const config = await inferAndBuildConfig(source, options);

    // Start communication with worker
    communicator = new WorkerCommunicator();

    // Execute encoding process
    const result = await performEncoding(communicator, source, config, options);

    return result;
  } catch (error) {
    // Unified error handling
    const encodeError =
      error instanceof EncodeError
        ? error
        : new EncodeError(
            "encoding-failed",
            `Encoding failed: ${error instanceof Error ? error.message : String(error)}`,
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
 * Execute the actual encoding process
 */
async function performEncoding(
  communicator: WorkerCommunicator,
  source: VideoSource,
  config: any,
  options?: EncodeOptions,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let processedFrames = 0;
    let totalFrames: number | undefined;
    const startTime = Date.now();

    // Calculate totalFrames upfront for progress tracking
    calculateTotalFrames(source, config)
      .then((frames) => {
        totalFrames = frames;
      })
      .catch((error) => {
        console.warn("Failed to calculate total frames:", error);
      });

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

    // Handle messages from worker
    communicator.on("initialized", () => {
      updateProgress("encoding");
      // Start frame processing
      processVideoSource(communicator, source, config)
        .then(() => {
          updateProgress("finalizing");
          communicator.send("finalize");
        })
        .catch(reject);
    });

    communicator.on(
      "progress",
      (data: { processedFrames: number; totalFrames?: number }) => {
        processedFrames = data.processedFrames;
        if (data.totalFrames !== undefined) {
          totalFrames = data.totalFrames;
        }
        updateProgress("encoding");
      },
    );

    communicator.on("finalized", (data: { output: Uint8Array | null }) => {
      if (data.output) {
        updateProgress("finalizing");
        resolve(data.output);
      } else {
        reject(new EncodeError("encoding-failed", "No output produced"));
      }
    });

    communicator.on("error", (data: { errorDetail: any }) => {
      const error = new EncodeError(
        data.errorDetail.type || "encoding-failed",
        data.errorDetail.message || "Worker error",
        data.errorDetail,
      );
      reject(error);
    });

    // Start encoding
    communicator.send("initialize", { config, totalFrames });
  });
}

/**
 * Process VideoSource and send to worker
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
    // Process MediaStream
    await processMediaStream(communicator, source, config);
  } else if (Symbol.asyncIterator in source) {
    // Process AsyncIterable
    await processAsyncIterable(communicator, source, config);
  } else {
    // Process VideoFile
    await processVideoFile(communicator, source as VideoFile, config);
  }
}

/**
 * Process frame array
 */
async function processFrameArray(
  communicator: WorkerCommunicator,
  frames: Frame[],
  config?: any,
): Promise<void> {
  const frameRate = config?.frameRate || 30;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const timestamp = (i * 1000000) / frameRate; // Use frameRate from config

    await addFrameToWorker(communicator, frame, timestamp);
  }
}

/**
 * Process AsyncIterable
 */
async function processAsyncIterable(
  communicator: WorkerCommunicator,
  source: AsyncIterable<Frame>,
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
 * Process MediaStream
 */
async function processMediaStream(
  communicator: WorkerCommunicator,
  stream: MediaStream,
  _config: any,
): Promise<void> {
  // MediaStream processing is complex, so use MediaStreamTrackProcessor
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

      processingPromises.push(processVideoReader(communicator, reader));
    }

    // Process audio tracks
    if (audioTracks.length > 0) {
      const audioTrack = audioTracks[0];
      const processor = new MediaStreamTrackProcessor({ track: audioTrack });
      const reader =
        processor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
      readers.push(reader);

      processingPromises.push(processAudioReader(communicator, reader));
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
 * Process VideoFrame reader
 */
async function processVideoReader(
  communicator: WorkerCommunicator,
  reader: ReadableStreamDefaultReader<VideoFrame>,
): Promise<void> {
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
      `Video stream processing error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Process AudioData reader
 */
async function processAudioReader(
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
      `Audio stream processing error: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

/**
 * Send frame to worker
 */
async function addFrameToWorker(
  communicator: WorkerCommunicator,
  frame: Frame,
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
 * Process VideoFile and extract frames
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
      try {
        const timestampSeconds = Math.min(
          duration || 0,
          frameIndex / frameRate,
        );
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
      } catch (frameError) {
        throw new EncodeError(
          "video-encoding-error",
          `Failed to process frame ${frameIndex}: ${frameError instanceof Error ? frameError.message : String(frameError)}`,
          frameError,
        );
      }
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
 * Process audio data from AudioBuffer and send to worker
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

  // Split audio data into appropriate chunk sizes
  // Use smaller chunk sizes for better memory efficiency
  const chunkDurationMs = Math.min(20, 1000 / frameRate); // 20ms or frame duration, whichever is smaller
  const samplesPerChunk = Math.floor((sampleRate * chunkDurationMs) / 1000);

  for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
    const remainingSamples = Math.min(samplesPerChunk, totalSamples - offset);
    const timestamp = (offset / sampleRate) * 1000000; // microseconds

    // Get channel data
    const channelData: Float32Array[] = [];
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const sourceData = audioBuffer.getChannelData(channel);
      const chunkData = new Float32Array(remainingSamples);
      chunkData.set(sourceData.subarray(offset, offset + remainingSamples));
      channelData.push(chunkData);
    }

    try {
      // Create AudioData and send to worker
      // Convert to interleaved format
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

      // Release channel data for memory efficiency
      channelData.length = 0;
    } catch (error) {
      console.warn("Failed to create AudioData chunk:", error);
    }
  }
}

/**
 * Calculate total frames for different video sources
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
    console.warn("Failed to calculate total frames:", error);
    return undefined;
  }
}
