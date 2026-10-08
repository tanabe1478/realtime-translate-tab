# Realtime Translate

Windows-firstのリアルタイム文字起こし・翻訳Webアプリです。Chrome/Edgeで共有したYouTubeタブ、マイク、音声・動画ファイルを入力できます。

## 処理構成

```text
ブラウザ音声
  → ローカル faster-whisper（文字起こし）
  → ChatGPT subscription OAuth（翻訳）
  → WebSocketで字幕表示
```

音声認識に外部APIキーは使いません。翻訳はChatGPT Plus/Pro等のサブスクリプションへブラウザでサインインします。通常のOpenAI APIキーもフォールバックとして利用できますが必須ではありません。

## 現在のMVP

- YouTubeなどのブラウザタブ音声を`getDisplayMedia()`で取得
- マイク音声を`getUserMedia()`で取得
- 16 kHz mono WAVを5秒単位で生成
- 送信前にIndexedDBへ保存
- WebSocketのACK後にローカルチャンクを削除
- サーバーでは音声を先にファイル保存し、SQLiteへ記録
- 切断時の再接続・再送、サーバー側の重複排除
- ローカル`faster-whisper`による文字起こし
- `@earendil-works/pi-ai`のChatGPT OAuthによる翻訳
- 25 MB以下の音声・動画ファイル入力

## 必要環境

- Node.js 24（`node:sqlite`を使用）
- pnpm 10
- Python 3.10〜3.12
- Windows版ChromeまたはEdge
- ChatGPTサブスクリプション

## 初回セットアップ

```powershell
copy .env.example .env
pnpm install
pnpm whisper:setup
pnpm auth:openai
```

`pnpm auth:openai`が表示するURLをブラウザで開き、ChatGPTへサインインします。OAuth資格情報は`data/auth.json`へ保存され、Git管理から除外されます。チャットやIssueへトークンを貼り付けないでください。

### Whisperモデル

`.env`の初期値はCPUでも動かしやすい多言語`small`です。

```env
WHISPER_MODEL=small
WHISPER_DEVICE=auto
WHISPER_COMPUTE_TYPE=default
```

NVIDIA GPUと十分なVRAMがある場合は次を検討できます。

```env
WHISPER_MODEL=large-v3-turbo
WHISPER_DEVICE=cuda
WHISPER_COMPUTE_TYPE=float16
```

モデルは`pnpm whisper:start`の初回起動時にダウンロードされます。

## 起動

Whisper、TypeScriptサーバー、Web UIをまとめて起動します。

```powershell
pnpm dev:local
```

ブラウザで <http://127.0.0.1:5173> を開きます。

個別に起動する場合:

```powershell
# Terminal 1
pnpm whisper:start

# Terminal 2
pnpm dev
```

### YouTubeを翻訳する

1. 入力元の「YouTube」を選ぶ
2. 「キャプチャを開始」を押す
3. Chrome/Edgeの共有画面でYouTubeタブを選ぶ
4. **「タブの音声を共有」**を有効にする
5. YouTubeを再生する

許可なしの自動取得、YouTube URLからの直接ダウンロード、PC全体の音声取得は行いません。

## 認証の解除

```powershell
pnpm auth:openai:logout
```

## 本番相当の起動

Whisperは別プロセスで起動した状態にします。

```powershell
pnpm build
pnpm whisper:start
pnpm start
```

<http://127.0.0.1:8787> でWeb UIとAPIを同一オリジン配信します。

## 確認コマンド

```powershell
pnpm typecheck
pnpm test
pnpm build
```

## 構成

```text
apps/web                 React / AudioWorklet / IndexedDB / WebSocket
apps/server              Node.js / SQLite / provider adapters / ChatGPT OAuth
packages/contracts       DTO、イベント、バイナリ音声フレーム
services/whisper         faster-whisperローカルサイドカー
scripts/whisper.mjs      Whisperセットアップ・起動
architecture.html        アーキテクチャ可視化
```

保存先は`data/realtime-translate.sqlite`、`data/audio/<session-id>/`、`data/auth.json`です。

## pi durable

`pi durable`はまだ実行時依存に入れていません。将来、要約や複数ツールを使う長時間AI分析を追加するときに、`WorkflowRuntime`の任意アダプターとして独立パッケージへ導入します。音声取り込み、ASR、翻訳、アプリケーションDBの正本には使用しません。
