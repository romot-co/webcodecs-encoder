import { describe, it, expect } from 'vitest';
import { inferAndBuildConfig } from '../src/utils/config-parser';
import { createEncoder } from '../src/factory/encoder';

describe('config-parser', () => {
  it('does not consume async iterables when inferring config', async () => {
    async function* frameGenerator() {
      for (let i = 0; i < 3; i += 1) {
        yield { id: i } as const;
      }
    }

    const asyncIterable = frameGenerator();

    await inferAndBuildConfig(asyncIterable as any);

    const ids: number[] = [];
    for await (const frame of asyncIterable as any) {
      ids.push(frame.id);
    }

    expect(ids).toEqual([0, 1, 2]);
  });

  it('respects video:false when building encoder config', async () => {
    const config = await inferAndBuildConfig([], {
      video: false,
      audio: { codec: 'aac', bitrate: 128_000 },
      container: 'mp4',
    });

    expect(config.width).toBe(0);
    expect(config.height).toBe(0);
    expect(config.codec?.video).toBeUndefined();
    expect(config.audioBitrate).toBeGreaterThan(0);
  });

  it('keeps video:false when extending encoder factories', () => {
    const baseFactory = createEncoder({
      video: false,
      audio: { codec: 'aac', bitrate: 128_000 },
    });

    const extendedFactory = baseFactory.extend({
      audio: { bitrate: 64_000 },
    });

    expect(baseFactory.getConfig().video).toBe(false);
    expect(extendedFactory.getConfig().video).toBe(false);
    expect(extendedFactory.getConfig().audio).toMatchObject({
      codec: 'aac',
      bitrate: 64_000,
    });
  });
});
