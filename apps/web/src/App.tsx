import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  PROTOCOL_VERSION,
  type AudioFrameHeader,
  type HealthResponse,
  type OutputMode,
  type PartialUtteranceView,
  type ServerEvent,
  type SessionStatus,
  type SessionView,
  type SourceKind,
  type TranscriptEntry,
  type VideoContextView,
} from "@realtime-translate/contracts";
import { ApiError, correctSession, createSession, getHealth, getSession, stopSession } from "./api.js";
import { decodeAudioFileToMono16k, encodeSamplesToWav, FILE_SAMPLE_RATE, planSilenceSplits } from "./file-audio.js";
import { formatTranscriptText } from "./transcript-export.js";
import { getYouTubeCaptureOptions, PcmAudioCapture, type CapturedChunk } from "./audio-capture.js";
import { ReliableUploader, type ConnectionState } from "./reliable-uploader.js";
import { YouTubePlayer } from "./YouTubePlayer.js";
import { VideoContextPanel } from "./VideoContextPanel.js";
import { getYouTubeWatchUrl, parseYouTubeUrl, type YouTubeVideo } from "./youtube.js";
import { translationAuthLabel, translationProviderLabel } from "./translation-provider.js";
import { forgetMissingSessionId, readLastSessionId, rememberSessionId, sessionIdToRestore } from "./session-navigation.js";
const YOUTUBE_VIDEO_KEY = "realtime-translate:youtube-video";
const MAX_FILE_BYTES = 100 * 1024 * 1024;

type RecorderState = "idle" | "requesting" | "recording" | "stopping" | "processing";
type Notice = { kind: "info" | "warning" | "error" | "success"; text: string };

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>("browser-tab");
  const [youTubeVideo, setYouTubeVideo] = useState<YouTubeVideo | null>(getSavedYouTubeVideo);
  const [videoContext, setVideoContext] = useState<VideoContextView | null>(null);
  const [fileOutputMode, setFileOutputMode] = useState<OutputMode>("translate");
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("ja");
  const [session, setSession] = useState<SessionView | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [partialUtterance, setPartialUtterance] = useState<PartialUtteranceView | null>(null);
  const [recorderState, setRecorderState] = useState<RecorderState>("idle");
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [pendingChunks, setPendingChunks] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState("待機中");
  /** Utterance seq -> reason, for corrections that failed in this browser session. */
  const [correctionFailures, setCorrectionFailures] = useState<ReadonlyMap<number, string>>(new Map());
  const [requestingCorrection, setRequestingCorrection] = useState(false);

  const uploaderRef = useRef<ReliableUploader | null>(null);
  const captureRef = useRef<PcmAudioCapture | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  const stoppingRef = useRef(false);
  const fileChunkTotalRef = useRef<number | null>(null);
  const awaitingUploadRef = useRef(false);
  const pendingRef = useRef(0);
  const nextSeqRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const refreshHealth = async () => {
      try {
        const result = await getHealth();
        if (!cancelled) setHealth(result);
      } catch (error) {
        if (!cancelled) {
          setHealth(null);
          setNotice({ kind: "error", text: `サーバーに接続できません: ${messageOf(error)}` });
        }
      }
    };
    void refreshHealth();
    const timer = window.setInterval(() => { void refreshHealth(); }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lastSessionId = sessionIdToRestore(window.location.search, readLastSessionId());
      if (!lastSessionId) return;
      try {
        const snapshot = await getSession(lastSessionId);
        if (cancelled) return;
        setSession(snapshot.session);
        sessionRef.current = snapshot.session;
        setTranscript(snapshot.transcript);
        setSourceKind(snapshot.session.sourceKind);
        setSourceLanguage(snapshot.session.sourceLanguage ?? "");
        setTargetLanguage(snapshot.session.targetLanguage);
        setFileOutputMode(snapshot.session.outputMode);
        if (snapshot.session.videoId) setYouTubeVideo((saved) => saved?.id === snapshot.session.videoId ? saved : { id: snapshot.session.videoId!, startSeconds: 0 });
        setRecorderState(snapshot.session.status === "recording" ? "idle" : statusToRecorderState(snapshot.session.status));
        nextSeqRef.current = snapshot.session.lastAckedSeq + 1;
        rememberSessionId(snapshot.session.id);
        setPipelineStatus(`保存済み${snapshot.transcript.length}発話を復元`);
        await connectUploader(snapshot.session.id);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) forgetMissingSessionId(lastSessionId);
        setNotice({ kind: "error", text: `保存済み字幕を復元できませんでした。${messageOf(error)}${error instanceof ApiError && error.status === 404 ? "" : " セッションの記録は保持しています。接続後に再読み込みしてください。"}` });
      }
    })();
    return () => { cancelled = true; };
    // The initial restore intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const panel = transcriptScrollRef.current;
    if (panel && followTranscriptRef.current) panel.scrollTop = panel.scrollHeight;
  }, [transcript, partialUtterance, notice, youTubeVideo, sourceKind]);

  useEffect(() => {
    if (pendingChunks === 0) notifyUploadCompleteIfAwaited();
  }, [pendingChunks]);

  useEffect(() => {
    if (session?.outputMode === "correct" && session.status === "completed" && transcript.length > 0 && transcript.every((entry) => entry.correction)) {
      setPipelineStatus("校正完了");
    }
  }, [session, transcript]);

  useEffect(() => () => {
    uploaderRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function connectUploader(sessionId: string): Promise<ReliableUploader> {
    uploaderRef.current?.close();
    const uploader = new ReliableUploader(sessionId, {
      onEvent: handleServerEvent,
      onConnectionState: setConnection,
      onPendingCount: (count) => { pendingRef.current = count; setPendingChunks(count); },
      onError: (text) => setNotice({ kind: "error", text }),
    });
    uploaderRef.current = uploader;
    await uploader.start();
    return uploader;
  }

  function notifyUploadCompleteIfAwaited(): void {
    if (!awaitingUploadRef.current || pendingRef.current > 0) return;
    awaitingUploadRef.current = false;
    setNotice({ kind: "success", text: "アップロード完了。このタブを閉じても文字起こしは続きます。" });
  }

  function handleServerEvent(event: ServerEvent): void {
    if (event.type === "connected") {
      void getSession(event.sessionId).then((snapshot) => {
        setSession(snapshot.session);
        sessionRef.current = snapshot.session;
        setTranscript(snapshot.transcript);
      }).catch(() => undefined);
      return;
    }
    if (event.type === "asr.started") {
      const total = fileChunkTotalRef.current;
      setPipelineStatus(total !== null ? `文字起こし中 · #${event.seq + 1} / ${total}` : `文字起こし中 · #${event.seq + 1}`);
      return;
    }
    if (event.type === "utterance.partial") {
      setPartialUtterance(event.utterance);
      setPipelineStatus(`発話を組み立て中 · #${event.utterance.startSeq + 1}–${event.utterance.endSeq + 1}`);
      return;
    }
    if (event.type === "utterance.final") {
      setPartialUtterance((current) => current && current.endSeq <= event.utterance.endSeq ? null : current);
      setTranscript((current) => {
        const existing = current.find((entry) => entry.utterance.id === event.utterance.id || entry.utterance.seq === event.utterance.seq);
        const next = current.filter((entry) => entry.utterance.id !== event.utterance.id && entry.utterance.seq !== event.utterance.seq);
        next.push({ utterance: event.utterance, translation: existing?.translation ?? null, correction: existing?.correction ?? null });
        return next.sort((left, right) => left.utterance.seq - right.utterance.seq);
      });
      setPipelineStatus(skipsTranslation(sessionRef.current?.outputMode) ? `文字起こし済み · #${event.seq + 1}` : `翻訳中 · #${event.seq + 1}`);
      return;
    }
    if (event.type === "correction.final") {
      setTranscript((current) => current.map((entry) => entry.utterance.id === event.correction.utteranceId ? { ...entry, correction: event.correction } : entry));
      setCorrectionFailures((current) => {
        if (!current.has(event.seq)) return current;
        const next = new Map(current);
        next.delete(event.seq);
        return next;
      });
      setPipelineStatus(`校正中 · #${event.seq + 1}`);
      return;
    }
    if (event.type === "correction.failed") {
      setCorrectionFailures((current) => new Map(current).set(event.seq, event.message));
      setPipelineStatus(`校正エラー · #${event.seq + 1}`);
      return;
    }
    if (event.type === "translation.final") {
      setTranscript((current) => current.map((entry) => entry.utterance.id === event.translation.utteranceId ? { ...entry, translation: event.translation } : entry));
      setPipelineStatus("最新の翻訳まで完了");
      return;
    }
    if (event.type === "processing.skipped") {
      // Transcript-only and proofread sessions never translate: a missing translation login is irrelevant.
      if (event.stage === "translation" && skipsTranslation(sessionRef.current?.outputMode)) return;
      setPipelineStatus(event.stage === "asr" ? "音声保存済み · ASR待機" : "原文保存済み · 翻訳待機");
      setNotice({ kind: "warning", text: event.reason });
      return;
    }
    if (event.type === "processing.failed") {
      setPipelineStatus(`${event.stage.toUpperCase()} エラー`);
      setNotice({ kind: "error", text: event.message });
      return;
    }
    if (event.type === "session.status") {
      setSession((current) => {
        const next = current?.id === event.sessionId ? { ...current, status: event.status } : current;
        sessionRef.current = next;
        return next;
      });
      if (event.status === "completed") {
        setRecorderState("idle");
        const mode = sessionRef.current?.outputMode;
        if (skipsTranslation(mode)) setPipelineStatus(completedStatus(mode));
      }
    }
  }

  async function startLiveCapture(): Promise<void> {
    if (recorderState !== "idle" || pendingChunks > 0 || (sourceKind !== "microphone" && sourceKind !== "browser-tab")) return;
    if (sourceKind === "browser-tab" && !youTubeVideo) return;
    setNotice(null);
    fileChunkTotalRef.current = null;
    setRecorderState("requesting");
    let stream: MediaStream | null = null;
    try {
      stream = sourceKind === "microphone"
        ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        : await navigator.mediaDevices.getDisplayMedia(getYouTubeCaptureOptions());

      if (sourceKind === "browser-tab") {
        const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
        if (surface && surface !== "browser") {
          throw new Error("画面全体やウィンドウではなく、このアプリを開いているブラウザタブを選んでください。");
        }
      }
      if (stream.getAudioTracks().length === 0) {
        throw new Error("音声が共有されていません。このアプリのタブを選び、「タブの音声を共有」をオンにしてください。");
      }
      streamRef.current = stream;

      const created = await createSession({
        sourceKind,
        sourceLanguage: sourceLanguage || null,
        targetLanguage,
        title: sourceKind === "browser-tab"
          ? (videoContext && videoContext.videoId === youTubeVideo?.id && videoContext.targetLanguage === targetLanguage ? videoContext.metadata?.title : null) || `YouTube · ${youTubeVideo?.id}`
          : "Microphone capture",
        videoId: sourceKind === "browser-tab" ? youTubeVideo?.id ?? null : null,
      });
      setSession(created);
      sessionRef.current = created;
      followTranscriptRef.current = true;
      setTranscript([]);
      setPartialUtterance(null);
      setCorrectionFailures(new Map());
      rememberSessionId(created.id);
      nextSeqRef.current = 0;
      const uploader = await connectUploader(created.id);

      const capture = new PcmAudioCapture({
        chunkSeconds: 5,
        onChunk: (chunk) => queueCapturedChunk(created, uploader, chunk),
        onLevel: setAudioLevel,
        onEnded: () => { void stopRecording(); },
      });
      captureRef.current = capture;
      await capture.start(stream);
      setRecorderState("recording");
      setPipelineStatus("録音中 · 5秒ごとに保存");
      setNotice({
        kind: "success",
        text: sourceKind === "browser-tab" ? "タブ音声の取得を開始しました。この画面のYouTubeプレーヤーで動画を再生してください。" : "マイク録音を開始しました。",
      });
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      captureRef.current = null;
      setRecorderState("idle");
      setNotice({ kind: "error", text: messageOf(error) });
    }
  }

  async function queueCapturedChunk(created: SessionView, uploader: ReliableUploader, chunk: CapturedChunk): Promise<void> {
    const seq = nextSeqRef.current;
    nextSeqRef.current += 1;
    const header: AudioFrameHeader = {
      version: PROTOCOL_VERSION,
      sessionId: created.id,
      seq,
      capturedAt: chunk.capturedAt,
      durationMs: chunk.durationMs,
      mimeType: "audio/wav",
      sourceKind: created.sourceKind,
      fileName: `segment-${String(seq).padStart(6, "0")}.wav`,
    };
    await uploader.queue(header, chunk.blob);
  }

  async function stopRecording(): Promise<void> {
    const currentCapture = captureRef.current;
    const currentSession = sessionRef.current;
    if (!currentCapture || !currentSession || stoppingRef.current) return;
    stoppingRef.current = true;
    setRecorderState("stopping");
    setPipelineStatus("最後の音声を保存中");
    try {
      await currentCapture.stop();
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setAudioLevel(0);
      const stopped = await stopSession(currentSession.id, nextSeqRef.current - 1);
      setSession(stopped);
      sessionRef.current = stopped;
      setRecorderState(statusToRecorderState(stopped.status));
      setPipelineStatus(stopped.status === "completed" ? "最新の翻訳まで完了" : "残りの文字起こし・翻訳を処理中");
    } catch (error) {
      setRecorderState("idle");
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      stoppingRef.current = false;
    }
  }

  async function processFile(file: File): Promise<void> {
    if (file.size > MAX_FILE_BYTES) {
      setNotice({ kind: "error", text: "現在のMVPでは100MB以下の音声・動画ファイルに対応しています。" });
      return;
    }
    if (fileOutputMode === "correct" && health?.correctionReady !== true) {
      setNotice({ kind: "error", text: health?.correctionMessage ?? "AI校正を利用できません。サーバーの設定を確認してください。" });
      return;
    }
    setNotice(null);
    setRecorderState("processing");
    setPipelineStatus("セッションを作成中");
    fileChunkTotalRef.current = null;
    awaitingUploadRef.current = false;
    nextSeqRef.current = 0;
    let created: SessionView | null = null;
    let queuedChunks = 0;
    try {
      created = await createSession({
        sourceKind: "file",
        sourceLanguage: sourceLanguage || null,
        targetLanguage,
        title: file.name,
        outputMode: fileOutputMode,
      });
      setSession(created);
      sessionRef.current = created;
      followTranscriptRef.current = true;
      setTranscript([]);
      setPartialUtterance(null);
      setCorrectionFailures(new Map());
      rememberSessionId(created.id);
      const uploader = await connectUploader(created.id);

      setPipelineStatus("音声を展開中（再生はしません）");
      const samples = await decodeAudioFileToMono16k(file);
      const ranges = planSilenceSplits(samples, FILE_SAMPLE_RATE);
      if (ranges.length === 0) throw new Error("ファイルに音声がありません。");
      fileChunkTotalRef.current = ranges.length;

      const capturedAt = Date.now();
      for (const [seq, range] of ranges.entries()) {
        setPipelineStatus(`チャンクを保存中 · ${seq + 1} / ${ranges.length}`);
        const header: AudioFrameHeader = {
          version: PROTOCOL_VERSION,
          sessionId: created.id,
          seq,
          capturedAt: new Date(capturedAt + (range.start / FILE_SAMPLE_RATE) * 1000).toISOString(),
          durationMs: Math.round(((range.end - range.start) / FILE_SAMPLE_RATE) * 1000),
          mimeType: "audio/wav",
          sourceKind: "file",
          fileName: `segment-${String(seq).padStart(6, "0")}.wav`,
        };
        await uploader.queue(header, encodeSamplesToWav(samples.subarray(range.start, range.end)));
        queuedChunks += 1;
      }
      awaitingUploadRef.current = true;
      nextSeqRef.current = ranges.length;
      const stopped = await stopSession(created.id, ranges.length - 1);
      setSession(stopped);
      sessionRef.current = stopped;
      setRecorderState(statusToRecorderState(stopped.status));
      setPipelineStatus(stopped.status === "completed" ? completedStatus(stopped.outputMode) : "アップロード・処理中");
      notifyUploadCompleteIfAwaited();
    } catch (error) {
      awaitingUploadRef.current = false;
      fileChunkTotalRef.current = null;
      setRecorderState("idle");
      setPipelineStatus("待機中");
      setNotice({ kind: "error", text: messageOf(error) });
      // Close the empty session so it does not stay in "processing" forever.
      if (created && queuedChunks === 0) void stopSession(created.id, -1).catch(() => undefined);
    }
  }

  async function runCorrection(): Promise<void> {
    const current = sessionRef.current;
    if (!current || requestingCorrection) return;
    setRequestingCorrection(true);
    try {
      const updated = await correctSession(current.id);
      setCorrectionFailures(new Map());
      setSession(updated);
      sessionRef.current = updated;
      setFileOutputMode(updated.outputMode);
      setPipelineStatus("校正中");
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      setRequestingCorrection(false);
    }
  }

  function downloadTranscript(): void {
    const text = formatTranscriptText(transcript);
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${transcriptFileBase(session?.title ?? null)}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  function selectYouTubeVideo(video: YouTubeVideo): void {
    setYouTubeVideo(video);
    setNotice(null);
    try {
      localStorage.setItem(YOUTUBE_VIDEO_KEY, getYouTubeWatchUrl(video));
    } catch {
      setNotice({ kind: "warning", text: "動画は表示できますが、ブラウザの設定により次回用のURLを保存できませんでした。" });
    }
  }

  function resetSession(): void {
    if (pendingChunks > 0 || recorderState === "requesting" || recorderState === "recording" || recorderState === "stopping") return;
    uploaderRef.current?.close();
    uploaderRef.current = null;
    rememberSessionId(null);
    setSession(null);
    sessionRef.current = null;
    followTranscriptRef.current = true;
    setTranscript([]);
    setPartialUtterance(null);
    setCorrectionFailures(new Map());
    fileChunkTotalRef.current = null;
    setConnection("offline");
    setPipelineStatus("待機中");
    setRecorderState("idle");
    setNotice(null);
  }

  const isRecording = recorderState === "recording" || recorderState === "stopping";
  const inputsLocked = recorderState !== "idle" || pendingChunks > 0;
  const canStart = !inputsLocked && (sourceKind === "microphone" || (sourceKind === "browser-tab" && youTubeVideo !== null));
  const correctionReady = health?.correctionReady === true;
  const correctedCount = transcript.filter((entry) => entry.correction).length;
  const canRunCorrection = session !== null && skipsTranslation(session.outputMode) && correctedCount < transcript.length && correctionReady;
  const translationFree = skipsTranslation(session?.outputMode) || (sourceKind === "file" && skipsTranslation(fileOutputMode));
  const serverOnline = health?.ok === true && (!session || connection === "connected");
  const serverLabel = !health ? "CHECKING" : !session ? "SERVER ONLINE" : connectionLabel(connection);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><WaveIcon /></span>
          <div><strong>Realtime Translate</strong><span>LIVE AUDIO WORKSPACE</span></div>
        </div>
        <div className="header-status">
          <StatusDot active={serverOnline} />
          <span>{serverLabel}</span>
          <span className="header-divider" />
          <span className={`provider-chip ${health?.asrReady ? "ready" : "disabled"}`}>
            WHISPER {health?.asrReady ? "READY" : "OFF"}
          </span>
          <span className={`provider-chip ${health?.translationReady ? "ready" : "disabled"}`}>
            {!health ? "TRANSLATION" : health.translationSelection === "opencode-go" ? "OPENCODE GO" : "OPENAI"} {health?.translationReady ? "SET" : "OFF"}
          </span>
        </div>
      </header>

      <div className="workspace">
        <aside className="control-panel">
          <div className="panel-section source-section">
            <div className="section-label">01 · INPUT SOURCE</div>
            <div className="source-grid">
              <SourceButton active={sourceKind === "browser-tab"} icon={<TabIcon />} title="YouTube" detail="ページ内再生" onClick={() => setSourceKind("browser-tab")} disabled={inputsLocked} recommended />
              <SourceButton active={sourceKind === "microphone"} icon={<MicIcon />} title="マイク" detail="端末入力" onClick={() => setSourceKind("microphone")} disabled={inputsLocked} />
              <SourceButton active={sourceKind === "file"} icon={<FileIcon />} title="ファイル" detail="100MBまで" onClick={() => setSourceKind("file")} disabled={inputsLocked} />
            </div>
          </div>

          <div className="panel-section">
            <div className="section-label">02 · LANGUAGES</div>
            <label className="field-label">音声言語</label>
            <select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} disabled={inputsLocked}>
              <option value="">自動検出</option><option value="en">英語</option><option value="ja">日本語</option><option value="zh">中国語</option><option value="ko">韓国語</option><option value="es">スペイン語</option><option value="fr">フランス語</option><option value="de">ドイツ語</option>
            </select>
            <div className="language-arrow">↓</div>
            <label className="field-label">翻訳先</label>
            <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)} disabled={inputsLocked}>
              <option value="ja">日本語</option><option value="en">英語</option><option value="zh">中国語</option><option value="ko">韓国語</option><option value="es">スペイン語</option><option value="fr">フランス語</option><option value="de">ドイツ語</option>
            </select>
          </div>

          <section className="panel-section translation-settings" aria-label="翻訳プロバイダー設定">
            <div className="section-label">TRANSLATION &amp; GLOSSARY</div>
            <strong>{translationProviderLabel(health)}</strong>
            <dl>
              <div><dt>モデル</dt><dd>{health?.translationModel ?? "確認中"}</dd></div>
              <div><dt>認証</dt><dd>{translationAuthLabel(health)}</dd></div>
            </dl>
            <p>.envのTRANSLATION_PROVIDERで切り替え後、サーバーを再起動します。自動切り替えはしません。</p>
            {health?.translationReady && <p>設定あり · 認証・利用枠はリクエスト実行時に確認します。</p>}
            {health?.translationMessage && <p className="translation-warning">{health.translationMessage}</p>}
            {health?.translationSelection === "opencode-go" && <p className="translation-warning">Goはコーディングエージェント向けです。翻訳用途の利用条件を確認してください。</p>}
          </section>

          {sourceKind === "browser-tab" && youTubeVideo && <VideoContextPanel
            key={`${youTubeVideo.id}:${targetLanguage}`}
            videoId={youTubeVideo.id}
            targetLanguage={targetLanguage}
            onChange={setVideoContext}
          />}

          <div className="panel-section action-section">
            {sourceKind === "browser-tab" && !isRecording && (
              <div className="source-tip"><strong>この画面だけで視聴・翻訳</strong><span>① 動画URLを入力して表示<br />②「翻訳を開始」でこのアプリのタブと音声を共有<br />③ 埋め込み動画を再生</span></div>
            )}
            {sourceKind === "file" ? (
              <>
                <div className="mode-toggle" role="group" aria-label="出力モード">
                  <button type="button" className={fileOutputMode === "translate" ? "active" : ""} aria-pressed={fileOutputMode === "translate"} onClick={() => setFileOutputMode("translate")} disabled={inputsLocked}>翻訳する</button>
                  <button type="button" className={fileOutputMode === "transcribe" ? "active" : ""} aria-pressed={fileOutputMode === "transcribe"} onClick={() => setFileOutputMode("transcribe")} disabled={inputsLocked}>文字起こしのみ</button>
                  <button type="button" className={fileOutputMode === "correct" ? "active" : ""} aria-pressed={fileOutputMode === "correct"} onClick={() => setFileOutputMode("correct")} disabled={inputsLocked || !correctionReady}>AI校正つき</button>
                </div>
                {health && !health.correctionReady && <p className="mode-note">AI校正を利用できません: {health.correctionMessage ?? "校正モデルの設定を確認してください。"}</p>}
                <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={inputsLocked}>
                  <FileIcon /> ファイルを選択
                </button>
                <input ref={fileInputRef} className="hidden-input" type="file" accept="audio/*,video/*" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void processFile(file);
                  event.target.value = "";
                }} />
              </>
            ) : isRecording ? (
              <button className="stop-button" type="button" onClick={() => void stopRecording()} disabled={recorderState === "stopping"}>
                <span className="stop-square" /> {recorderState === "stopping" ? "保存中…" : "録音を停止"}
              </button>
            ) : (
              <button className="primary-button" type="button" onClick={() => void startLiveCapture()} disabled={!canStart}>
                <span className="record-dot" /> {recorderState === "requesting" ? "許可を待っています…" : sourceKind === "browser-tab" ? "翻訳を開始" : "録音を開始"}
              </button>
            )}
            <div className="safe-note"><ShieldIcon /><span>音声はIndexedDBへ先に保存され、サーバーACK後に削除されます。</span></div>
          </div>
        </aside>

        <main className="transcript-panel">
          <div className="transcript-toolbar">
            <div>
              <div className="section-label">LIVE TRANSCRIPT</div>
              <h1>{session?.title || "新しいセッション"}</h1>
            </div>
            <div className="toolbar-actions">
              {isRecording && <AudioMeter value={audioLevel} />}
              {canRunCorrection && <button className="ghost-button" type="button" onClick={() => void runCorrection()} disabled={requestingCorrection}>AI校正を実行</button>}
              {transcript.length > 0 && <button className="ghost-button" type="button" onClick={downloadTranscript}>テキストで保存</button>}
              <button className="ghost-button" type="button" onClick={resetSession} disabled={pendingChunks > 0 || isRecording || recorderState === "requesting"}>新規</button>
            </div>
          </div>

          {sourceKind === "browser-tab" && (
            <YouTubePlayer video={youTubeVideo} disabled={inputsLocked} onVideoChange={selectYouTubeVideo} />
          )}

          <div className="session-strip">
            <div className="pipeline-state"><span className={isRecording ? "pulse-dot" : "quiet-dot"} />{pipelineStatus}</div>
            <div className="strip-metrics">
              <span><b>{transcript.length}</b> 発話</span>
              {session?.outputMode === "correct" && <span className="correction-progress">校正済み {correctedCount} / {transcript.length}</span>}
              <span><b>{pendingChunks}</b> 未送信</span>
              <span>{session ? shortId(session.id) : "NO SESSION"}</span>
            </div>
          </div>

          {notice && <div className={`notice ${notice.kind}`}><span>{noticeIcon(notice.kind)}</span><p>{notice.text}</p><button type="button" onClick={() => setNotice(null)} aria-label="閉じる">×</button></div>}

          <div className="transcript-scroll" ref={transcriptScrollRef} onScroll={(event) => {
            const panel = event.currentTarget;
            followTranscriptRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 48;
          }}>
            {transcript.length === 0 && !partialUtterance ? (
              <EmptyState sourceKind={sourceKind} recorderState={recorderState} outputMode={session?.outputMode ?? fileOutputMode} asrReady={health?.asrReady === true} translationReady={health?.translationReady === true || translationFree} translationMessage={health?.translationMessage ?? null} />
            ) : (
              <div className="transcript-list">
                {transcript.map((entry) => <TranscriptCard key={entry.utterance.id} entry={entry} showTranslation={(session?.outputMode ?? "translate") === "translate"} correctionLabel={correctionLabelOf(entry, session?.outputMode, correctionFailures, health?.correctionReady !== false)} />)}
                {partialUtterance && <PartialTranscriptCard utterance={partialUtterance} />}
              </div>
            )}
          </div>

          <footer className="panel-footer">
            <span>{(session?.sourceKind ?? sourceKind) === "file" ? "音声: 16 kHz mono WAV · 20〜30秒ごとに分割" : "音声: 16 kHz mono PCM/WAV · 5秒チャンク"}</span>
            <span>Protocol v{PROTOCOL_VERSION}</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function getSavedYouTubeVideo(): YouTubeVideo | null {
  try {
    return parseYouTubeUrl(localStorage.getItem(YOUTUBE_VIDEO_KEY) ?? "");
  } catch {
    return null;
  }
}

function SourceButton(props: { active: boolean; icon: ReactNode; title: string; detail: string; recommended?: boolean; disabled: boolean; onClick(): void }) {
  return <button type="button" className={`source-button ${props.active ? "active" : ""}`} onClick={props.onClick} disabled={props.disabled}>
    {props.recommended && <span className="recommend-tag">推奨</span>}
    <span className="source-icon">{props.icon}</span><strong>{props.title}</strong><small>{props.detail}</small>
  </button>;
}

function EmptyState({ sourceKind, recorderState, outputMode, asrReady, translationReady, translationMessage }: { sourceKind: SourceKind; recorderState: RecorderState; outputMode: OutputMode; asrReady: boolean; translationReady: boolean; translationMessage: string | null }) {
  const processing = recorderState === "recording" || recorderState === "processing" || recorderState === "stopping";
  const fileHeading = outputMode === "correct" ? "音声・動画ファイルを文字起こしして校正" : outputMode === "transcribe" ? "音声・動画ファイルを文字起こし" : "音声・動画ファイルを翻訳";
  const heading = sourceKind === "file" && !processing ? fileHeading : processing ? "音声を待っています" : sourceKind === "browser-tab" ? "動画の原文・翻訳がここに表示されます" : sourceKind === "microphone" ? "話した内容をその場で翻訳" : fileHeading;
  const description = sourceKind === "file"
    ? (processing ? "ファイルを展開し、無音の位置で区切って順に文字起こしします。結果は処理が進むたびに表示されます。" : "左側で出力モードと言語を選び、ファイルを選択してください。")
    : processing ? "最初の5秒チャンクが保存されると、文字起こしが始まります。" : sourceKind === "browser-tab" ? "上に動画を表示し、左側の「翻訳を開始」を押してください。" : "左側で言語を選び、録音を開始するかファイルを選択してください。";
  return <div className="empty-state">
    <div className={`empty-visual ${processing ? "active" : ""}`}><WaveIcon /></div>
    <h2>{heading}</h2>
    <p>{description}</p>
    {!asrReady && <div className="empty-warning">ローカルWhisperが未起動です — `pnpm whisper:start`を実行してください</div>}
    {asrReady && !translationReady && <div className="empty-warning">{translationMessage ?? "左側で翻訳プロバイダーの認証設定を確認してください。"}</div>}
  </div>;
}

type CorrectionLabel = { kind: "pending" | "failed" | "stalled"; text: string; title?: string };

function correctionLabelOf(entry: TranscriptEntry, mode: OutputMode | undefined, failures: ReadonlyMap<number, string>, correctionReady: boolean): CorrectionLabel | null {
  if (mode !== "correct" || entry.correction) return null;
  const failure = failures.get(entry.utterance.seq);
  if (failure !== undefined) return { kind: "failed", text: "校正失敗（原文を表示）", title: failure };
  if (!correctionReady) return { kind: "stalled", text: "未校正（校正を利用できません）" };
  return { kind: "pending", text: "校正中" };
}

function TranscriptCard({ entry, showTranslation, correctionLabel }: { entry: TranscriptEntry; showTranslation: boolean; correctionLabel: CorrectionLabel | null }) {
  const corrected = entry.correction;
  return <article className="transcript-card">
    <div className="utterance-meta">
      <span>{formatTime(entry.utterance.startedAtMs)}</span><span>{sequenceLabel(entry.utterance.startSeq, entry.utterance.endSeq)}</span><span>{entry.utterance.language?.toUpperCase() || "AUTO"}</span>
      {correctionLabel && <span className={`correction-label ${correctionLabel.kind}`} title={correctionLabel.title}>{correctionLabel.text}</span>}
    </div>
    <p className="source-text">{corrected ? corrected.text : entry.utterance.text}</p>
    {corrected && <details className="original-text"><summary>Whisperの原文</summary><p>{entry.utterance.text}</p></details>}
    {showTranslation && <div className="translation-block">
      <span className="translation-label">CONTEXT-AWARE TRANSLATION</span>
      {entry.translation ? <p>{entry.translation.text}</p> : <div className="translation-pending"><span /><span /><span /></div>}
    </div>}
  </article>;
}

function PartialTranscriptCard({ utterance }: { utterance: PartialUtteranceView }) {
  return <article className="transcript-card partial-card" aria-live="polite">
    <div className="utterance-meta"><span>{formatTime(utterance.startedAtMs)}</span><span>{sequenceLabel(utterance.startSeq, utterance.endSeq)}</span><span>{utterance.language?.toUpperCase() || "AUTO"}</span></div>
    <p className="source-text">{utterance.text}</p>
    <div className="partial-state"><span /><span>発話境界を待っています</span></div>
  </article>;
}

function AudioMeter({ value }: { value: number }) {
  return <div className="audio-meter" aria-label="音声レベル">{Array.from({ length: 12 }, (_, index) => <i key={index} className={value * 12 > index ? "on" : ""} style={{ height: `${8 + ((index * 7) % 16)}px` }} />)}</div>;
}

function StatusDot({ active }: { active: boolean }) { return <i className={`status-dot ${active ? "active" : ""}`} />; }
function connectionLabel(value: ConnectionState) { return ({ connected: "SERVER ONLINE", connecting: "CONNECTING", offline: "OFFLINE", error: "CONNECTION ERROR" })[value]; }
/** Transcript-only and proofread sessions never translate. */
function skipsTranslation(mode: OutputMode | undefined): boolean { return mode === "transcribe" || mode === "correct"; }
function completedStatus(mode: OutputMode | undefined): string {
  return mode === "correct" ? "文字起こし完了 · 校正中" : mode === "transcribe" ? "文字起こし完了" : "最新の翻訳まで完了";
}
function statusToRecorderState(status: SessionStatus): RecorderState { return status === "processing" ? "processing" : "idle"; }
function transcriptFileBase(title: string | null): string {
  const base = (title ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80);
  return base || "transcript";
}
function shortId(id: string) { return id.slice(0, 8).toUpperCase(); }
function sequenceLabel(startSeq: number, endSeq: number) { return startSeq === endSeq ? `#${endSeq + 1}` : `#${startSeq + 1}–${endSeq + 1}`; }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
function noticeIcon(kind: Notice["kind"]) { return ({ info: "i", warning: "!", error: "×", success: "✓" })[kind]; }
function formatTime(milliseconds: number) { const total = Math.floor(milliseconds / 1000); return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }

function WaveIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 10v4M7 7v10M11 3v18M15 6v12M19 8v8M23 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>; }
function TabIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M3 8h18M8 6h.01M6 6h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><path d="m10 11 5 3-5 3v-6Z" fill="currentColor"/></svg>; }
function MicIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>; }
function FileIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M14 3v5h5M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.8 8.2 7 10 4.2-1.8 7-5.5 7-10V6l-7-3Z" stroke="currentColor" strokeWidth="1.6"/><path d="m9 12 2 2 4-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
