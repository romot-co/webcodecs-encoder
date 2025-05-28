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

### 基本的な使用法

```typescript
import { encode, encodeStream, canEncode } from 'webcodecs-encoder';

// WebCodecs対応チェック
const isSupported = await canEncode({
  video: { codec: 'avc1.42001f' }, // H.264
  audio: { codec: 'mp4a.40.2' }    // AAC
});

if (!isSupported) {
  console.error('WebCodecsがサポートされていません');
  return;
}

// フレーム配列をエンコード（MP4形式）
const frames = [canvas1, canvas2, canvas3]; // Canvas要素の配列
const mp4Data = await encode(frames, {
  width: 1280,
  height: 720,
  quality: 'medium',
  container: 'mp4',
  frameRate: 30
});

// エンコード結果をファイルとして保存
const blob = new Blob([mp4Data], { type: 'video/mp4' });
const url = URL.createObjectURL(blob);
```

### ストリーミングエンコード

```typescript
import { encodeStream } from 'webcodecs-encoder';

// ストリーミング形式でエンコード（WebM形式）
const stream = await encodeStream({
  width: 1280,
  height: 720,
  quality: 'high',
  container: 'webm',
  frameRate: 30
});

// フレームを順次追加
stream.addFrame(canvas1);
stream.addFrame(canvas2);
// ...

// エンコード完了
const webmData = await stream.finalize();
```

## 動作要件

- **ブラウザ環境**: Chrome 94+, Edge 94+, Firefox (実験的サポート)
- **WebCodecs API対応ブラウザ**
- **Web Workers対応**

> **注意**: WebCodecs APIはブラウザ専用技術です。Node.js環境では動作しません。

## ライセンス

MIT 