# WebCodecs MP4/WebM Encoder (MP4 Muxer Currently)

A TypeScript library to encode video (H.264/AVC, VP9) and audio (AAC, Opus) using the WebCodecs API and mux them into an MP4 container. WebM container support is planned for future versions.

## Features

- Encodes `CanvasImageSource` (like `HTMLCanvasElement` or `ImageBitmap`) or `VideoFrame` to H.264/AVC or VP9 video.
- Encodes `AudioData` or `AudioBuffer` to AAC or Opus audio.
- Muxes encoded video and audio into a standard MP4 file.
- Real-time streaming: Delivers muxed data in chunks via a callback, suitable for live streaming with Media Source Extensions (MSE).
- Uses Web Workers to offload encoding tasks from the main thread.
- Provides progress callbacks and cancellation support.
- Built with TypeScript, providing type definitions.
- Automatic codec fallback (e.g., VP9 to AVC, Opus to AAC) if the preferred codec is not supported.

## Installation

```bash
npm install webcodec-muxer
# or
yarn add webcodec-muxer
```

## Basic Usage (File Output)

```typescript
import { Mp4Encoder } from 'webcodec-muxer';

async function encodeVideoToFile() {
  if (!Mp4Encoder.isSupported()) {
    console.error('WebCodecs or Workers not supported.');
    return;
  }

  const config = {
    width: 1280,
    height: 720,
    frameRate: 30,
    video: {
      bitrate: 2_000_000, // 2 Mbps
    },
    audio: {
      bitrate: 128_000,  // 128 kbps
      sampleRate: 48000, // Recommended: 48000 for Opus
      numberOfChannels: 2,
    }
  };

  const encoder = new Mp4Encoder(config);

  try {
    await encoder.initialize({
      onProgress: (processedFrames, totalFrames) => {
        console.log(`Progress (File): ${processedFrames}/${totalFrames}`);
      },
      totalFrames: 300 // Optional: for progress calculation
    });

    const canvas = document.createElement('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    const ctx = canvas.getContext('2d');

    // Example: Encode 300 frames
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `hsl(${(i * 5) % 360}, 100%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'white';
      ctx.font = '50px Arial';
      ctx.fillText(`Frame ${i + 1}`, 50, 100);

      await encoder.addVideoFrame(canvas);
    }

    // Example: Create a silent audio track
    const audioContext = new AudioContext({ sampleRate: config.audio.sampleRate });
    const silentAudioBuffer = audioContext.createBuffer(
      config.audio.numberOfChannels,
      audioContext.sampleRate * (300 / config.frameRate), // duration matching video
      audioContext.sampleRate
    );
    await encoder.addAudioBuffer(silentAudioBuffer);


    const uint8Array = await encoder.finalize();
    console.log('Encoding finished! MP4 size:', uint8Array.byteLength);

    // Download the MP4
    const blob = new Blob([uint8Array], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'encoded_video.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Encoding failed:', error);
  }
}

encodeVideoToFile();
```

## Real-time Streaming Usage

For applications like live streaming, you can configure the encoder to output data in chunks. This is typically used with Media Source Extensions (MSE) to play the video in an HTML `<video>` element as it's being encoded.

```typescript
import { Mp4Encoder } from 'webcodec-muxer';

async function encodeVideoRealtime() {
  if (!Mp4Encoder.isSupported()) {
    console.error('WebCodecs or Workers not supported.');
    return;
  }

  const config = {
    latencyMode: 'realtime', // Enable real-time streaming
    width: 1280,
    height: 720,
    frameRate: 30,
    video: {
      codec: 'vp09', // Example: VP9 for lower latency
      bitrate: 2_000_000,
    },
    audio: {
      codec: 'opus', // Example: Opus for lower latency
      bitrate: 128_000,
      sampleRate: 48000,
      numberOfChannels: 2,
    }
  };

  let mediaSource;
  let sourceBuffer;
  const videoElement = document.createElement('video');
  videoElement.controls = true;
  document.body.appendChild(videoElement);

  if ('MediaSource' in window && MediaSource.isTypeSupported(`video/mp4; codecs="${config.video.codec}.0, ${config.audio.codec}"`)) { // Basic check
    mediaSource = new MediaSource();
    videoElement.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', () => {
      console.log("MediaSource opened");
      // Determine actual codecs used after potential fallbacks
      const actualVideoCodec = encoder.getActualVideoCodec() || config.video.codec;
      const actualAudioCodec = encoder.getActualAudioCodec() || config.audio.codec;
      
      try {
        sourceBuffer = mediaSource.addSourceBuffer(`video/mp4; codecs="${actualVideoCodec}, ${actualAudioCodec}"`);
        sourceBuffer.mode = 'sequence'; // Important for streaming
        console.log("SourceBuffer added");
        
        sourceBuffer.addEventListener('error', (e) => console.error('SourceBuffer error:', e));
        sourceBuffer.addEventListener('updateend', () => {
          // console.log('SourceBuffer update end');
        });

      } catch (e) {
        console.error("Error adding SourceBuffer:", e);
        return;
      }
      
      // Start encoding once source buffer is ready
      startEncoding();
    });
    mediaSource.addEventListener('sourceended', () => console.log("MediaSource ended"));
    mediaSource.addEventListener('sourceclose', () => console.log("MediaSource closed"));

  } else {
    console.error('MediaSource or the codec combination is not supported.');
    return;
  }
  
  const encoder = new Mp4Encoder(config);

  async function startEncoding() {
    console.log("Starting encoding process...");
    try {
      await encoder.initialize({
        onData: (chunk, isHeader) => {
          if (sourceBuffer && !sourceBuffer.updating && mediaSource.readyState === 'open') {
            try {
              sourceBuffer.appendBuffer(chunk);
            } catch (e) {
              console.error('Error appending buffer:', e);
            }
          } else {
            console.warn('SourceBuffer not ready or updating, or MediaSource not open. Skipping append.');
          }
        },
        onProgress: (processedFrames, totalFrames) => { // totalFrames might be undefined in pure realtime
          console.log(`Progress (Real-time): ${processedFrames}`);
        },
        onError: (error) => {
          console.error('Encoder error during initialization or processing:', error);
        }
      });

      const canvas = document.createElement('canvas');
      canvas.width = config.width;
      canvas.height = config.height;
      const ctx = canvas.getContext('2d');

      // Example: Encode for 10 seconds (300 frames)
      for (let i = 0; i < 300; i++) {
        ctx.fillStyle = `hsl(${(i * 1.2) % 360}, 90%, 60%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'black';
        ctx.font = '40px Arial';
        ctx.fillText(`Live Frame ${i + 1}`, 50, 80);
        await encoder.addVideoFrame(canvas);
        await new Promise(resolve => setTimeout(resolve, 1000 / config.frameRate)); // Simulate real-time frame generation
      }

      // For real-time audio, you would continuously call addAudioData or addAudioBuffer
      // For this example, we'll add a silent track matching video duration after frames.
      // In a true real-time scenario, audio and video would be interleaved.
      const audioContext = new AudioContext({ sampleRate: config.audio.sampleRate });
      const silentAudioBuffer = audioContext.createBuffer(
        config.audio.numberOfChannels,
        audioContext.sampleRate * (300 / config.frameRate),
        audioContext.sampleRate
      );
      await encoder.addAudioBuffer(silentAudioBuffer);


      const result = await encoder.finalize(); // In real-time, this resolves with empty Uint8Array
      console.log('Real-time encoding finished. Finalize result byteLength:', result.byteLength);
      
      // Important: Wait for all data to be appended before ending the MediaSource stream
      const endOfStream = () => {
        if (sourceBuffer && !sourceBuffer.updating && mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
          console.log("MediaSource endOfStream called.");
        } else if (mediaSource.readyState === 'open') {
          console.log("Waiting for SourceBuffer to finish updating before endOfStream...");
          setTimeout(endOfStream, 100);
        } else {
          console.log("MediaSource not open, cannot end stream.");
        }
      };
    } catch (error) {
      console.error('Real-time encoding failed:', error);
    }
  }
}

// encodeVideoRealtime(); // Uncomment to run
```

## API

- **`Mp4Encoder.isSupported(): boolean`**
  Checks if `VideoEncoder`, `AudioEncoder`, and `Worker` are available in the current environment.

- **`new Mp4Encoder(config: EncoderConfig)`**
  Creates a new encoder instance.
  `EncoderConfig`:
    - `container?: 'mp4'`: (Optional) The container format. Currently, only `'mp4'` is supported and is the default.
    - `latencyMode?: 'quality' | 'realtime'`: (Optional) Encoding latency mode. `'quality'` (default) for best quality, `'realtime'` for lower latency and chunked output.
    - `width: number`: Video width.
    - `height: number`: Video height.
    - `frameRate: number`: Video frame rate.
    - `video: VideoEncoderConfigOptions`:
        - `codec?: 'avc1' | 'vp09'`: (Optional) Video codec. `'avc1'` (H.264, default), `'vp09'` (VP9).
        - `bitrate: number`: Video bitrate in bits per second.
        - `hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software'`: (Optional) WebCodecs `hardwareAcceleration` hint.
    - `audio: AudioEncoderConfigOptions`:
        - `codec?: 'mp4a' | 'opus'`: (Optional) Audio codec. `'mp4a'` (AAC, default), `'opus'`.
        - `bitrate: number`: Audio bitrate in bits per second.
        - `sampleRate: number`: Audio sample rate (e.g., 44100, 48000). 48000 is recommended for Opus.
        - `numberOfChannels: number`: Number of audio channels (e.g., 1 for mono, 2 for stereo).
        - `bitDepth?: 8 | 16 | 32`: (Optional) Sample bit depth for PCM input. Defaults to 16 if using `AudioBuffer`.

- **`encoder.initialize(options?: Mp4EncoderInitializeOptions): Promise<void>`**
  Initializes the encoder and worker.
  `Mp4EncoderInitializeOptions`:
    - `onProgress?: (processedFrames: number, totalFrames?: number) => void`: Callback for encoding progress. `totalFrames` might be undefined in real-time or if not provided.
    - `totalFrames?: number`: Total number of video frames to be encoded. Used for progress calculation.
    - `onError?: (error: Error) => void`: Callback for errors occurring in the worker after initialization.
    - `onData?: (chunk: Uint8Array, isHeader?: boolean) => void`: Callback for receiving muxed data chunks. Used when `latencyMode` is `'realtime'`. `isHeader` is true for the initial MP4 header chunk.

- **`encoder.addVideoFrame(frameSource: CanvasImageSource | VideoFrame): Promise<void>`**
  Adds a video frame for encoding. `frameSource` can be an `HTMLCanvasElement`, `ImageBitmap`, `HTMLVideoElement`, etc., or a `VideoFrame`.

- **`encoder.addAudioBuffer(audioBuffer: AudioBuffer): Promise<void>`**
  Adds an entire `AudioBuffer` for encoding. Useful for adding complete audio tracks.

- **`encoder.addAudioData(audioData: AudioData): Promise<void>`**
  Adds an `AudioData` object for encoding. Suitable for streaming audio samples.

- **`encoder.finalize(): Promise<Uint8Array>`**
  Finalizes the encoding process and returns the MP4 file as a `Uint8Array`.
  If `latencyMode` is `'realtime'`, this resolves with an empty `Uint8Array` as data has already been delivered via `onData`.

- **`encoder.cancel(): void`**
  Cancels the encoding process and terminates the worker.

- **`encoder.getActualVideoCodec(): string | null`**
  Returns the actual video codec string (e.g., 'avc1.42001E', 'vp09.00.10.08') being used by the `VideoEncoder` after initialization and potential fallbacks. Returns `null` if not initialized or video is disabled.

- **`encoder.getActualAudioCodec(): string | null`**
  Returns the actual audio codec string (e.g., 'mp4a.40.2', 'opus') being used by the `AudioEncoder` after initialization and potential fallbacks. Returns `null` if not initialized or audio is disabled.

## Codec Compatibility

This library supports encoding to MP4 container format with the following codecs:

-   **Video Codecs:**
    -   `avc1` (H.264/AVC): Widely supported.
    -   `vp09` (VP9): Modern, efficient codec. Good for web usage.
-   **Audio Codecs:**
    -   `mp4a` (AAC): Widely supported, good quality.
    -   `opus` (Opus): Modern, efficient, and versatile audio codec. Excellent for both speech and music, and good for real-time applications.

**Important Notes:**
-   Codec support depends on the browser's WebCodecs implementation. The library attempts to use the specified codec and will fall back to a default (AVC for video, AAC for audio) if the preferred one is not supported, logging a warning. You can check `encoder.getActualVideoCodec()` and `encoder.getActualAudioCodec()` after `initialize()` to see what codecs are actually being used.
-   When using `latencyMode: 'realtime'`, ensure the chosen codecs are suitable for streaming and are supported by your target MSE implementation (e.g., `MediaSource.isTypeSupported(...)`).
-   For VP9 and Opus in MP4, browser support for playback can vary. Test thoroughly.

## Development

- Clone the repository.
- Install dependencies: `npm install`
- Build: `npm run build`
- Test: `npm test` (this will also generate a coverage report in `./coverage`)
- Lint: `npm run lint`
- Format: `npm run format`

## License

MIT
