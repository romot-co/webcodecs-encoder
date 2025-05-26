import { WebCodecsEncoder } from 'webcodecs-encoder';

async function encodeVideoRealtime() {
  if (!WebCodecsEncoder.isSupported()) {
    console.error('WebCodecs or Workers not supported.');
    return;
  }

  const config = {
    latencyMode: 'realtime', // Enable real-time streaming
    width: 1280,
    height: 720,
    frameRate: 30,
    codec: {
      video: 'vp9', // Example: VP9 for lower latency
      audio: 'opus',
    },
    videoBitrate: 2_000_000,
    audioBitrate: 128_000,
    sampleRate: 48000,
    channels: 2,
  };

  let mediaSource;
  let sourceBuffer;
  const videoElement = document.createElement('video');
  videoElement.controls = true;
  document.body.appendChild(videoElement);

  if ('MediaSource' in window && MediaSource.isTypeSupported(`video/mp4; codecs="${config.codec.video}.0, ${config.codec.audio}"`)) { // Basic check
    mediaSource = new MediaSource();
    videoElement.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', async () => {
      console.log("MediaSource opened");

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
        onProgress: (processedFrames, totalFrames) => {
          console.log(`Progress (Real-time): ${processedFrames}`);
        },
        onError: (error) => {
          console.error('Encoder error during initialization or processing:', error);
        }
      });

      // Determine actual codecs used after potential fallbacks
      const actualVideoCodec = encoder.getActualVideoCodec() || config.codec.video;
      const actualAudioCodec = encoder.getActualAudioCodec() || config.codec.audio;

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

  const encoder = new WebCodecsEncoder(config);

  async function startEncoding() {
    console.log("Starting encoding process...");
    try {

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

        await encoder.addCanvasFrame(canvas);
        await new Promise(resolve => setTimeout(resolve, 1000 / config.frameRate)); // Simulate real-time frame generation
      }

      // For real-time audio, you would continuously call addAudioBuffer
      // or addAudioData when you already have AudioData chunks
      // For this example, we'll add a silent track matching video duration after frames.
      // In a true real-time scenario, audio and video would be interleaved.
      const audioContext = new AudioContext({ sampleRate: config.sampleRate });
      const silentAudioBuffer = audioContext.createBuffer(
        config.channels,
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
