export interface YouTubeVideo {
  id: string;
  startSeconds: number;
}

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

/** Accept video links, never arbitrary iframe URLs or HTML. */
export function parseYouTubeUrl(input: string): YouTubeVideo | null {
  const value = input.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(/^[\w.-]+\//.test(value) ? `https://${value}` : value);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  if (SHORT_HOSTS.has(url.hostname) && segments.length === 1) {
    id = segments[0];
  } else if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? undefined;
    else if (segments.length === 2 && ["embed", "shorts", "live"].includes(segments[0]!)) id = segments[1];
  } else if (EMBED_HOSTS.has(url.hostname) && segments.length === 2 && segments[0] === "embed") {
    id = segments[1];
  }
  if (!id || !VIDEO_ID.test(id)) return null;

  const timestamp = url.searchParams.get("start")
    ?? url.searchParams.get("t")
    ?? new URLSearchParams(url.hash.slice(1)).get("t")
    ?? "";
  return { id, startSeconds: parseTimestamp(timestamp) };
}

export function getYouTubeWatchUrl(video: YouTubeVideo): string {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", video.id);
  if (video.startSeconds > 0) url.searchParams.set("t", String(video.startSeconds));
  return url.toString();
}

export function getYouTubeEmbedUrl(video: YouTubeVideo): string {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${video.id}`);
  url.searchParams.set("playsinline", "1");
  if (video.startSeconds > 0) url.searchParams.set("start", String(video.startSeconds));
  return url.toString();
}

function parseTimestamp(value: string): number {
  if (!value) return 0;
  let seconds: number;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
    if (!match) return 0;
    seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 0;
}
