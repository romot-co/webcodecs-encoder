import { defineConfig } from 'tsup';

export default defineConfig([
  // メインエントリポイント
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    outDir: 'dist',
  },
  // ストリーミング機能
  {
    entry: { 'stream/encode-stream': 'src/stream/encode-stream.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    outDir: 'dist',
  },
  // ファクトリ機能
  {
    entry: { 'factory/encoder': 'src/factory/encoder.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    outDir: 'dist',
  },
  // ユーティリティ機能
  {
    entry: { 'utils/can-encode': 'src/utils/can-encode.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    outDir: 'dist',
  },
  // Worker (IIFE形式)
  {
    entry: { 'worker': 'src/worker/encoder-worker.ts' },
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