import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canEncode } from '../src/utils/can-encode';

// Mock WebCodecs API
const mockVideoEncoder = {
  isConfigSupported: vi.fn(),
  configure: vi.fn(),
  encode: vi.fn(),
  flush: vi.fn(),
  close: vi.fn()
};

const mockAudioEncoder = {
  isConfigSupported: vi.fn(),
  configure: vi.fn(),
  encode: vi.fn(),
  flush: vi.fn(),
  close: vi.fn()
};

describe('canEncode utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock entire WebCodecs API
    global.VideoEncoder = {
      isConfigSupported: mockVideoEncoder.isConfigSupported
    } as any;
    
    global.AudioEncoder = {
      isConfigSupported: mockAudioEncoder.isConfigSupported
    } as any;
    
    // Mock other APIs required by isWebCodecsSupported()
    global.VideoFrame = class VideoFrame {} as any;
    global.AudioData = class AudioData {} as any;
  });

  describe('Basic codec support checking', () => {
    it('should return true when both video and audio codecs are supported', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        video: { codec: 'avc' },
        audio: { codec: 'aac' }
      });

      expect(result).toBe(true);
      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'avc1.42001f',
        width: 640,
        height: 480,
        bitrate: 1000000,
        framerate: 30
      });
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
        sampleRate: 48000,
        bitrate: 128000
      });
    });

    it('should return false when video codec is not supported', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: false });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        video: { codec: 'vp9' },
        audio: { codec: 'opus' }
      });

      expect(result).toBe(false);
    });

    it('should return false when audio codec is not supported', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: false });

      const result = await canEncode({
        video: { codec: 'avc' },
        audio: { codec: 'opus' }
      });

      expect(result).toBe(false);
    });

    it('should return true for default audio+video encoding when video codec is supported', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        video: { codec: 'vp8' }
      });

      expect(result).toBe(true);
      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalled();
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalled();
    });

    it('should return false when default audio codecs are unavailable', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: false });

      const result = await canEncode({
        video: { codec: 'vp8' }
      });

      expect(result).toBe(false);
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalled();
    });

    it('should return true for audio-only encoding when audio codec is supported and video is disabled', async () => {
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        audio: { codec: 'aac' },
        video: false
      });

      expect(result).toBe(true);
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalled();
      expect(mockVideoEncoder.isConfigSupported).not.toHaveBeenCalled();
    });

    it('should handle mp3 audio codec by probing support', async () => {
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        audio: { codec: 'mp3' },
        video: false
      });

      expect(typeof result).toBe('boolean');
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({ codec: 'mp3' })
      );
    });
  });

  describe('Default configuration handling', () => {
    it('should use default configuration when no specific config provided', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode();

      expect(result).toBe(true);
      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'avc1.42001f',
        width: 640,
        height: 480,
        bitrate: 1000000,
        framerate: 30
      });
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'mp4a.40.2',
        numberOfChannels: 2,
        sampleRate: 48000,
        bitrate: 128000
      });
    });

    it('should merge custom config with defaults', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        video: { 
          codec: 'vp9',
          bitrate: 2000000
        },
        audio: {
          codec: 'opus',
          sampleRate: 44100
        }
      });

      expect(result).toBe(true);
      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'vp09.00.50.08',
        width: 640,
        height: 480,
        bitrate: 2000000,
        framerate: 30
      });
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'opus',
        numberOfChannels: 2,
        sampleRate: 44100,
        bitrate: 128000
      });
    });
  });

  describe('Codec string generation', () => {
    it('should generate correct AVC codec strings', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: { codec: 'avc' }
      });

      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'avc1.42001f'
        })
      );
    });

    it('should generate correct VP9 codec strings', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: { codec: 'vp9' }
      });

      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'vp09.00.50.08'
        })
      );
    });

    it('should use VP8 codec string as-is', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: { codec: 'vp8' }
      });

      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'vp8'
        })
      );
    });

    it('should pass codecString, quantizer, and avc.format to video support probe', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: {
          codec: 'avc',
          codecString: 'avc1.640028',
          quantizer: 24,
          avc: { format: 'annexb' },
        },
        audio: false,
      });

      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'avc1.640028',
          quantizer: 24,
          avc: { format: 'annexb' },
        }),
      );
    });

    it('should pass hevc.format to video support probe', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: {
          codec: 'hevc',
          hevc: { format: 'annexb' },
        },
        audio: false,
      });

      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'hvc1',
          hevc: { format: 'annexb' },
        }),
      );
    });

    it('should generate correct AAC codec strings', async () => {
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        audio: { codec: 'aac' },
        video: false
      });

      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'mp4a.40.2'
        })
      );
    });

    it('should use Opus codec string as-is', async () => {
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        audio: { codec: 'opus' },
        video: false
      });

      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'opus'
        })
      );
    });

    it('should pass codecString and aac.format to audio support probe', async () => {
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: false,
        audio: {
          codec: 'aac',
          codecString: 'mp4a.40.5',
          aac: { format: 'adts' },
        },
      });

      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith(
        expect.objectContaining({
          codec: 'mp4a.40.5',
          aac: { format: 'adts' },
        }),
      );
    });
  });

  describe('Error handling', () => {
    it('should return false when VideoEncoder.isConfigSupported throws', async () => {
      mockVideoEncoder.isConfigSupported.mockRejectedValue(new Error('API not supported'));

      const result = await canEncode({
        video: { codec: 'avc' }
      });

      expect(result).toBe(false);
    });

    it('should return false when AudioEncoder.isConfigSupported throws', async () => {
      mockAudioEncoder.isConfigSupported.mockRejectedValue(new Error('API not supported'));

      const result = await canEncode({
        audio: { codec: 'aac' },
        video: false
      });

      expect(result).toBe(false);
    });

    it('should return false when VideoEncoder API is not available', async () => {
      // Set VideoEncoder to undefined
      global.VideoEncoder = undefined as any;

      const result = await canEncode({
        video: { codec: 'avc' }
      });

      expect(result).toBe(false);
    });

    it('should return false when AudioEncoder API is not available', async () => {
      // Set AudioEncoder to undefined
      global.AudioEncoder = undefined as any;

      const result = await canEncode({
        audio: { codec: 'aac' },
        video: false
      });

      expect(result).toBe(false);
    });

    it('should handle partial API support gracefully', async () => {
      // VideoEncoder is available but AudioEncoder is undefined
      global.AudioEncoder = undefined as any;
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        video: { codec: 'avc' },
        audio: { codec: 'aac' }
      });

      expect(result).toBe(false);
    });
  });

  describe('Edge cases and complex configurations', () => {
    it('should handle empty configuration object', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({});

      expect(result).toBe(true);
    });

    it('should handle high-resolution video configurations', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: {
          codec: 'avc',
          bitrate: 50000000
        }
      });

      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'avc1.42001f',
        width: 640,
        height: 480,
        bitrate: 50000000,
        framerate: 30
      });
    });

    it('should handle high-quality audio configurations', async () => {
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        audio: {
          codec: 'aac',
          sampleRate: 96000,
          channels: 6,
          bitrate: 512000
        }
      });

      expect(result).toBe(true);
      expect(mockAudioEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'mp4a.40.2',
        numberOfChannels: 6,
        sampleRate: 96000,
        bitrate: 512000
      });
    });

    it('should handle unsupported codec gracefully', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: false });

      const result = await canEncode({
        video: { codec: 'av1' as any } // Hypothetical unsupported codec
      });

      expect(result).toBe(false);
    });

    it('should handle mixed support scenarios', async () => {
      // First check fails, second check succeeds (testing fallback processing)
      mockVideoEncoder.isConfigSupported
        .mockResolvedValueOnce({ supported: false })
        .mockResolvedValueOnce({ supported: true });

      const result = await canEncode({
        video: { codec: 'vp9' }
      });

      // Result is based on the first check (false)
      expect(result).toBe(false);
    });

    it('should validate numeric parameters', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      await canEncode({
        video: {
          codec: 'avc',
          bitrate: 1000000
        }
      });

      // Verify that configuration is passed to encoder
      expect(mockVideoEncoder.isConfigSupported).toHaveBeenCalledWith({
        codec: 'avc1.42001f',
        width: 640,
        height: 480,
        bitrate: 1000000,
        framerate: 30
      });
    });
  });

  describe('Return value analysis', () => {
    it('should return boolean true for full support', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });
      mockAudioEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const result = await canEncode({
        video: { codec: 'avc' },
        audio: { codec: 'aac' }
      });

      expect(result).toBe(true);
      expect(typeof result).toBe('boolean');
    });

    it('should return boolean false for no support', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: false });

      const result = await canEncode({
        video: { codec: 'avc' }
      });

      expect(result).toBe(false);
      expect(typeof result).toBe('boolean');
    });

    it('should always return a Promise that resolves to boolean', async () => {
      mockVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true });

      const promise = canEncode({ video: { codec: 'avc' } });

      expect(promise).toBeInstanceOf(Promise);
      const result = await promise;
      expect(typeof result).toBe('boolean');
    });
  });
}); 
