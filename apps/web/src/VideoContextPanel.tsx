import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  MAX_GLOSSARY_TERMS,
  parseTranslationHints,
  type TranslationHints,
  type VideoContextView,
} from "@realtime-translate/contracts";
import {
  ApiError,
  getVideoContext,
  prepareVideoContext,
  updateVideoContext,
} from "./api.js";

interface Props {
  videoId: string;
  targetLanguage: string;
  onChange(value: VideoContextView | null): void;
}

export function VideoContextPanel({
  videoId,
  targetLanguage,
  onChange,
}: Props) {
  const editorId = useId();
  const [value, setValue] = useState<VideoContextView | null>(null);
  const current = useRef<VideoContextView | null>(null);
  const [networkError, setNetworkError] = useState("");
  const [editError, setEditError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<TranslationHints | null>(null);
  const editVersion = useRef<VideoContextView | null>(null);
  const mounted = useRef(true);

  function accept(next: VideoContextView): void {
    if (
      !mounted.current ||
      (current.current && current.current.version > next.version)
    )
      return;
    current.current = next;
    setValue(next);
    onChange(next);
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: number;
    onChange(null);
    const refresh = async (initial: boolean) => {
      try {
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(8_000),
        ]);
        const next = initial
          ? await prepareVideoContext(videoId, targetLanguage, false, signal)
          : await getVideoContext(videoId, targetLanguage, signal);
        if (controller.signal.aborted) return;
        accept(next);
        setNetworkError("");
      } catch {
        if (!controller.signal.aborted)
          setNetworkError(
            "話題・用語集のサーバーに接続できません。翻訳はそのまま開始できます。",
          );
      } finally {
        if (!controller.signal.aborted)
          timer = window.setTimeout(() => {
            void refresh(current.current === null);
          }, 2_000);
      }
    };
    void refresh(true);
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearTimeout(timer);
    };
    // Parent keys this component by videoId + targetLanguage. Polling never replaces a user's draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, targetLanguage]);

  function edit(): void {
    if (!value) return;
    editVersion.current = value;
    setDraft(structuredClone(value.hints));
    setEditError("");
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!draft || !editVersion.current) return;
    let hints: TranslationHints;
    try {
      hints = parseTranslationHints(draft);
    } catch (error) {
      setEditError(messageOf(error));
      return;
    }
    setBusy(true);
    setEditError("");
    try {
      const next = await updateVideoContext(
        editVersion.current,
        "manual",
        hints,
      );
      accept(next);
      if (mounted.current) setDraft(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await getVideoContext(videoId, targetLanguage);
          accept(latest);
          editVersion.current = latest;
        } catch {
          /* Keep the draft, even when reconnecting fails. */
        }
      }
      if (mounted.current) setEditError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function regenerate(): Promise<void> {
    if (!value) return;
    setBusy(true);
    setEditError("");
    try {
      accept(
        value.mode === "manual"
          ? await updateVideoContext(value, "auto")
          : await prepareVideoContext(videoId, targetLanguage, true),
      );
    } catch (error) {
      if (mounted.current) setEditError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function changeTerm(
    index: number,
    field: "term" | "translation" | "note",
    text: string,
  ): void {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            glossary: previous.glossary.map((entry, entryIndex) =>
              entryIndex === index ? { ...entry, [field]: text } : entry,
            ),
          }
        : previous,
    );
  }

  const label = !value
    ? "接続中"
    : value.mode === "manual"
      ? "手動で固定"
      : {
          idle: "準備中",
          generating: "自動生成中",
          ready: "自動生成済み",
          unavailable: "自動生成できません",
          failed: "生成に失敗",
        }[value.status];

  return (
    <section className="context-panel" aria-label="話題・用語集">
      <details>
        <summary>
          <span>話題・用語集</span>
          <span
            className={`context-status ${value?.status ?? "idle"}`}
            role="status"
          >
            {label}
            {value?.hints.glossary.length
              ? ` · ${value.hints.glossary.length}語`
              : ""}
          </span>
        </summary>
        <div className="context-body">
          <p className="context-help">
            入力は不要です。動画のタイトル・チャンネル名から作成し、翻訳開始後は実際の発言で更新します。生成を待たずに翻訳を開始できます。
          </p>
          {value?.metadata && (
            <p className="context-metadata">
              {value.metadata.title}
              <br />
              <span>{value.metadata.authorName}</span>
            </p>
          )}
          {(networkError || value?.message) && (
            <p className="context-warning" role="alert">
              {networkError || value?.message}
            </p>
          )}
          {editError && (
            <p className="context-warning" role="alert">
              {editError}
            </p>
          )}
          {draft ? (
            <form
              className="context-editor"
              onSubmit={(event) => {
                void save(event);
              }}
            >
              <label htmlFor={`${editorId}-topic`}>話題</label>
              <textarea
                id={`${editorId}-topic`}
                value={draft.topic}
                maxLength={800}
                rows={3}
                onChange={(event) =>
                  setDraft({ ...draft, topic: event.target.value })
                }
                disabled={busy}
              />
              {draft.glossary.map((entry, index) => (
                <fieldset key={index} disabled={busy}>
                  <legend>用語 {index + 1}</legend>
                  <label htmlFor={`${editorId}-${index}-term`}>原語</label>
                  <input
                    id={`${editorId}-${index}-term`}
                    value={entry.term}
                    maxLength={80}
                    required
                    onChange={(event) =>
                      changeTerm(index, "term", event.target.value)
                    }
                  />
                  <label htmlFor={`${editorId}-${index}-translation`}>
                    訳語・表記
                  </label>
                  <input
                    id={`${editorId}-${index}-translation`}
                    value={entry.translation}
                    maxLength={160}
                    required
                    onChange={(event) =>
                      changeTerm(index, "translation", event.target.value)
                    }
                  />
                  <label htmlFor={`${editorId}-${index}-note`}>補足</label>
                  <input
                    id={`${editorId}-${index}-note`}
                    value={entry.note}
                    maxLength={160}
                    onChange={(event) =>
                      changeTerm(index, "note", event.target.value)
                    }
                  />
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={`用語${index + 1}を削除`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        glossary: draft.glossary.filter((_, i) => i !== index),
                      })
                    }
                  >
                    削除
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                className="ghost-button"
                disabled={busy || draft.glossary.length >= MAX_GLOSSARY_TERMS}
                onClick={() =>
                  setDraft({
                    ...draft,
                    glossary: [
                      ...draft.glossary,
                      { term: "", translation: "", note: "" },
                    ],
                  })
                }
              >
                用語を追加
              </button>
              <p className="context-help">
                保存すると自動更新を停止し、手動の内容を優先します。変更は次の文字起こし・翻訳から反映され、過去の字幕は変更しません。
              </p>
              <div className="context-actions">
                <button type="submit" className="ghost-button" disabled={busy}>
                  保存して固定
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setEditError("");
                  }}
                >
                  キャンセル
                </button>
              </div>
            </form>
          ) : (
            <>
              {value?.hints.topic && (
                <p className="context-topic">{value.hints.topic}</p>
              )}
              {!!value?.hints.glossary.length && (
                <dl className="context-glossary">
                  {value.hints.glossary.map((entry) => (
                    <div key={entry.term}>
                      <dt>{entry.term}</dt>
                      <dd>
                        {entry.translation}
                        {entry.note && <small>{entry.note}</small>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {value && (
                <p className="context-help">
                  根拠：
                  {value.basis === "transcript"
                    ? value.metadata
                      ? "動画情報＋実際の発言"
                      : "実際の発言（動画情報なし）"
                    : value.basis === "manual"
                      ? "手動編集"
                      : "動画情報（内容は未視聴）"}
                  。自動生成の候補は誤ることがあります。音声・原文を優先し、発言にない説明は加えません。
                </p>
              )}
              <div className="context-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={edit}
                  disabled={!value || busy}
                >
                  確認・編集
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    void regenerate();
                  }}
                  disabled={!value || busy || value.status === "generating"}
                >
                  {value?.mode === "manual" ? "自動生成に戻す" : "再生成"}
                </button>
              </div>
            </>
          )}
        </div>
      </details>
      {networkError && (
        <p className="context-warning">接続できません。翻訳は続行できます。</p>
      )}
      {value?.message && (
        <p className="context-warning">
          {value.status === "unavailable"
            ? "ChatGPTログイン後に再試行できます。"
            : "生成に失敗しました。翻訳は続行できます。"}
        </p>
      )}
    </section>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
