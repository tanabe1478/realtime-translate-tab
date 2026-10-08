import type { CreateSessionRequest, HealthResponse, SessionSnapshot, SessionView } from "@realtime-translate/contracts";

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

export async function stopSession(id: string): Promise<SessionView> {
  return request<SessionView>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
