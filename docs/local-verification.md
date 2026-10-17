# Ubuntuローカル環境の実動作確認

この記録は、この作業環境で実際に行った確認です。自動E2Eの代替モデルによる結果とは分けています。APIキー・トークンは記録しません。

## 用意した環境

- OS標準のPython 3.14.4は変更していません。
- uvをユーザー領域へ導入し、Python 3.12.15を`.venv-whisper`用に用意しました。
- `services/whisper/requirements.txt`を専用仮想環境へインストールしました。
- faster-whisper `small`をHugging Faceからダウンロードし、CPU / int8 / 4スレッドで起動しました。
- 既存の別プロジェクトが8787番を使っていたため、この環境の`.env`ではAPIを8788番へ変更しました。既存プロセスは停止・変更していません。
- Web UI: `http://127.0.0.1:5173/`
- API: `http://127.0.0.1:8788/`
- Whisper: `http://127.0.0.1:8790/`
- 翻訳・用語集: OpenCode Go / `glm-5.3-flash`。キーはローカル`.env`のみ、ファイル権限600、Git管理外です。

## 実音声から字幕まで

公開されているwhisper.cppの11秒のJFK演説サンプルを利用しました。

出典: https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav

専用の一時ブラウザで、この音声を通常のファイル入力UIからアップロードしました。Whisperや翻訳API、ネットワーク応答は代替していません。ブラウザ用ツールのファイル受け渡し制約のため、ファイル入力の確認にはリポジトリのPlaywrightを使用しました。

確認した経路:

```text
ファイル選択UI
  → IndexedDB / WebSocket
  → サーバーの音声保存・SQLite
  → ローカルWhisper
  → 実際のOpenCode Go API
  → 原文・訳文のUI表示
  → セッション完了
```

認識された原文:

> And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.

日本語訳も画面へ表示され、SQLiteに`provider=opencode-go`、`model=glm-5.3-flash`で保存されました。11秒のファイル全体で、アップロードから字幕表示まで約5〜8秒でした。これはライブ入力の字幕遅延を測った値ではありません。

証跡はローカルの`.runtime/live-file-translation.png`です。`.runtime`はGit管理外です。

## 実動画の情報と用語集

`HDdbU10r7Js`について、実際のYouTube oEmbedから次を取得しました。

- タイトル: State of Agentic Coding #11 with Geoff, Armin, and Ben
- チャンネル: Armin Ronacher

この情報から、実際のGo APIで話題・用語集が生成され、UIへ反映されることを確認しました。埋め込みプレーヤーも実際のYouTubeから読み込まれ、動画タイトルと再生ボタンが表示されました。

最初の生成ではJSON／項目の形式不正が発生しました。形式不正時のみ同モデル・同期限で1回再生成する処理を追加し、形式不正の継続、出力上限、認証・利用枠エラーの非再試行を自動テストしています。未知の応答を無理にJSONへ修復したり、別モデルや別認証へ切り替えたりはしません。

**生成できることと品質が良いことは別です。** 実際の話題文には不自然な訳語も見られました。動画情報だけの候補で、動画全編の内容を理解・要約したものではありません。技術用語の認識精度や翻訳品質を、この短い確認だけで保証しません。

## 再起動・保護

このプロジェクトのプロセスだけを停止・再起動し、次を確認しました。

- Whisper、API、Web UIが再び起動する。
- 実音声の原文・訳文・完了状態がSQLiteから復元される。
- 動画情報・生成済み用語集が残る。
- 別プロジェクトの8787番は停止しない。
- `.env`の権限600、Git除外が維持される。

この作業で起動したバックグラウンド実行を停止する場合（録音停止・未送信0を先に確認）:

```sh
cd ~/Documents/realtime-translate-tab
bash .runtime/stop.sh
```

このローカル補助スクリプトはPID・作業フォルダー・プロセスグループ・起動コマンドを確認してから、このプロジェクトのグループだけへ停止信号を送ります。`.runtime`はこの環境用の生成物で、クローンには含まれません。

次回、通常のターミナルで起動する場合:

```sh
cd ~/Documents/realtime-translate-tab
export PATH="$HOME/.local/bin:$PATH"
pnpm dev:local
```

この場合はCtrl+Cで停止できます。ログはバックグラウンド起動時のみ`.runtime/dev.log`です。

## 自動テストと残る確認

- 型チェック、ビルド、差分の空白チェック: 通過
- セットアップ・単体・HTTP/WebSocketテスト: 合計132件通過（セッション復元修正を含む）
- モデル等を代替したブラウザE2E: 10件通過（直接リンク・一時的な復元障害からの回復を含む）
- 上記とは別に、公開音声＋実Whisper＋実Go APIでのUI表示を確認

**未確認:** 利用者のChrome/Edgeで、このアプリ自身のタブ音声を共有して再生した、実際のYouTube音声からの字幕。共有対象と「タブの音声を共有」は利用者のブラウザでの許可が必要です。自動化のために共有許可やYouTubeの制限を回避してはいません。Goの用途条件に適合することも、API応答の成功だけでは保証できません。
