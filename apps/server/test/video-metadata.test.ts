import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVideoMetadata } from "../src/services/video-metadata.js";
afterEach(() => vi.unstubAllGlobals());

describe("YouTube metadata boundary", () => {
  it("uses only the fixed oEmbed host and returns bounded factual fields", async () => {
    const fetcher = vi.fn(async () => Response.json({ title: "State of Agentic Coding", author_name: "Armin Ronacher", html: "untrusted embed html" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchVideoMetadata("HDdbU10r7Js", AbortSignal.timeout(1000))).toEqual({ title: "State of Agentic Coding", authorName: "Armin Ronacher" });
    const [url, options] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://www.youtube.com");
    expect(url.pathname).toBe("/oembed");
    expect(options.redirect).toBe("error");
  });
  it("does not fetch arbitrary URLs", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchVideoMetadata("http://127.0.0.1", AbortSignal.timeout(1000))).rejects.toThrow("Invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([new Response("missing", { status: 404 }), Response.json({ title: "" }), new Response("x".repeat(70_000))])("rejects unavailable/malformed/oversized metadata %#", async (response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchVideoMetadata("HDdbU10r7Js", AbortSignal.timeout(1000))).rejects.toThrow();
  });
});
