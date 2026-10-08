import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWhisperRecognizer } from "../src/providers/local-whisper.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("LocalWhisperRecognizer", () => {
  it("sends audio to the local sidecar", async () => {
    let receivedBytes = 0;
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200).end("ok");
        return;
      }
      request.on("data", (chunk: Buffer) => { receivedBytes += chunk.byteLength; });
      request.on("end", () => {
        expect(request.headers["x-source-language"]).toBe("en-US");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ text: "hello world", language: "en" }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const recognizer = new LocalWhisperRecognizer(`http://127.0.0.1:${address.port}`, "small");
    expect(await recognizer.checkHealth(AbortSignal.timeout(1_000))).toBe(true);
    const result = await recognizer.transcribe({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/wav",
      fileName: "audio.wav",
      sourceLanguage: "en-US",
    }, AbortSignal.timeout(1_000));

    expect(receivedBytes).toBe(3);
    expect(result).toEqual({ text: "hello world", language: "en" });
  });
});
