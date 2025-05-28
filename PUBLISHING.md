# パッケージ公開ガイド

## GitHubでの公開準備

### 1. GitHubリポジトリの作成
```bash
# リポジトリをGitHubに作成し、コードをプッシュ
git init
git add .
git commit -m "Initial commit: WebCodecs encoder package"
git remote add origin https://github.com/romot-co/webcodecs-encoder.git
git push -u origin main
```

### 2. GitHubからのインストール確認
```bash
# 別のプロジェクトでテスト
npm install github:romot-co/webcodecs-encoder
```

## npm公開準備

### 1. npmアカウント設定
```bash
npm login
```

### 2. パッケージ名の可用性確認
```bash
npm view webcodecs-encoder
# 404エラーなら利用可能
```

### 3. バージョン更新
```bash
# パッチバージョン（バグ修正）
npm version patch

# マイナーバージョン（機能追加）
npm version minor

# メジャーバージョン（破壊的変更）
npm version major
```

### 4. npm公開
```bash
# 本番公開前の最終チェック
npm pack --dry-run

# 公開
npm publish
```

## 現在の設定状況

✅ package.jsonの設定完了
- name: webcodecs-encoder
- version: 0.1.0
- main/module/types設定
- exports設定
- repository/homepage設定

✅ ビルド設定完了
- TypeScript → JavaScript変換
- ESM/CJS両対応
- 型定義ファイル生成
- Web Worker対応

✅ パッケージ最適化完了
- ファイルサイズ: 120.8KB
- 必要なファイルのみ含有
- テストファイル除外

## 公開後の確認事項

1. インストールテスト
```bash
npm install webcodecs-encoder
```

2. 基本動作テスト
```typescript
import { canEncode } from 'webcodecs-encoder';
const isSupported = await canEncode();
console.log('WebCodecs support:', isSupported);
```

3. TypeScript型定義確認
```typescript
// IDE補完とエラーチェックが動作することを確認
```

## トラブルシューティング

### パッケージ名が既に使用されている場合
- scoped packageとして公開: `@romot-co/webcodecs-encoder`
- package.jsonの名前を変更

### GitHubからのインストールでエラーが発生する場合
- ビルドが正常に完了していることを確認
- `prepare`スクリプトが正しく設定されていることを確認 