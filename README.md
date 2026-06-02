# TripMatch 🗺️

団体旅行のグループ分けを、参加者の希望を考慮して自動で行うWebアプリ。

## セットアップ

### 1. 依存関係のインストール
```bash
npm install
```

### 2. 環境変数の設定
`.env.local` ファイルを作成して以下を記入：
```
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_FIREBASE_DATABASE_URL=https://your_project-default-rtdb.asia-southeast1.firebasedatabase.app
```

### 3. ローカル起動
```bash
npm run dev
```

### 4. ビルド
```bash
npm run build
```

## Vercelへのデプロイ

1. GitHubにpush
2. Vercelでプロジェクトをインポート
3. Environment VariablesにすべてのVITE_*変数を設定
4. デプロイ

## Firebase Realtime Database ルール（本番）

```json
{
  "rules": {
    "sessions": {
      "$sessionId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```
