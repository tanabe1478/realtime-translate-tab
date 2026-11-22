import { useState, type FormEvent } from "react";
import { getYouTubeEmbedUrl, getYouTubeWatchUrl, parseYouTubeUrl, type YouTubeVideo } from "./youtube.js";

interface YouTubePlayerProps {
  video: YouTubeVideo | null;
  disabled: boolean;
  onVideoChange(video: YouTubeVideo): void;
}

export function YouTubePlayer({ video, disabled, onVideoChange }: YouTubePlayerProps) {
  const [url, setUrl] = useState(() => video ? getYouTubeWatchUrl(video) : "");
  const [error, setError] = useState<string | null>(null);

  function loadVideo(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (disabled) return;
    const next = parseYouTubeUrl(url);
    if (!next) {
      setError("YouTubeの動画URLを入力してください（youtube.com/watch、youtu.be、Shorts、ライブに対応）。");
      return;
    }
    setError(null);
    onVideoChange(next);
  }

  return (
    <section className="youtube-section" aria-label="YouTubeプレーヤー">
      <form className="youtube-form" onSubmit={loadVideo}>
        <label className="field-label" htmlFor="youtube-url">YouTubeの動画URL</label>
        <div className="youtube-url-row">
          <input
            id="youtube-url"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(event) => { setUrl(event.target.value); setError(null); }}
            disabled={disabled}
            aria-invalid={error !== null}
            aria-describedby={error ? "youtube-url-error" : "youtube-help"}
          />
          <button className="ghost-button" type="submit" disabled={disabled || !url.trim()}>動画を表示</button>
        </div>
        {error && <p className="youtube-error" id="youtube-url-error" role="alert">{error}</p>}
      </form>

      {video ? (
        <div className="youtube-player-frame">
          <iframe
            key={`${video.id}:${video.startSeconds}`}
            src={getYouTubeEmbedUrl(video)}
            title="YouTube動画プレーヤー"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="youtube-placeholder">
          <span aria-hidden="true">▶</span>
          <div><strong>動画と翻訳を、この画面で。</strong><p>URLを入力して動画を表示すると、ここでYouTubeを視聴できます。</p></div>
        </div>
      )}
      <p className="youtube-help" id="youtube-help">
        {video
          ? "「翻訳を開始」→ 共有画面でこのアプリのタブを選択 →「タブの音声を共有」をオン → 動画を再生。原文・翻訳は下に表示されます。"
          : "別のYouTubeタブを開く必要はありません。音声の取得には、開始時にブラウザの共有許可が必要です。"}
      </p>
      {video && <p className="youtube-restriction">埋め込みが禁止された動画や、YouTube側で視聴制限のある動画は再生できない場合があります。</p>}
    </section>
  );
}
