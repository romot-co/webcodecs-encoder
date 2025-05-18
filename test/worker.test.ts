import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const config = {
  width: 160,
  height: 120,
  frameRate: 30,
  videoBitrate: 1000,
  audioBitrate: 64,
  sampleRate: 48000,
  channels: 1,
};

let postMessage: any;
let Mp4MuxerWrapperMock: any;
let addVideoChunk: any;
let addAudioChunk: any;
let finalizeMock: any;

beforeEach(async () => {
  vi.resetModules();
  postMessage = vi.fn();
  (global as any).self = { postMessage, onmessage: null } as any;
  (global as any).postMessage = postMessage;

  addVideoChunk = vi.fn();
  addAudioChunk = vi.fn();
  finalizeMock = vi.fn(() => new Uint8Array([1, 2, 3]));
  Mp4MuxerWrapperMock = vi.fn(() => ({
    addVideoChunk,
    addAudioChunk,
    finalize: finalizeMock,
  }));

  vi.doMock('../src/mp4muxer', () => ({ Mp4MuxerWrapper: Mp4MuxerWrapperMock }));

  const createEncoder = () => ({
    configure: vi.fn(),
    encode: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
  });

  (global as any).VideoEncoder = vi.fn(() => createEncoder());
  (global as any).AudioEncoder = vi.fn(() => createEncoder());
  (global as any).VideoFrame = class { constructor(public bitmap: any, public opts: any) {} close() {} };
  (global as any).AudioData = class { constructor(public opts: any) {} close() {} };

  await import('../src/worker');
});

afterEach(() => {
  vi.resetModules();
  delete (global as any).VideoEncoder;
  delete (global as any).AudioEncoder;
  delete (global as any).VideoFrame;
  delete (global as any).AudioData;
  delete (global as any).self;
  delete (global as any).postMessage;
});

describe('worker', () => {
  it('initializes and finalizes', async () => {
    await (global as any).self.onmessage({ data: { type: 'initialize', config } });
    expect(postMessage).toHaveBeenCalledWith({ type: 'initialized' });

    await (global as any).self.onmessage({ data: { type: 'finalize' } });
    expect(finalizeMock).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'finalized', output: expect.any(Uint8Array) },
      expect.any(Object)
    );
  });

  it('handles cancel message', async () => {
    await (global as any).self.onmessage({ data: { type: 'initialize', config } });
    postMessage.mockClear();
    await (global as any).self.onmessage({ data: { type: 'cancel' } });
    expect(postMessage).toHaveBeenCalledWith({ type: 'cancelled' });
  });
});
