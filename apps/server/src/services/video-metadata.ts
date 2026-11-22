import {
  isYouTubeVideoId,
  type VideoMetadata,
} from "@realtime-translate/contracts";

/** Fixed origin + validated ID: never fetch an arbitrary URL supplied by a browser. */
export async function fetchVideoMetadata(
  videoId: string,
  signal: AbortSignal,
): Promise<VideoMetadata> {
  if (!isYouTubeVideoId(videoId)) throw new Error("Invalid YouTube video id");
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok)
    throw new Error(
      "YouTubeの動画情報を取得できませんでした。非公開・削除済み・埋め込み禁止の動画の可能性があります。",
    );
  // oEmbed is normally a few KB. Bound the streamed body, not only Content-Length.
  if (!response.body)
    throw new Error("YouTubeから動画情報が返りませんでした。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024)
        throw new Error("YouTubeの動画情報が大きすぎます。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
  if (typeof body.title !== "string" || !body.title.trim())
    throw new Error("YouTubeの動画タイトルを取得できませんでした。");
  return {
    title: body.title.trim().slice(0, 500),
    authorName:
      typeof body.author_name === "string"
        ? body.author_name.trim().slice(0, 200)
        : "",
  };
}
