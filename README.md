# WebCodecs Encoder
Function-First API to encode video and audio using WebCodecs API.

[![npm version](https://img.shields.io/npm/v/webcodecs-encoder.svg)](https://www.npmjs.com/package/webcodecs-encoder)
[![CI](https://github.com/romot-co/webcodecs-encoder/actions/workflows/ci.yml/badge.svg)](https://github.com/romot-co/webcodecs-encoder/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/webcodecs-encoder)](https://bundlephobia.com/result?p=webcodecs-encoder)

A TypeScript library to encode video (H.264/AVC, HEVC, VP9, VP8, AV1) and audio (AAC, MP3, Opus, Vorbis, FLAC) using the WebCodecs API and mux them into MP4 or WebM containers with a simple, function-first API.

## Features

- **🚀 Function-First API**: Simple `encode()`, `encodeStream()`, and `canEncode()` functions
- **🎯 Zero Configuration**: Automatic resolution, frame rate, and codec detection
- **📊 Quality Presets**: Simple `low`, `medium`, `high`, `lossless` presets
- **🔄 Multiple Input Types**: Frame arrays, AsyncIterable, MediaStream, VideoFile
- **⚡ Real-time Streaming**: Progressive encoding with `encodeStream()`
- **🎨 Progressive Enhancement**: Start simple, add complexity as needed
- **📦 Optimized Bundle Size**: Tree-shakable with ES Modules and `sideEffects: false` for efficient bundling.
- **🛡️ Type Safety**: Full TypeScript support with comprehensive types
- **🎵 Audio Support**: Automatic AAC↔MP3 fallback for MP4 and Opus/Vorbis/FLAC support for WebM
- **🎤 Audio-Only Encoding**: Support for `video: false` option (v0.2.2)
- **📹 VideoFile Audio**: Extract and encode audio from video files (v0.2.2)
- **⚡ Performance Optimized**: Transferable objects for faster data transfer (v0.2.2)

## Installation

```bash
npm install webcodecs-encoder
# or
yarn add webcodecs-encoder
```

### Worker Setup

The encoder runs inside a dedicated Web Worker (`/webcodecs-worker.js`). Ship that file with your app and ensure it is publicly reachable at the site root.

By default the library:

- **Prefers the external worker** in browsers and production builds.
- **Falls back to an inline mock** only when running under known test runners (Vitest, Jest, `NODE_ENV=test`) or when you explicitly opt in.
- **Never uses the inline mock in production** unless you override the safety check.

Inline worker controls:

| Flag | Effect |
| --- | --- |
| `WEBCODECS_USE_INLINE_WORKER=true` or `window.__WEBCODECS_USE_INLINE_WORKER__ = true` | Force the inline mock (useful for Storybook, unit tests, etc.). |
| `WEBCODECS_DISABLE_INLINE_WORKER=true` or `window.__WEBCODECS_DISABLE_INLINE_WORKER__ = true` | Always require the external worker. |
| `WEBCODECS_ALLOW_INLINE_IN_PROD=true` or `window.__WEBCODECS_ALLOW_INLINE_IN_PROD__ = true` | Explicitly permit the inline mock on production builds (not recommended). |
| `WEBCODECS_WORKER_URL=/assets/webcodecs-worker.js` or `window.__WEBCODECS_WORKER_URL__ = '/assets/webcodecs-worker.js'` | Override the external worker URL when your app is served from a sub-path/CDN. |

> ⚠️ The inline worker is a **test stub** that returns placeholder bytes. Use it only for wiring/UI development. Real MP4/WebM output requires the external worker bundle.

Copy the worker file from `node_modules` into your public assets directory during build/deploy:

```bash
# Example for a Next.js/Vite project with a 'public' directory
cp node_modules/webcodecs-encoder/dist/webcodecs-worker.js public/
```

#### Example: Vite + TypeScript

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import copy from 'rollup-plugin-copy';

export default defineConfig({
  plugins: [
    copy({
      targets: [
        {
          src: 'node_modules/webcodecs-encoder/dist/webcodecs-worker.js',
          dest: 'public'
        }
      ]
    })
  ]
});
```

```ts
// main.ts (development helper)
if (import.meta.env.DEV) {
  window.__WEBCODECS_USE_INLINE_WORKER__ = true;
}
```

## Quick Start

### Basic Encoding

```typescript
import { encode } from 'webcodecs-encoder';

// Encode frames with automatic configuration
const frames = [/* VideoFrame, Canvas, ImageData objects */];
const mp4Data = await encode(frames, { quality: 'medium' });

// Save or use the encoded MP4
const blob = new Blob([mp4Data], { type: 'video/mp4' });
const url = URL.createObjectURL(blob);
```

### Audio-Only Encoding

```typescript
import { encode } from 'webcodecs-encoder';

// Encode a microphone stream to an Opus audio file in a WebM container
const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
const webmAudio = await encode(micStream, {
  video: false, // Required for audio-only
  audio: {
    codec: 'opus',
    bitrate: 128_000
  },
  container: 'webm'
});

const blob = new Blob([webmAudio], { type: 'audio/webm' });
```

### Streaming Encoding

```typescript
import { encodeStream } from 'webcodecs-encoder';

// Real-time encoding for live streaming
const stream = await navigator.mediaDevices.getUserMedia({ video: true });

for await (const chunk of encodeStream(stream, { quality: 'high' })) {
  // Send chunk to MediaSource, server, or save incrementally
  mediaSource.appendBuffer(chunk);
}
```

### Check Browser Support

```typescript
import { canEncode } from 'webcodecs-encoder';

// Check if encoding is supported
const isSupported = await canEncode();

// Check specific configuration
const canEncodeHEVC = await canEncode({
  video: { codec: 'hevc' },
  quality: 'high'
});
```

## API Reference

### Core Functions

#### `encode(source, options?)`

Encode video to a complete MP4/WebM file.

```typescript
async function encode(
  source: VideoSource,
  options?: EncodeOptions
): Promise<Uint8Array>
```

#### `encodeStream(source, options?)`

Stream encoding with real-time chunks.

```typescript
async function* encodeStream(
  source: VideoSource,
  options?: EncodeOptions
): AsyncGenerator<Uint8Array>
```

#### `canEncode(options?)`

Check if encoding is supported with given options.

```typescript
async function canEncode(options?: EncodeOptions): Promise<boolean>
```

### Video Sources

The API supports multiple input types:

```typescript
type VideoSource =
  | Frame[]                    // Static frame array
  | AsyncIterable<Frame>       // Dynamic frame generation
  | MediaStream               // Camera/screen capture
  | VideoFile;                // Existing video file

type Frame = VideoFrame | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | ImageData;
```

### Encode Options

```typescript
interface EncodeOptions {
  // Basic settings (auto-detected if not specified)
  width?: number;
  height?: number;
  frameRate?: number;

  // Quality preset (recommended)
  quality?: 'low' | 'medium' | 'high' | 'lossless';

  // Advanced settings
  /** Set to `false` for audio-only encoding. */
  video?: {
    codec?: 'avc' | 'hevc' | 'vp9' | 'vp8' | 'av1';
    codecString?: string; // e.g. 'avc1.640028'
    bitrate?: number;
    quantizer?: number;
    avc?: { format?: 'annexb' | 'avc' };
    hevc?: { format?: 'annexb' | 'hevc' };
    hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    keyFrameInterval?: number;
  } | false;

  /** Set to `false` to disable audio. */
  audio?: {
    codec?: 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac';
    codecString?: string; // e.g. 'mp4a.40.2'
    bitrate?: number;
    sampleRate?: number;
    channels?: number;
    bitrateMode?: 'constant' | 'variable';
    aac?: { format?: 'aac' | 'adts' };
  } | false;

  container?: 'mp4' | 'webm';

  // --- Advanced Control ---

  /**
   * Latency mode for encoder and muxer.
   * `encodeStream()` automatically uses 'realtime'.
   */
  latencyMode?: 'quality' | 'realtime';

  /**
   * How to handle the first timestamp. 'offset' is recommended for streams.
   * - 'offset': Shifts all timestamps so the first one is zero.
   * - 'strict': Uses the original timestamps.
   */
  firstTimestampBehavior?: 'offset' | 'strict';

  /**
   * Maximum video encode queue size before applying backpressure (default: 30).
   */
  maxVideoQueueSize?: number;

  /**
   * Maximum audio encode queue size before applying backpressure (default: 30).
   */
  maxAudioQueueSize?: number;

  /**
   * Strategy for handling encode queue overflow (default: 'drop').
   * - 'drop': Discard new frames when the queue is full.
   * - 'wait': Block the processing loop until there is space in the queue.
   */
  backpressureStrategy?: 'drop' | 'wait';

  // Callbacks
  onProgress?: (progress: ProgressInfo) => void;
  onError?: (error: EncodeError) => void;
}

interface ProgressInfo {
  /** Percentage of completion (0-100) */
  percent: number;
  /** Total number of frames processed */
  processedFrames: number;
  /** Total number of frames to encode (if known) */
  totalFrames?: number;
  /** Current encoding speed in frames per second */
  fps: number;
  /** Current stage label ("streaming", "finalizing", etc.) */
  stage: string;
  /** Estimated remaining time in milliseconds */
  estimatedRemainingMs?: number;
}
```

> **Audio codec compatibility**
>
> - `container: 'mp4'` supports `aac` (default) and automatically falls back to `mp3` if AAC isn’t available.
> - `container: 'webm'` supports `opus` (default) with `vorbis` and `flac` as fallbacks.
> - Other codec hints are treated as best-effort; if they can’t be muxed into the requested container the encoder switches to the first compatible alternative.

### Real-time MediaStream Recording

Use `encodeStream()` for real-time recording from camera, microphone, or screen sharing. This provides progressive encoding with streaming output:

```typescript
import { encodeStream } from 'webcodecs-encoder';

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

// Collect encoded chunks as they're generated
const chunks: Uint8Array[] = [];

for await (const chunk of encodeStream(stream, {
  quality: 'medium',
  container: 'mp4',
  onProgress: (progress) => {
    console.log(`Recording: ${progress.percent.toFixed(1)}%`);
  }
})) {
  chunks.push(chunk);
  console.log(`Received chunk: ${chunk.byteLength} bytes`);
  
  // Optional: Send chunks to server for real-time streaming
  // await sendChunkToServer(chunk);
}

// Stop recording by stopping the media tracks
setTimeout(() => {
  stream.getTracks().forEach(track => track.stop());
}, 5000); // Record for 5 seconds

// Combine chunks into final video file
const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
const finalVideo = new Uint8Array(totalSize);
let offset = 0;
for (const chunk of chunks) {
  finalVideo.set(chunk, offset);
  offset += chunk.byteLength;
}

const blob = new Blob([finalVideo], { type: 'video/mp4' });
```

**Real-time streaming benefits**:
- Progressive encoding as data flows
- Immediate chunk availability for streaming
- Built-in cancellation support
- Memory efficient for long recordings

## Usage Examples

### 1. Canvas Animation to MP4

```typescript
import { encode } from 'webcodecs-encoder';

// Create animation frames
const frames = [];
const canvas = new OffscreenCanvas(800, 600);
const ctx = canvas.getContext('2d');

for (let i = 0; i < 120; i++) { // 4 seconds at 30fps
  ctx.clearRect(0, 0, 800, 600);
  ctx.fillStyle = `hsl(${i * 3}, 70%, 50%)`;
  ctx.fillRect(i * 6, 200, 100, 200);
  frames.push(canvas.transferToImageBitmap());
}

// Encode with automatic settings
const mp4 = await encode(frames, {
      quality: 'high',
  frameRate: 30
});

// Save the file
const blob = new Blob([mp4], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
const a = document.createElement('a');
    a.href = url;
a.download = 'animation.mp4';
    a.click();
```

### 2. Camera Recording with Progress

```typescript
import { encode } from 'webcodecs-encoder';

const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720 },
  audio: true
});

const mp4 = await encode(stream, {
  quality: 'medium',
  container: 'mp4',
  onProgress: (progress) => {
    console.log(`Progress: ${progress.percent.toFixed(1)}%`);
    console.log(`Speed: ${progress.fps.toFixed(1)} fps`);
    if (progress.estimatedRemainingMs) {
      console.log(`ETA: ${(progress.estimatedRemainingMs / 1000).toFixed(1)}s`);
    }
  }
});
```

### 3. Real-time Streaming

```typescript
import { encodeStream } from 'webcodecs-encoder';

const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
const chunks = [];

for await (const chunk of encodeStream(stream, {
  quality: 'medium',
  video: { latencyMode: 'realtime' }
})) {
  // Send to server or MediaSource immediately
  chunks.push(chunk);

  // Or stream to MediaSource Extensions
  if (mediaSource.readyState === 'open') {
    sourceBuffer.appendBuffer(chunk);
  }
}

// Combine all chunks for final file
const fullVideo = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
let offset = 0;
for (const chunk of chunks) {
  fullVideo.set(chunk, offset);
  offset += chunk.length;
}
```

### 4. Custom Frame Generation

```typescript
import { encode } from 'webcodecs-encoder';

// Generate frames dynamically
async function* generateFrames() {
  const canvas = new OffscreenCanvas(640, 480);
  const ctx = canvas.getContext('2d');

  for (let frame = 0; frame < 300; frame++) { // 10 seconds at 30fps
    // Draw your animation
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#fff';
    ctx.font = '48px Arial';
    ctx.fillText(`Frame ${frame}`, 50, 240);

    yield canvas.transferToImageBitmap();

    // Optional: add timing control
    await new Promise(resolve => setTimeout(resolve, 33)); // ~30fps
  }
}

const mp4 = await encode(generateFrames(), {
  quality: 'high',
  frameRate: 30
});
```

## Advanced Usage

The main package entry `webcodecs-encoder` exports all core functionalities. Sub-path imports like `webcodecs-encoder/factory` are no longer necessary.

### Custom Encoder Factory

For repeated encoding with the same settings:

```typescript
import { createEncoder, encoders } from 'webcodecs-encoder';

// Create custom encoder
const myEncoder = createEncoder({
  quality: 'high',
  video: { codec: 'avc' },
  audio: { codec: 'aac', bitrate: 192_000 }
});

// Use multiple times
const video1 = await myEncoder.encode(frames1);
const video2 = await myEncoder.encode(frames2);

// Or use predefined encoders
const youtubeVideo = await encoders.youtube.encode(frames);
const twitterVideo = await encoders.twitter.encode(frames);
```

### Error Handling

```typescript
import { encode, EncodeError } from 'webcodecs-encoder';

try {
  const mp4 = await encode(frames, { quality: 'high' });
} catch (error) {
  if (error instanceof EncodeError) {
    // The 'type' property provides specific details
    console.error(`Encoding failed: ${error.type}`, error.message);

    switch (error.type) {
      case 'not-supported':
        console.log('WebCodecs not supported in this browser');
        break;
      case 'invalid-input':
        console.log('Invalid input frames or configuration');
        break;
      case 'configuration-error':
        console.log('The provided configuration is not supported.');
        break;
      case 'initialization-failed':
      case 'video-encoding-error':
      case 'audio-encoding-error':
      case 'muxing-failed':
      case 'worker-error':
        console.log('A critical error occurred during the encoding process.');
        break;
      case 'cancelled':
        console.log('The encoding was cancelled.');
        break;
      // ... handle other specific error types
      default:
        console.log('Unknown encoding error:', error.message);
    }
  }
}
```
The `EncodeError.type` can be one of: `'not-supported'`, `'invalid-input'`, `'initialization-failed'`, `'configuration-error'`, `'video-encoding-error'`, `'audio-encoding-error'`, `'muxing-failed'`, `'cancelled'`, `'timeout'`, `'worker-error'`, `'filesystem-error'`, `'unknown'`.

## Browser Support

- **Chrome 113+**: Full support.
- **Edge 113+**: Full support.
- **Firefox**: Experimental support (enable `dom.media.webcodecs.enabled`).
- **Safari**: Not yet supported.

*Note: While WebCodecs was available in earlier versions, versions 113+ are recommended for stability.*

Check support at runtime:

```typescript
import { canEncode } from 'webcodecs-encoder';

const supported = await canEncode();
if (!supported) {
  // Fallback to MediaRecorder or other solutions
}
```

## Performance Tips

1. **Use quality presets** instead of manual bitrate calculation.
2. **Enable hardware acceleration** when available: `{ video: { hardwareAcceleration: 'prefer-hardware' } }`.
3. **Use streaming** for large videos: `encodeStream()` instead of `encode()`.
4. **Optimize frame rate** for your use case (30fps is usually sufficient).
5. **Tune queue limits for real-time streams**: Adjust queue size and backpressure strategy to balance latency and frame drops.
   ```ts
   encode(stream, {
     latencyMode: 'realtime',
     maxVideoQueueSize: 15, // Lower queue size for lower latency
     backpressureStrategy: 'drop' // Drop frames if the system can't keep up
   });
   ```
6. **Consider container format**: MP4 for compatibility, WebM for smaller files.

## Migration Guide

### From v0.2.x to v0.3.0

**Breaking Changes**: The `MediaStreamRecorder` class has been removed in favor of the function-first API.

#### Before (v0.2.x)
```typescript
import { MediaStreamRecorder } from 'webcodecs-encoder';

const recorder = new MediaStreamRecorder(options);
await recorder.start(stream);
// ... recording in progress
const mp4Data = await recorder.stop();
```

#### After (v0.3.0+)
```typescript
import { encodeStream } from 'webcodecs-encoder';

const chunks: Uint8Array[] = [];
for await (const chunk of encodeStream(stream, options)) {
  chunks.push(chunk);
}

// Combine chunks into final video
const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
const mp4Data = new Uint8Array(totalSize);
let offset = 0;
for (const chunk of chunks) {
  mp4Data.set(chunk, offset);
  offset += chunk.byteLength;
}
```

#### Migration Benefits
- **Better tree-shaking**: Smaller bundle sizes with function imports
- **Streaming support**: Real-time chunk processing
- **Memory efficiency**: Progressive encoding without buffering entire video
- **Error handling**: Standard async/await error handling

#### Common Migration Patterns

**Recording Control**:
```typescript
// Before: recorder.start() / recorder.stop()
// After: Control via MediaStream tracks
setTimeout(() => {
  stream.getTracks().forEach(track => track.stop());
}, 5000);
```

**Progress Tracking**:
```typescript
// Before: constructor options
new MediaStreamRecorder({ onProgress })

// After: encodeStream options  
encodeStream(stream, { onProgress })
```

**Cancellation**:
```typescript
// Before: recorder.cancel()
// After: Stop MediaStream tracks or break out of the loop
const stopRecording = () => {
  stream.getTracks().forEach(track => track.stop());
};

setTimeout(stopRecording, 5000);
```

> The current implementation does not accept an `AbortSignal`. To cancel `encode` / `encodeStream`, stop the MediaStream tracks or end the async generator manually.

See [`examples/realtime-mediastream.ts`](examples/realtime-mediastream.ts) for complete examples.

## Changelog

### v0.2.2 (2025-06-14)

**🚀 Major Features**
- **Real-time streaming**: Fixed `encodeStream()` MediaStream processing - no longer throws errors
- **Audio-only encoding**: Added `video: false` option support for pure audio encoding
- **VideoFile audio extraction**: Automatic audio track processing from video files using AudioContext
- **Transferable objects optimization**: Improved performance with optimized VideoFrame/AudioData transfer

**🔧 Improvements**
- Enhanced MediaStream track detection for audio-only streams
- Better error handling for AudioContext unavailability
- Optimized worker communication with transferable objects
- Extended type definitions for `video: false` configurations

**🐛 Bug Fixes**
- Fixed real-time MediaStream processing in `encodeStream()`
- Resolved audio processing issues in VideoFile inputs
- Improved configuration inference for audio-only scenarios

**📝 Documentation**
- Added comprehensive examples for new features
- Updated API documentation with v0.2.2 features
- Added performance optimization guidelines

### v0.2.1 (2025-06-13)
- Added VideoFile support and removed AudioWorklet feature
- Updated MediaStreamRecorder to use MediaStreamTrackProcessor
- Improved build configuration and exports
- Enhanced test coverage and documentation

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Support

- 📖 [Documentation](https://github.com/romot-co/webcodecs-encoder/wiki)
- 🐛 [Issue Tracker](https://github.com/romot-co/webcodecs-encoder/issues)
- 💬 [Discussions](https://github.com/romot-co/webcodecs-encoder/discussions)
