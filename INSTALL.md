# インストールガイド

## GitHubからのインストール（推奨）

```bash
# npm使用の場合
npm install github:romot-co/webcodecs-encoder

# yarn使用の場合  
yarn add github:romot-co/webcodecs-encoder

# pnpm使用の場合
pnpm add github:romot-co/webcodecs-encoder
```

## 使用例

```typescript
import { WebCodecsEncoder } from 'webcodecs-encoder';

// WebCodecs対応チェック
if (!WebCodecsEncoder.isSupported()) {
  console.error('WebCodecsがサポートされていません');
  return;
}

// エンコーダー設定
const config = {
  width: 1280,
  height: 720,
  frameRate: 30,
  videoBitrate: 2_000_000,
  audioBitrate: 128_000,
  sampleRate: 48000,
  channels: 2,
};

// エンコーダー初期化と使用
const encoder = new WebCodecsEncoder(config);
await encoder.initialize();

// フレーム追加やエンコード処理
// ...

const result = await encoder.finalize();
```

## 動作要件

- Node.js 18.0.0以上
- WebCodecs API対応ブラウザ
- Web Workers対応

## ライセンス

MIT 