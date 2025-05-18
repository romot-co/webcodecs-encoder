# WebCodecs MP4 Encoder

A TypeScript library to encode video (H.264) and audio (AAC) using the WebCodecs API and mux them into an MP4 container.

## Features

- Encodes `CanvasImageSource` (like `HTMLCanvasElement` or `ImageBitmap`) to H.264 video.
- Encodes `AudioBuffer` to AAC audio.
- Muxes encoded video and audio into a standard MP4 file.
- Uses Web Workers to offload encoding tasks from the main thread.
- Provides progress callbacks and cancellation support.
- Built with TypeScript, providing type definitions.

## Installation

```bash
npm install webcodecs-mp4-encoder
# or
yarn add webcodecs-mp4-encoder
```

## Basic Usage

```typescript
import { Mp4Encoder } from 'webcodecs-mp4-encoder';

async function encodeVideo() {
  if (!Mp4Encoder.isSupported()) {
    console.error('WebCodecs or Workers not supported.');
    return;
  }

  const config = {
    width: 1280,
    height: 720,
    frameRate: 30,
    videoBitrate: 2_000_000, // 2 Mbps
    audioBitrate: 128_000,  // 128 kbps
    sampleRate: 48000,
    channels: 2,
    // codec: { video: 'avc', audio: 'aac' } // Optional, defaults to H.264/AAC
  };

  const encoder = new Mp4Encoder(config);

  try {
    await encoder.initialize(
      (processedFrames, totalFrames) => {
        console.log(`Progress: ${processedFrames}/${totalFrames}`);
      },
      /* totalFrames (optional) */ 300
    );

    const canvas = document.createElement('canvas');
    canvas.width = config.width;
    canvas.height = config.height;
    const ctx = canvas.getContext('2d');

    // Example: Encode 300 frames
    for (let i = 0; i < 300; i++) {
      // Draw something on the canvas
      ctx.fillStyle = `hsl(${(i * 5) % 360}, 100%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'white';
      ctx.font = '50px Arial';
      ctx.fillText(`Frame ${i + 1}`, 50, 100);

      await encoder.addVideoFrame(canvas);
    }

    // Example: Create a silent audio track for the duration
    const audioDurationSeconds = 300 / config.frameRate;
    const audioContext = new AudioContext();
    const silentAudioBuffer = audioContext.createBuffer(
      config.channels,
      audioContext.sampleRate * audioDurationSeconds,
      audioContext.sampleRate
    );
    // You would typically fill this buffer with actual audio data
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

  } catch (error: any) { // Changed from error to error: any for broader compatibility
    console.error('Encoding failed:', error);
    // Handle Mp4EncoderError types for specific issues
    if (error.type === 'not-supported') { // Assuming error has a type property, need Mp4EncoderError import for strong typing
      // ...
    }
  }
}

encodeVideo();
```

## API

(Coming soon - link to generated API docs or list key methods here)

- `Mp4Encoder.isSupported(): boolean`
- `new Mp4Encoder(config: EncoderConfig)`
- `encoder.initialize(onProgress?: ProgressCallback, totalFrames?: number, onError?: ErrorCallback): Promise<void>`
- `encoder.addVideoFrame(frameSource: CanvasImageSource): Promise<void>`
- `encoder.addAudioBuffer(audioBuffer: AudioBuffer): Promise<void>`
- `encoder.finalize(): Promise<Uint8Array>`
- `encoder.cancel(): void`

## Development

- Clone the repository.
- Install dependencies: `npm install`
- Build: `npm run build`
- Test: `npm test` (this will also generate a coverage report in `./coverage`)
- Lint: `npm run lint`
- Format: `npm run format`

## License

MIT
