import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetMissingSessionId, LAST_SESSION_KEY, readLastSessionId, rememberSessionId, sessionIdToRestore, sessionNavigationUrl } from "../src/session-navigation.js";

afterEach(() => vi.unstubAllGlobals());

describe("saved session navigation", () => {
  it("prefers a direct session link to the browser's last session", () => {
    expect(sessionIdToRestore("?sessionId=bookmarked", "last-browser-session")).toBe("bookmarked");
    expect(sessionIdToRestore("?sessionId=bookmarked", null)).toBe("bookmarked");
  });
  it("keeps the browser fallback when there is no requested session", () => {
    expect(sessionIdToRestore("", "saved")).toBe("saved");
    expect(sessionIdToRestore("?sessionId=", "saved")).toBe("saved");
    expect(sessionIdToRestore("", null)).toBeNull();
  });
  it("replaces an old session id and preserves unrelated query/hash data", () => {
    expect(sessionNavigationUrl("http://127.0.0.1:5173/?sessionId=old&other=keep#captions", "new")).toBe("/?sessionId=new&other=keep#captions");
    expect(sessionNavigationUrl("http://127.0.0.1:5173/?sessionId=old&other=keep#captions", null)).toBe("/?other=keep#captions");
  });
  it("does not turn session id contents into a different origin or query parameter", () => {
    expect(sessionNavigationUrl("http://127.0.0.1:5173/", "a&other=bad")).toBe("/?sessionId=a%26other%3Dbad");
  });
  it("can open a direct link even when browser storage access is blocked", () => {
    vi.stubGlobal("localStorage", { getItem() { throw new Error("Storage blocked"); } });
    expect(readLastSessionId()).toBeNull();
    expect(sessionIdToRestore("?sessionId=bookmarked", readLastSessionId())).toBe("bookmarked");
  });
  it("keeps both the saved pointer and current URL in sync", () => {
    const setItem = vi.fn(); const removeItem = vi.fn(); const replaceState = vi.fn();
    vi.stubGlobal("localStorage", { setItem, removeItem });
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:5173/?sessionId=old" }, history: { replaceState } });
    rememberSessionId("new");
    expect(setItem).toHaveBeenCalledWith(LAST_SESSION_KEY, "new");
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/?sessionId=new");
    rememberSessionId(null);
    expect(removeItem).toHaveBeenCalledWith(LAST_SESSION_KEY);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/");
  });
  it("does not interrupt capture if storage or history updates fail", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("localStorage", { setItem() { throw new Error("Storage blocked"); } });
    vi.stubGlobal("window", { location: { href: "http://127.0.0.1:5173/" }, history: { replaceState } });
    expect(() => rememberSessionId("saved")).not.toThrow();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?sessionId=saved");
    replaceState.mockImplementation(() => { throw new Error("History blocked"); });
    expect(() => rememberSessionId("saved")).not.toThrow();
  });
  it("never clears a newer session pointer because an older session was missing", () => {
    const removeItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => "newer", removeItem });
    forgetMissingSessionId("older");
    expect(removeItem).not.toHaveBeenCalled();
    forgetMissingSessionId("newer");
    expect(removeItem).toHaveBeenCalledWith(LAST_SESSION_KEY);
  });
});
