# Local Whisper sidecar

`faster-whisper`をローカルHTTPサービスとして動かします。音声は外部へ送信されません。

```powershell
pnpm whisper:setup
pnpm whisper:start
```

初回起動時に`.env`の`WHISPER_MODEL`をHugging Faceからダウンロードします。`small`は数百MB程度です。

Pythonは3.10〜3.12を使います。Ubuntu標準のPythonが3.14でも置き換えず、Whisper専用の仮想環境を作ります。セットアップは既存の`.venv-whisper`を再利用し、なければ`.env`の`WHISPER_PYTHON`（任意の絶対パス指定）、またはPython 3.12 / 3.11 / 3.10を探します。未対応のPythonで既存環境を上書きすることはありません。uvを使う手順はルートのREADMEを参照してください。

推奨設定:

```env
# CPU向け
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8

# NVIDIA GPU向け（十分なVRAMがある場合）
# WHISPER_MODEL=large-v3-turbo
# WHISPER_DEVICE=cuda
# WHISPER_COMPUTE_TYPE=float16
```

API:

- `GET /health`
- `POST /transcribe`（音声バイナリをbodyへ設定）
