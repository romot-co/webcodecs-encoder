import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/audio-worklet-processor.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: ['src/worker.ts'],
    format: ['iife'],
    outExtension() {
      return {
        js: '.js',
      };
    },
    platform: 'browser',
    outDir: 'dist',
    name: 'worker',
    globalName: 'EncoderWorkerGlobal',
    sourcemap: true,
  },
]); 