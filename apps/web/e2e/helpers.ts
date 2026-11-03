import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const RATE = 16_000;

/** Mono 16-bit WAV: a tone with silent gaps (seconds) so that the splitter has quiet places to cut. */
export function makeWav(totalSeconds: number, silences: Array<[number, number]>): Buffer {
  const count = totalSeconds * RATE;
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const second = index / RATE;
    const silent = silences.some(([from, to]) => second >= from && second < to);
    pcm.writeInt16LE(silent ? 0 : Math.round(Math.sin((2 * Math.PI * 440 * index) / RATE) * 9_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Records the Blob and file name behind each programmatic anchor download. Chromium's own download
 * saving is unavailable in the sandboxed verification run, so the exported content is read from the Blob.
 */
export async function captureDownloads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const blobs = new Map<string, Blob>();
    const downloads: Array<{ name: string; url: string }> = [];
    const w = window as unknown as { __downloads: typeof downloads; __downloadText: (index: number) => Promise<string> };
    w.__downloads = downloads;
    w.__downloadText = (index) => blobs.get(downloads[index]!.url)!.text();
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      if (object instanceof Blob) blobs.set(url, object);
      return url;
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      if (this.download) downloads.push({ name: this.download, url: this.href });
      click.call(this);
    };
  });
}

export async function downloadedText(page: Page): Promise<{ name: string; text: string }> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __downloads: unknown[] }).__downloads.length)).toBe(1);
  return page.evaluate(async () => {
    const w = window as unknown as { __downloads: Array<{ name: string }>; __downloadText: (index: number) => Promise<string> };
    return { name: w.__downloads[0]!.name, text: await w.__downloadText(0) };
  });
}

/** Requests the stand-in proofreader received (one per batch) and the utterances inside them. */
export async function correctStats(request: APIRequestContext): Promise<{ requests: number; items: number }> {
  const body = (await (await request.get("http://127.0.0.1:18788/")).json()) as { correctCalls: number; correctItems: number };
  return { requests: body.correctCalls, items: body.correctItems };
}

export async function translateCalls(request: APIRequestContext): Promise<number> {
  return ((await (await request.get("http://127.0.0.1:18788/")).json()) as { translateCalls: number }).translateCalls;
}
