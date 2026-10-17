import { describe, expect, it } from "vitest";
import { createDevProxy } from "../vite.config.js";

describe("development API/WebSocket proxy port", () => {
  it("keeps the existing default", () => {
    expect(createDevProxy()["/api"]).toBe("http://127.0.0.1:8787");
  });
  it("uses the configured port for both HTTP and WebSocket without exposing credentials", () => {
    expect(createDevProxy("8788")).toEqual({
      "/api": "http://127.0.0.1:8788",
      "/ws": { target: "ws://127.0.0.1:8788", ws: true },
    });
  });
  it.each(["0", "65536", "-1", "8788.5", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() => createDevProxy(port)).toThrow("PORT must be");
  });
});
