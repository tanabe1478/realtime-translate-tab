import type { ServerEvent } from "@realtime-translate/contracts";

export type EventListener = (event: ServerEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();

  subscribe(sessionId: string, listener: EventListener): () => void {
    const sessionListeners = this.listeners.get(sessionId) ?? new Set<EventListener>();
    sessionListeners.add(listener);
    this.listeners.set(sessionId, sessionListeners);
    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners.get(event.sessionId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        console.error("Event listener failed", error);
      }
    }
  }
}
