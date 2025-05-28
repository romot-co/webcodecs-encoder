# WebCodecs Encoder - Function-First API

A TypeScript library to encode video (H.264/AVC, VP9, VP8) and audio (AAC, Opus) using the WebCodecs API and mux them into MP4 or WebM containers with a simple, function-first design.

> **🎉 v1.0.0 Release**  
> This is the stable release with the new function-first API. The API is now simplified and production-ready with automatic configuration, quality presets, and progressive enhancement.

## Features

- **🚀 Function-First API**: Simple `encode()`, `encodeStream()`, and `canEncode()` functions
- **🎯 Zero Configuration**: Automatic resolution, frame rate, and codec detection
- **📊 Quality Presets**: Simple `low`, `medium`, `high`, `lossless` presets
- **🔄 Multiple Input Types**: Frame arrays, AsyncIterable, MediaStream, VideoFile
- **⚡ Real-time Streaming**: Progressive encoding with `encodeStream()`
- **🎨 Progressive Enhancement**: Start simple, add complexity as needed
- **🔧 Transparent Worker Management**: No manual worker setup required
- **📦 Optimized Bundle Size**: Import only what you need
- **🛡️ Type Safety**: Full TypeScript support with comprehensive types
- **🎵 Audio Support**: AAC and Opus encoding with automatic configuration

## Installation

```bash
npm install webcodecs-encoder
# or
yarn add webcodecs-encoder
```

No additional setup required! The library automatically manages Web Workers internally.

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
  video?: {
    codec?: 'avc' | 'hevc' | 'vp9' | 'vp8' | 'av1';
    bitrate?: number;
    hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    latencyMode?: 'quality' | 'realtime';
    keyFrameInterval?: number;
  };
  
  audio?: {
    codec?: 'aac' | 'opus';
    bitrate?: number;
    sampleRate?: number;
    channels?: number;
    bitrateMode?: 'constant' | 'variable';
  } | false; // false to disable audio

  container?: 'mp4' | 'webm';

  // Callbacks
  onProgress?: (progress: ProgressInfo) => void;
  onError?: (error: EncodeError) => void;
}
```

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

### Custom Encoder Factory

For repeated encoding with the same settings:

```typescript
import { createEncoder, encoders } from 'webcodecs-encoder/factory';

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

### Platform-Specific Optimization

```typescript
import { examples } from 'webcodecs-encoder/factory';

// Optimize for specific platforms
const youtubeEncoder = examples.getEncoderForPlatform('youtube');
const twitterEncoder = examples.getEncoderForPlatform('twitter');

// Resolution-based optimization
const hdEncoder = examples.createByResolution(1920, 1080);
const mobileEncoder = examples.createByResolution(640, 480);

// File size constraints
const smallFileEncoder = examples.createForFileSize(10, 60); // 10MB for 60 seconds
```

### Error Handling

```typescript
import { encode, EncodeError } from 'webcodecs-encoder';

try {
  const mp4 = await encode(frames, { quality: 'high' });
  } catch (error) {
  if (error instanceof EncodeError) {
    switch (error.type) {
      case 'not-supported':
        console.log('WebCodecs not supported in this browser');
        break;
      case 'invalid-input':
        console.log('Invalid input frames or configuration');
        break;
      case 'encoding-failed':
        console.log('Encoding process failed:', error.message);
        break;
      default:
        console.log('Unknown encoding error:', error.message);
    }
  }
}
```

## Browser Support

- **Chrome 94+**: Full support
- **Edge 94+**: Full support  
- **Firefox**: Experimental support (enable `dom.media.webcodecs.enabled`)
- **Safari**: Not yet supported

Check support at runtime:

```typescript
import { canEncode } from 'webcodecs-encoder';

const supported = await canEncode();
if (!supported) {
  // Fallback to MediaRecorder or other solutions
}
```

## Performance Tips

1. **Use quality presets** instead of manual bitrate calculation
2. **Enable hardware acceleration** when available: `{ video: { hardwareAcceleration: 'prefer-hardware' } }`
3. **Use streaming** for large videos: `encodeStream()` instead of `encode()`
4. **Optimize frame rate** for your use case (30fps is usually sufficient)
5. **Consider container format**: MP4 for compatibility, WebM for smaller files

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Support

- 📖 [Documentation](https://github.com/romot-co/webcodecs-encoder/wiki)
- 🐛 [Issue Tracker](https://github.com/romot-co/webcodecs-encoder/issues)
- 💬 [Discussions](https://github.com/romot-co/webcodecs-encoder/discussions)
