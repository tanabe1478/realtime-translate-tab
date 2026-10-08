# Local Whisper sidecar

`faster-whisper`をローカルHTTPサービスとして動かします。音声は外部へ送信されません。

```powershell
pnpm whisper:setup
pnpm whisper:start
```

初回起動時に`.env`の`WHISPER_MODEL`をHugging Faceからダウンロードします。

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
