import { describe, expect, it } from "vitest";
import { getYouTubeEmbedUrl, getYouTubeWatchUrl, parseYouTubeUrl } from "../src/youtube.js";

const id = "dQw4w9WgXcQ";

describe("YouTube video URLs", () => {
  it.each([
    `https://www.youtube.com/watch?v=${id}&list=playlist`,
    `https://youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=sharing-token`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `youtube.com/watch?v=${id}`,
    `youtu.be/${id}`,
    `  https://youtu.be/${id}  `,
  ])("extracts the video id from %s", (url) => {
    expect(parseYouTubeUrl(url)).toEqual({ id, startSeconds: 0 });
  });

  it.each([
    [`https://youtu.be/${id}?t=90`, 90],
    [`https://www.youtube.com/watch?v=${id}&t=1h2m3s`, 3723],
    [`https://www.youtube.com/embed/${id}?start=42`, 42],
    [`https://www.youtube.com/watch?v=${id}#t=2m`, 120],
    [`https://youtu.be/${id}?t=invalid`, 0],
    [`https://youtu.be/${id}?t=-1`, 0],
    [`https://youtu.be/${id}?t=9999999999999999999999`, 0],
  ])("preserves valid starting times from %s", (url, startSeconds) => {
    expect(parseYouTubeUrl(url)).toEqual({ id, startSeconds });
  });

  it.each([
    "", "not a URL", id,
    "https://www.youtube.com/playlist?list=123",
    "https://www.youtube.com/watch?v=short",
    `https://youtube.com.evil.example/watch?v=${id}`,
    `https://example.com/watch?v=${id}`,
    `https://youtube.com@evil.example/watch?v=${id}`,
    `https://evil.example@youtube.com/watch?v=${id}`,
    `https://youtube.com:8080/watch?v=${id}`,
    `ftp://youtube.com/watch?v=${id}`,
    `javascript:alert('${id}')`,
    `<iframe src="https://www.youtube.com/embed/${id}"></iframe>`,
    "https://youtu.be/%22%3E%3Cscript%3E",
    `https://youtu.be/${id}/extra`,
  ])("rejects invalid or untrusted input %s", (url) => {
    expect(parseYouTubeUrl(url)).toBeNull();
  });

  it("builds an embed on a fixed YouTube host without forwarding unrelated parameters", () => {
    const video = parseYouTubeUrl(`https://youtu.be/${id}?t=90&autoplay=1&origin=https://example.com`)!;
    expect(getYouTubeEmbedUrl(video)).toBe(`https://www.youtube-nocookie.com/embed/${id}?playsinline=1&start=90`);
    expect(parseYouTubeUrl(getYouTubeWatchUrl(video))).toEqual(video);
  });

  it("omits a zero starting time", () => {
    expect(getYouTubeEmbedUrl({ id, startSeconds: 0 })).toBe(`https://www.youtube-nocookie.com/embed/${id}?playsinline=1`);
  });
});
