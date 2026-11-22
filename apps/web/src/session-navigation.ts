export const LAST_SESSION_KEY = "realtime-translate:last-session";

/** A bookmark/deep link works even in a different browser or with cleared storage. */
export function sessionIdToRestore(search: string, savedId: string | null): string | null {
  return new URLSearchParams(search).get("sessionId")?.trim() || savedId;
}

export function sessionNavigationUrl(href: string, sessionId: string | null): string {
  const url = new URL(href);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  else url.searchParams.delete("sessionId");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readLastSessionId(): string | null {
  try { return localStorage.getItem(LAST_SESSION_KEY); } catch { return null; }
}

/** Storage restrictions must not interrupt capture or prevent opening a direct link. */
export function rememberSessionId(sessionId: string | null): void {
  try {
    if (sessionId) localStorage.setItem(LAST_SESSION_KEY, sessionId);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch { /* A shareable URL can still preserve the session reference. */ }
  try {
    window.history.replaceState(null, "", sessionNavigationUrl(window.location.href, sessionId));
  } catch { /* Saving server-side data does not depend on browser history access. */ }
}

/** Only a confirmed 404 may discard this pointer, never a timeout/network error. */
export function forgetMissingSessionId(sessionId: string): void {
  if (readLastSessionId() !== sessionId) return;
  try { localStorage.removeItem(LAST_SESSION_KEY); } catch { /* Storage may be disabled. */ }
}
