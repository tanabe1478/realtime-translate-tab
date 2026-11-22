import type { CreateSessionRequest, HealthResponse, SessionSnapshot, SessionView, TranslationHints, VideoContextView } from "@realtime-translate/contracts";

export async function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export async function createSession(input: CreateSessionRequest): Promise<SessionView> {
  return request<SessionView>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getSession(id: string): Promise<SessionSnapshot> {
  return request<SessionSnapshot>(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function stopSession(id: string, lastSeq: number): Promise<SessionView> {
  return request<SessionView>(`/api/sessions/${encodeURIComponent(id)}/stop`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lastSeq }),
  });
}

function contextUrl(videoId: string, targetLanguage: string): string {
  return `/api/video-contexts/${encodeURIComponent(videoId)}?targetLanguage=${encodeURIComponent(targetLanguage)}`;
}

export function prepareVideoContext(videoId: string, targetLanguage: string, force = false, signal?: AbortSignal): Promise<VideoContextView> {
  return request(contextUrl(videoId, targetLanguage), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }),
    ...(signal ? { signal } : {}),
  });
}

export function getVideoContext(videoId: string, targetLanguage: string, signal?: AbortSignal): Promise<VideoContextView> {
  return request(contextUrl(videoId, targetLanguage), signal ? { signal } : undefined);
}

export function updateVideoContext(value: VideoContextView, mode: "auto" | "manual", hints?: TranslationHints): Promise<VideoContextView> {
  return request(contextUrl(value.videoId, value.targetLanguage), {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, expectedVersion: value.version, ...(hints ? { hints } : {}) }),
  });
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: unknown };
    throw new ApiError(typeof body.error === "string" ? body.error : `HTTP ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}
