# WebCodecs MP4/WebM Encoder (MP4 & WebM Muxers)

A TypeScript library to encode video (H.264/AVC, VP9, VP8) and audio (AAC, Opus) using the WebCodecs API and mux them into MP4 or WebM containers.

## Features

- Encodes `VideoFrame` to H.264/AVC, VP9, or AV1 video. Use `addCanvasFrame` to pass a `HTMLCanvasElement` or `OffscreenCanvas` directly.
- Encodes `AudioBuffer` to AAC or Opus audio.
- Muxes encoded video and audio into standard MP4 or WebM files.
- Real-time streaming: Delivers muxed data in chunks via a callback, suitable for live streaming with Media Source Extensions (MSE).
- Optional AudioWorklet path for piping audio directly to the worker to reduce main-thread latency.
- Uses Web Workers to offload encoding tasks from the main thread.
- Provides progress callbacks and cancellation support.
- Built with TypeScript, providing type definitions.
- Automatic codec fallback (e.g., VP9 to AVC, Opus to AAC) and AVC profile fallback (High → Main → Baseline) if the preferred options are unsupported.
- Queue management with `dropFrames` and `maxQueueDepth` to control encoder backlog.
- Method Chaining API: Fluent interface for more readable and chainable configuration.
- Progress Monitoring: Detailed progress information including processing speed, queue sizes, and estimated completion time.
- Comprehensive Input Validation: Validates configuration parameters to catch errors early.

## Installation

### From GitHub (Current)

```bash
npm install github:romot-co/webcodecs-encoder
# or
yarn add github:romot-co/webcodecs-encoder
```

### From npm (Coming Soon)

```bash
npm install webcodecs-encoder
# or
yarn add webcodecs-encoder
```

Running `npm install` will automatically run the `postinstall` script, applying a patch to `@types/dom-webcodecs` via `patch-package`. This patch restores the `AudioSampleFormat` type that is commented out in the published definitions.

## ✨ Zero-Config Setup (Automatic)

The package automatically attempts to copy the worker file to your `public/` directory during installation. In most cases, no additional setup is required!

```typescript
import { WebCodecsEncoder } from 'webcodecs-encoder';

// Works automatically - no additional setup needed!
const encoder = new WebCodecsEncoder(config);
await encoder.initialize(); // Worker file found automatically
```

## Manual Setup (if needed)

If automatic setup didn't work or you need custom configuration:

### Copy Worker File Manually

```bash
# Copy to your public directory
cp node_modules/webcodecs-encoder/dist/worker.js public/webcodecs-worker.js
```

### Or Specify Custom Worker URL

```typescript
import { WebCodecsEncoder } from 'webcodecs-encoder';

const encoder = new WebCodecsEncoder(config);
await encoder.initialize({
  workerScriptUrl: '/custom-path/worker.js', // Custom worker location
  // ... other options
});
```

### Troubleshooting Worker Issues

The encoder automatically tries these locations:
1. `/worker.js` (copied by postinstall script)
2. `/webcodecs-worker.js` (alternative location)  
3. Package worker file (fallback, may require CORS setup)
4. Inline helper (shows setup instructions if above fail)

## Basic Usage

### Traditional API (Constructor-based)

You can find this example in [`examples/encode-to-file.ts`](examples/encode-to-file.ts) for a quick way to try it out.

```typescript
import { WebCodecsEncoder } from "webcodecs-encoder";

async function encodeVideoToFile() {
  if (!WebCodecsEncoder.isSupported()) {
    console.error("WebCodecs or Workers not supported.");
    return;
  }

  const config = {
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: 2_000_000, // 2 Mbps
    audioBitrate: 128_000, // 128 kbps
    sampleRate: 48000, // Recommended: 48000 for Opus
    channels: 2,
    hardwareAcceleration: 'prefer-hardware', // Optional
  };

  const encoder = new WebCodecsEncoder(config);

  try {
    await encoder.initialize({
      onProgress: (processedFrames, totalFrames) => {
        console.log(`Progress (File): ${processedFrames}/${totalFrames}`);
      },
      totalFrames: 300, // Optional: for progress calculation
    });

    const canvas = document.createElement("canvas");
    canvas.width = config.width;
    canvas.height = config.height;
    const ctx = canvas.getContext("2d");

    // Example: Encode 300 frames
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `hsl(${(i * 5) % 360}, 100%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "white";
      ctx.font = "50px Arial";
      ctx.fillText(`Frame ${i + 1}`, 50, 100);

      await encoder.addCanvasFrame(canvas);
    }

    // Example: Create a silent audio track
    const audioContext = new AudioContext({ sampleRate: config.sampleRate });
    const silentAudioBuffer = audioContext.createBuffer(
      config.channels,
      audioContext.sampleRate * (300 / config.frameRate), // duration matching video
      audioContext.sampleRate,
    );
    await encoder.addAudioBuffer(silentAudioBuffer);

    const uint8Array = await encoder.finalize();
    console.log("Encoding finished! MP4 size:", uint8Array.byteLength);

    // Download the MP4
    const blob = new Blob([uint8Array], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "encoded_video.mp4";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Encoding failed:", error);
  }
}

encodeVideoToFile();
```

### Method Chaining API (Fluent Interface)

For a more modern and readable approach, you can use the new method chaining API:

```typescript
import { WebCodecsEncoder } from "webcodecs-encoder";

async function encodeVideoWithMethodChaining() {
  if (!WebCodecsEncoder.isSupported()) {
    console.error("WebCodecs or Workers not supported.");
    return;
  }

  const encoder = WebCodecsEncoder.create()
    .configure({
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitrate: 2_000_000,
      audioBitrate: 128_000,
      sampleRate: 48000,
      channels: 2,
      hardwareAcceleration: 'prefer-hardware'
    })
    .withTotalFrames(300)
    .onProgress((frames, total) => {
      const percentage = total ? (frames / total) * 100 : 0;
      console.log(`Progress: ${percentage.toFixed(1)}%`);
    })
    .onDetailedProgress((progress) => {
      console.log(`Stage: ${progress.stage}, Speed: ${progress.averageProcessingFps.toFixed(1)} fps`);
      if (progress.estimatedRemainingMs) {
        console.log(`ETA: ${Math.round(progress.estimatedRemainingMs / 1000)}s`);
      }
    })
    .onError((error) => {
      console.error(`Encoding error [${error.type}]:`, error.message);
    });

  try {
    await encoder.start();

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");

    // Encode frames
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `hsl(${(i * 5) % 360}, 100%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "white";
      ctx.font = "50px Arial";
      ctx.fillText(`Frame ${i + 1}`, 50, 100);

      await encoder.addCanvasFrame(canvas);
    }

    // Add audio
    const audioContext = new AudioContext({ sampleRate: 48000 });
    const silentAudioBuffer = audioContext.createBuffer(2, audioContext.sampleRate * 10, audioContext.sampleRate);
    await encoder.addAudioBuffer(silentAudioBuffer);

    const result = await encoder.finish();
    console.log("Encoding complete! Size:", result.byteLength);

    // Download the file
    const blob = new Blob([result], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "encoded_video.mp4";
    a.click();
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error("Encoding failed:", error);
  }
}

encodeVideoWithMethodChaining();
```

### Hardware Acceleration Preference

The `hardwareAcceleration` option hints whether to use hardware or software
codecs when available. If the requested preference isn't supported, the encoder
automatically falls back and logs a warning. Example:

```typescript
const config = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoBitrate: 4_000_000,
  audioBitrate: 192_000,
  sampleRate: 48000,
  channels: 2,
  hardwareAcceleration: 'prefer-software',
};
```


## Generating Video from Images

Decode a sequence of images with `ImageDecoder`, wrap each into a `VideoFrame`,
and feed them to `WebCodecsEncoder`. See
[`examples/image-sequence.ts`](examples/image-sequence.ts) for a runnable
example.

```typescript
import { WebCodecsEncoder } from "webcodecs-encoder";

async function encodeImageSequence(imageUrls: string[]) {
  if (!WebCodecsEncoder.isSupported()) {
    console.error("WebCodecs or Workers not supported.");
    return;
  }

  const config = { width: 1280, height: 720, frameRate: 30 };
  const encoder = new WebCodecsEncoder(config);
  await encoder.initialize({ totalFrames: imageUrls.length });

  for (const [index, url] of imageUrls.entries()) {
    const response = await fetch(url);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const decoder = new ImageDecoder({ data: buffer, type: blob.type });
    const { image } = await decoder.decode();
    const frame = new VideoFrame(image, {
      timestamp: (index * 1_000_000) / config.frameRate,
      duration: 1_000_000 / config.frameRate,
    });
    await encoder.addVideoFrame(frame);
    frame.close();
    image.close();
    decoder.close();
  }

  const result = await encoder.finalize();
  console.log("Encoded MP4 size:", result.byteLength);
}
```

## Real-time Streaming Usage

For applications like live streaming, you can configure the encoder to output data in chunks. This is typically used with Media Source Extensions (MSE) to play the video in an HTML `<video>` element as it's being encoded.
See [`examples/encode-realtime.ts`](examples/encode-realtime.ts) for the full runnable snippet.

```typescript
import { WebCodecsEncoder } from "webcodecs-encoder";

async function encodeVideoRealtime() {
  if (!WebCodecsEncoder.isSupported()) {
    console.error("WebCodecs or Workers not supported.");
    return;
  }

  const config = {
    latencyMode: "realtime", // Enable real-time streaming
    width: 1280,
    height: 720,
    frameRate: 30,
    codec: {
      video: "vp9", // Example: VP9 for lower latency
      audio: "opus",
    },
    videoBitrate: 2_000_000,
    audioBitrate: 128_000,
    sampleRate: 48000,
    channels: 2,
    hardwareAcceleration: 'prefer-hardware',
  };

  let mediaSource;
  let sourceBuffer;
  const videoElement = document.createElement("video");
  videoElement.controls = true;
  document.body.appendChild(videoElement);

  if (
    "MediaSource" in window &&
    MediaSource.isTypeSupported(
      `video/mp4; codecs="${config.codec.video}.0, ${config.codec.audio}"`,
    )
  ) {
    // Basic check
    mediaSource = new MediaSource();
    videoElement.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener("sourceopen", async () => {
      console.log("MediaSource opened");

      await encoder.initialize({
        onData: (chunk, isHeader, container) => {
          if (
            sourceBuffer &&
            !sourceBuffer.updating &&
            mediaSource.readyState == "open"
          ) {
            try {
              sourceBuffer.appendBuffer(chunk);
            } catch (e) {
              console.error("Error appending buffer:", e);
            }
          } else {
            console.warn(
              "SourceBuffer not ready or updating, or MediaSource not open. Skipping append.",
            );
          }
        },
        onProgress: (processedFrames, totalFrames) => {
          console.log(`Progress (Real-time): ${processedFrames}`);
        },
        onError: (error) => {
          console.error(
            "Encoder error during initialization or processing:",
            error,
          );
        },
      });

      // Determine actual codecs used after potential fallbacks
      const actualVideoCodec =
        encoder.getActualVideoCodec() || config.codec.video;
      const actualAudioCodec =
        encoder.getActualAudioCodec() || config.codec.audio;

      try {
        sourceBuffer = mediaSource.addSourceBuffer(
          `video/mp4; codecs="${actualVideoCodec}, ${actualAudioCodec}"`,
        );
        sourceBuffer.mode = "sequence"; // Important for streaming
        console.log("SourceBuffer added");

        sourceBuffer.addEventListener("error", (e) =>
          console.error("SourceBuffer error:", e),
        );
        sourceBuffer.addEventListener("updateend", () => {
          // console.log('SourceBuffer update end');
        });
      } catch (e) {
        console.error("Error adding SourceBuffer:", e);
        return;
      }

      // Start encoding once source buffer is ready
      startEncoding();
    });
    mediaSource.addEventListener("sourceended", () =>
      console.log("MediaSource ended"),
    );
    mediaSource.addEventListener("sourceclose", () =>
      console.log("MediaSource closed"),
    );
  } else {
    console.error("MediaSource or the codec combination is not supported.");
    return;
  }

  // Using traditional API
  const encoder = new WebCodecsEncoder(config);
  
  // Alternative: Method chaining API for real-time streaming
  // const encoder = WebCodecsEncoder.create()
  //   .configure(config)
  //   .onData((chunk, offset, isHeader) => {
  //     if (isHeader) {
  //       console.log("MediaSource header received");
  //     }
  //     if (sourceBuffer && !sourceBuffer.updating && mediaSource.readyState == "open") {
  //       try {
  //         sourceBuffer.appendBuffer(chunk);
  //       } catch (e) {
  //         console.error("Error appending buffer:", e);
  //       }
  //     }
  //   })
  //   .onProgress((processedFrames) => {
  //     console.log(`Progress (Real-time): ${processedFrames}`);
  //   })
  //   .onError((error) => {
  //     console.error("Encoder error:", error);
  //   });

  async function startEncoding() {
    console.log("Starting encoding process...");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = config.width;
      canvas.height = config.height;
      const ctx = canvas.getContext("2d");

      // Example: Encode for 10 seconds (300 frames)
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `hsl(${(i * 1.2) % 360}, 90%, 60%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "black";
        ctx.font = "40px Arial";
        ctx.fillText(`Live Frame ${i + 1}`, 50, 80);

        await encoder.addCanvasFrame(canvas);
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 / config.frameRate),
        ); // Simulate real-time frame generation
      }

      // For real-time audio, you would continuously call addAudioBuffer
      // or addAudioData when you already have AudioData chunks
      // For this example, we'll add a silent track matching video duration after frames.
      // In a true real-time scenario, audio and video would be interleaved.
      const audioContext = new AudioContext({ sampleRate: config.sampleRate });
      const silentAudioBuffer = audioContext.createBuffer(
        config.channels,
        audioContext.sampleRate * (300 / config.frameRate),
        audioContext.sampleRate,
      );
      await encoder.addAudioBuffer(silentAudioBuffer);

      const result = await encoder.finalize(); // In real-time, this resolves with empty Uint8Array
      console.log(
        "Real-time encoding finished. Finalize result byteLength:",
        result.byteLength,
      );

      // Important: Wait for all data to be appended before ending the MediaSource stream
      const endOfStream = () => {
        if (
          sourceBuffer &&
          !sourceBuffer.updating &&
          mediaSource.readyState === "open"
        ) {
          mediaSource.endOfStream();
          console.log("MediaSource endOfStream called.");
        } else if (mediaSource.readyState === "open") {
          console.log(
            "Waiting for SourceBuffer to finish updating before endOfStream...",
          );
          setTimeout(endOfStream, 100);
        } else {
          console.log("MediaSource not open, cannot end stream.");
        }
      };
    } catch (error) {
      console.error("Real-time encoding failed:", error);
    }
  }
}

// encodeVideoRealtime(); // Uncomment to run
```

## Recording a MediaStream

`MediaStreamRecorder` simplifies capturing from a `MediaStream`. It internally
uses `MediaStreamTrackProcessor` to feed `VideoFrame` and `AudioData` to
`WebCodecsEncoder`.
The snippet below is available in [`examples/record-mediastream.ts`](examples/record-mediastream.ts).

```typescript
import { MediaStreamRecorder } from "webcodecs-encoder";

const recorder = new MediaStreamRecorder(config);
await recorder.startRecording(stream);
const result = await recorder.stopRecording();
```

## Method Chaining API

### Overview

The Method Chaining API provides a fluent interface for configuring and using the WebCodecs encoder. This approach offers better readability and allows for progressive configuration building.

### Quick Comparison

| Traditional API | Method Chaining API |
|-----------------|-------------------|
| ```const encoder = new WebCodecsEncoder(config);``` | ```const encoder = WebCodecsEncoder.create()``` |
| ```await encoder.initialize(options);``` | ```.configure(config).onProgress(callback)``` |
| ```const result = await encoder.finalize();``` | ```await encoder.start(); const result = await encoder.finish();``` |

### Factory Method

#### `WebCodecsEncoder.create()`
Creates a new encoder instance for method chaining.

```typescript
const encoder = WebCodecsEncoder.create();
```

### Configuration Methods

#### `configure(config: EncoderConfig): this`
Sets the basic encoder configuration.

```typescript
encoder.configure({
  width: 1920,
  height: 1080,
  frameRate: 60,
  videoBitrate: 8_000_000,
  audioBitrate: 192_000,
  container: "mp4",
  codec: { video: "avc", audio: "aac" }
});
```

### Callback Methods

#### `onProgress(callback): this`
Sets up basic progress monitoring.

```typescript
encoder.onProgress((processedFrames, totalFrames) => {
  const percentage = totalFrames ? (processedFrames / totalFrames) * 100 : 0;
  updateProgressBar(percentage);
});
```

#### `onDetailedProgress(callback): this`
Sets up detailed progress monitoring with processing speed, queue sizes, and time estimates.

```typescript
encoder.onDetailedProgress((progress) => {
  console.log(`Stage: ${progress.stage}`);
  console.log(`Speed: ${progress.averageProcessingFps.toFixed(1)} fps`);
  console.log(`Queue: Video=${progress.videoQueueSize}, Audio=${progress.audioQueueSize}`);
  
  if (progress.estimatedRemainingMs) {
    const minutes = Math.floor(progress.estimatedRemainingMs / 60000);
    const seconds = Math.floor((progress.estimatedRemainingMs % 60000) / 1000);
    console.log(`ETA: ${minutes}:${seconds.toString().padStart(2, '0')}`);
  }
});
```

#### `onError(callback): this`
Sets up error handling.

```typescript
encoder.onError((error) => {
  console.error(`Encoding error [${error.type}]:`, error.message);
  showErrorToUser(error);
});
```

#### `onData(callback): this`
Sets up real-time data streaming (for `latencyMode: "realtime"`).

```typescript
encoder.onData((chunk, offset, isHeader, container) => {
  if (isHeader) {
    initializeMediaSource(chunk);
  } else {
    appendToMediaSource(chunk);
  }
});
```

### Option Methods

#### `withTotalFrames(count: number): this`
Sets the expected total frame count for progress calculation.

```typescript
encoder.withTotalFrames(1800); // 30fps × 60 seconds
```

#### `withWorker(worker: Worker): this`
Uses a custom worker instance.

```typescript
const customWorker = new Worker('./my-encoder-worker.js');
encoder.withWorker(customWorker);
```

#### `withWorkerScript(url: string | URL): this`
Specifies a custom worker script URL.

```typescript
encoder.withWorkerScript('/workers/webcodecs-worker.js');
```

#### `withAudioWorklet(enabled: boolean = true): this`
Enables AudioWorklet for lower audio latency.

```typescript
encoder.withAudioWorklet(true);
```

### Execution Methods

#### `start(): Promise<this>`
Initializes and starts the encoder (equivalent to `initialize()`).

```typescript
await encoder.start();
// Now you can call addVideoFrame(), addCanvasFrame(), etc.
```

#### `finish(): Promise<Uint8Array | null>`
Finalizes encoding and returns the result (equivalent to `finalize()`).

```typescript
const encodedData = await encoder.finish();
```

### Complex Example

Here's an example showing advanced usage with conditional configuration:

```typescript
import { WebCodecsEncoder } from 'webcodecs-encoder';

async function advancedEncoding() {
  // Base configuration
  let encoder = WebCodecsEncoder.create()
    .configure({
      width: 1920,
      height: 1080,
      frameRate: 30,
      videoBitrate: 5_000_000,
      audioBitrate: 192_000,
      sampleRate: 48000,
      channels: 2,
      container: "mp4"
    });

  // Conditional configuration
  const isHighQuality = getUserPreference('quality') === 'high';
  if (isHighQuality) {
    encoder = encoder.configure({
      ...encoder.config,
      videoBitrate: 15_000_000,
      codec: { video: "hevc", audio: "aac" }
    });
  }

  // Add monitoring and error handling
  encoder = encoder
    .withTotalFrames(estimatedFrameCount)
    .onDetailedProgress((progress) => {
      updateDetailedUI(progress);
    })
    .onError((error) => {
      handleEncodingError(error);
    });

  // Start encoding
  try {
    await encoder.start();
    
    // Process video frames...
    for (const frame of videoFrames) {
      await encoder.addVideoFrame(frame);
    }
    
    const result = await encoder.finish();
    saveEncodedVideo(result);
    
  } catch (error) {
    console.error('Encoding failed:', error);
  }
}
```

## API

- **`WebCodecsEncoder.isSupported(): boolean`**
  Checks if `VideoEncoder`, `AudioEncoder`, and `Worker` are available in the current environment.

- **`new WebCodecsEncoder(config: EncoderConfig)`**
  Creates a new encoder instance.
  `EncoderConfig`:
    - `container?: 'mp4' | 'webm'`: (Optional) Container format. Defaults to `'mp4'`. Use `'webm'` for WebM output.
    - `latencyMode?: 'quality' | 'realtime'`: (Optional) Encoding latency mode. `'quality'` (default) for best quality, `'realtime'` for lower latency and chunked output.
    - `dropFrames?: boolean`: (Optional) Drop new video frames when the worker-reported video queue size exceeds `maxQueueDepth`.
    - `maxQueueDepth?: number`: (Optional) Maximum video queue size before dropping occurs. The queue size uses WebCodecs `encodeQueueSize`. Defaults to unlimited.
    - `hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference'`: (Optional) Hint to use hardware or software encoders when available.
    - `width: number`: Video width.
    - `height: number`: Video height.
    - `frameRate: number`: Video frame rate.
    - `videoBitrate: number`: Video bitrate in bits per second.
    - `audioBitrate: number`: Audio bitrate in bits per second.
    - `audioBitrateMode?: 'constant' | 'variable'`: (Optional) Set `'constant'` for CBR or `'variable'` for VBR when using AAC.
      Chrome 119 or later has improved CBR support.
    - `sampleRate: number`: Audio sample rate (e.g., 44100, 48000). 48000 is recommended for Opus.
    - `channels: number`: Number of audio channels (e.g., 1 for mono, 2 for stereo).
    - `codec?: { video?: 'avc' | 'hevc' | 'vp9' | 'av1'; audio?: 'aac' | 'opus' }`: (Optional) Preferred codecs. Defaults to `{ video: 'avc', audio: 'aac' }`.
    - `codecString?: { video?: string; audio?: string }`: (Optional) Explicit codec strings passed directly to the encoders.
      Video strings include profile and level, e.g. "avc1.640028" (High Profile Level 4.0) or "vp09.00.10.08".
      Audio examples include "mp4a.40.2" (AAC-LC) or "opus".
      If omitted for H.264, a profile and level is derived from the resolution and frame rate.
    - `keyFrameInterval?: number`: (Optional) Force a key frame every N video frames. When set, the worker sends `{ keyFrame: true }` to `VideoEncoder.encode()` at that interval.
    - `videoEncoderConfig?: Partial<VideoEncoderConfig>`: (Optional) Additional codec-specific options passed to `VideoEncoder.configure`. Include `hardwareAcceleration` to prefer hardware or software encoding.
    - `audioEncoderConfig?: Partial<AudioEncoderConfig>`: (Optional) Additional settings passed to `AudioEncoder.configure`. This also accepts `hardwareAcceleration`.

### Enhanced Progress Information

The `onDetailedProgress` callback provides a `DetailedProgressInfo` object with comprehensive encoding statistics:

```typescript
interface DetailedProgressInfo {
  processedFrames: number;           // Total frames processed
  totalFrames?: number;              // Expected total frames (if provided)
  stage: ProcessingStage;            // Current processing stage
  elapsedTimeMs: number;             // Time elapsed since encoding started
  estimatedRemainingMs?: number;     // Estimated time to completion
  processingFps: number;             // Current processing speed (fps)
  averageProcessingFps: number;      // Average processing speed (fps)
  droppedFrames: number;             // Number of dropped frames
  videoQueueSize: number;            // Current video encoder queue size
  audioQueueSize: number;            // Current audio encoder queue size
  processedDataSize: number;         // Total bytes processed so far
}
```

### State Management

The encoder maintains strict state management to prevent invalid operations:

- **EncoderState**: `Idle` → `Initializing` → `Encoding` → `Finalizing` → `Disposed` (or `Error`)
- **ProcessingStage**: `Initializing` → `VideoEncoding` → `AudioEncoding` → `Muxing` → `Finalizing`

### Input Validation

The encoder validates all configuration parameters at initialization time:

- **Resolution**: Width and height must be between 1-7680px and 1-4320px respectively
- **Frame Rate**: Must be between 0.1-120 fps
- **Video Bitrate**: Must be between 100kbps-100Mbps
- **Audio Bitrate**: Must be between 32kbps-320kbps (when audio enabled)
- **Audio Settings**: Channels (1-8), sample rate (8kHz-192kHz)
- **Codec Compatibility**: Validates codec/container combinations (e.g., VP9/Opus for WebM)

- **`encoder.initialize(options?: WebCodecsEncoderInitializeOptions): Promise<void>`**
  Initializes the encoder and worker.
  `WebCodecsEncoderInitializeOptions`:

  - `onProgress?: (processedFrames: number, totalFrames?: number) => void`: Callback for encoding progress. `totalFrames` might be undefined in real-time or if not provided.
  - `onDetailedProgress?: (progress: DetailedProgressInfo) => void`: Callback for detailed progress information including processing speed, queue sizes, estimated completion time, and current processing stage.
  - `totalFrames?: number`: Total number of video frames to be encoded. Used for progress calculation.
  - `onError?: (error: WebCodecsEncoderError) => void`: Callback for errors occurring in the worker after initialization. Receives an `WebCodecsEncoderError` object.
  - `onData?: (chunk: Uint8Array, isHeader?: boolean, container?: 'mp4' | 'webm') => void`: Callback for receiving muxed data chunks. Used when `latencyMode` is `'realtime'`. `isHeader` is true for the initial container header.
  - `worker?: Worker`: Provide a pre-created `Worker` instance instead of letting `WebCodecsEncoder` create one.
  - `workerScriptUrl?: string | URL`: Specify a custom worker script to load when creating the worker.
  - `useAudioWorklet?: boolean`: Use an `AudioWorklet` to pipe audio data directly to the worker for lower latency.

- **`encoder.addVideoFrame(frame: VideoFrame): Promise<void>`**
  Adds a `VideoFrame` object for encoding. Ensure the source is converted to a `VideoFrame` before calling this method.
  Remember to call `frame.close()` after encoding to free resources.
- **`encoder.addCanvasFrame(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void>`**
  Convenience wrapper that creates a `VideoFrame` from a canvas and forwards it to `addVideoFrame`.

- **`encoder.addAudioBuffer(audioBuffer: AudioBuffer): Promise<void>`**
  Adds an entire `AudioBuffer` for encoding. Useful for adding complete audio tracks.
  The channel count of the `AudioBuffer` must exactly match the `channels` value
  specified in the encoder configuration or the call will reject with a
  `configuration-error`.
  For long audio segments, consider splitting the buffer into smaller chunks or
  using `addAudioData` to stream data incrementally so that very large buffers
  don't need to be transferred to the worker all at once.

- **`encoder.addAudioData(audioData: AudioData): Promise<void>`**
  Adds an `AudioData` object for encoding. Suitable for streaming audio samples.
  Remember to call `audioData.close()` after encoding to free resources.
  Like `addAudioBuffer`, the `AudioData` must have the same number of channels
  as configured for the encoder.

- **`encoder.finalize(): Promise<Uint8Array | null>`**
  Finalizes the encoding process and returns the encoded file as a `Uint8Array`.
  If `latencyMode` is `'realtime'`, the promise resolves with the final `Uint8Array` when the worker provides output, or with `null` when no additional data is sent because everything has already been delivered via `onData`.

- **`encoder.cancel(): void`**
  Cancels the encoding process and terminates the worker.

- **`encoder.getActualVideoCodec(): string | null`**
  Returns the actual video codec string (e.g., 'avc1.42001E', 'vp09.00.10.08') being used by the `VideoEncoder` after initialization and potential fallbacks. Returns `null` if not initialized or video is disabled.

- **`encoder.getActualAudioCodec(): string | null`**
  Returns the actual audio codec string (e.g., 'mp4a.40.2', 'opus') being used by the `AudioEncoder` after initialization and potential fallbacks. Returns `null` if not initialized or audio is disabled.
- **`encoder.getVideoQueueSize(): number`**
  Returns the current video encoder queue size reported by the worker.
- **`encoder.getAudioQueueSize(): number`**
  Returns the current audio encoder queue size reported by the worker.
- **`encoder.getState(): EncoderState`**
  Returns the current encoder state (`Idle`, `Initializing`, `Encoding`, `Finalizing`, `Disposed`, `Error`).
- **`encoder.getCurrentStage(): ProcessingStage`**
  Returns the current processing stage (`Initializing`, `VideoEncoding`, `AudioEncoding`, `Muxing`, `Finalizing`).

### Method Chaining API Reference

- **`WebCodecsEncoder.create(): WebCodecsEncoder`**
  Creates a new encoder instance for method chaining.

- **`encoder.configure(config: EncoderConfig): this`**
  Sets the encoder configuration.

- **`encoder.onProgress(callback: (processedFrames: number, totalFrames?: number) => void): this`**
  Sets basic progress monitoring callback.

- **`encoder.onDetailedProgress(callback: (progress: DetailedProgressInfo) => void): this`**
  Sets detailed progress monitoring callback.

- **`encoder.onError(callback: (error: WebCodecsEncoderError) => void): this`**
  Sets error handling callback.

- **`encoder.onData(callback: RealtimeDataCallback): this`**
  Sets real-time data streaming callback.

- **`encoder.withTotalFrames(count: number): this`**
  Sets expected total frame count for progress calculation.

- **`encoder.withWorker(worker: Worker): this`**
  Uses a custom worker instance.

- **`encoder.withWorkerScript(url: string | URL): this`**
  Specifies custom worker script URL.

- **`encoder.withAudioWorklet(enabled: boolean = true): this`**
  Enables AudioWorklet for lower audio latency.

- **`encoder.start(): Promise<this>`**
  Initializes and starts the encoder (equivalent to `initialize()`).

- **`encoder.finish(): Promise<Uint8Array | null>`**
  Finalizes encoding and returns the result (equivalent to `finalize()`).

- **`MediaStreamRecorder.isSupported(): boolean`**
  Checks if `MediaStreamTrackProcessor` and `WebCodecsEncoder` are available.

- **`new MediaStreamRecorder(config: EncoderConfig)`**
  Creates a recorder that internally uses `WebCodecsEncoder`.

- **`recorder.startRecording(stream: MediaStream, options?: WebCodecsEncoderInitializeOptions): Promise<void>`**
  Starts reading `VideoFrame` and `AudioData` from the provided stream.

- **`recorder.stopRecording(): Promise<Uint8Array>`**
  Stops recording and finalizes the encoder. Returns the encoded file or an empty array in real-time mode.

## Checking Configuration Support

Before initializing the encoder you can verify support for your preferred codecs using `VideoEncoder.isConfigSupported()` and `AudioEncoder.isConfigSupported()`.
```ts
const videoCheck = await VideoEncoder.isConfigSupported({
  codec: 'avc1.640028',
  width: 1920,
  height: 1080,
  bitrate: 5_000_000,
  framerate: 30,
});
if (!videoCheck.supported) {
  // Fallback to a different profile such as 'avc1.42E01E'
}
```
The same approach works for audio with codec strings like `mp4a.40.2` or `opus`.

## Codec Compatibility

This library supports encoding to MP4 and WebM container formats with the following codecs:

- **Video Codecs:**
  - `avc1` (H.264/AVC): Widely supported.
  - `vp09` (VP9): Modern, efficient codec. Good for web usage.
  - `av01` (AV1): High efficiency but may require modern hardware acceleration.
- **Audio Codecs:**
  - `mp4a` (AAC): Widely supported, good quality.
  - `opus` (Opus): Modern, efficient, and versatile audio codec. Excellent for both speech and music, and good for real-time applications.

Example configuration requesting AV1:

```ts
const config = {
  codec: { video: 'av1' },
  codecString: { video: 'av01.0.04M.08' },
  // ...other options
};
```

**Important Notes:**
-   Codec support depends on the browser's WebCodecs implementation. The library attempts to use the specified codec and will fall back to a default (AVC for video, AAC for audio) if the preferred one is not supported, logging a warning. If AAC is unavailable the worker will log a warning and try Opus instead. You can check `encoder.getActualVideoCodec()` and `encoder.getActualAudioCodec()` after `initialize()` to see what codecs are actually being used.
-   The worker verifies that the channel count reported by `AudioEncoder.isConfigSupported()` matches your configured `channels`. A mismatch causes initialization to fail with a `configuration-error`.
-   When using `latencyMode: 'realtime'`, ensure the chosen codecs are suitable for streaming and are supported by your target MSE implementation (e.g., `MediaSource.isTypeSupported(...)`).
-   For VP9 and Opus in MP4, browser support for playback can vary. Test thoroughly.
-   See [MDN](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) and [Can I use](https://caniuse.com/webcodecs) for up-to-date browser compatibility information.

## Choosing CBR or VBR for AAC

Set `audioBitrateMode` in `EncoderConfig` to control how AAC bitrate is allocated.
`'constant'` produces constant bitrate (CBR) output, while `'variable'` enables
variable bitrate (VBR). Starting with Chrome 119, CBR handling in the
`AudioEncoder` is much more reliable.

## Development

- Clone the repository.
- Install dependencies: `npm install` (run this before executing `npm run lint`, `npm run type-check`, or `npm test`)
- The `postinstall` script automatically runs `patch-package` to apply our patch for `@types/dom-webcodecs`, restoring the missing `AudioSampleFormat` definition.
- Build: `npm run build`
- Unit tests: `npm test` (this will also generate a coverage report in `./coverage`)
- Integration tests: `npm run test:int` (requires Playwright browsers; run `npx playwright install` once before executing)
- Lint: `npm run lint`
- Format: `npm run format`

## License

MIT
