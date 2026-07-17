export type EventListener<Payload> = (payload: Payload) => void;

export class TypedEventEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<never>>>();

  on<EventName extends keyof Events>(
    eventName: EventName,
    listener: EventListener<Events[EventName]>,
  ): () => void {
    const listeners = this.listeners.get(eventName) ?? new Set<EventListener<never>>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => this.off(eventName, listener);
  }

  off<EventName extends keyof Events>(
    eventName: EventName,
    listener: EventListener<Events[EventName]>,
  ): void {
    const listeners = this.listeners.get(eventName);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      this.listeners.delete(eventName);
    }
  }

  protected emit<EventName extends keyof Events>(
    eventName: EventName,
    payload: Events[EventName],
  ): void {
    const listeners = this.listeners.get(eventName);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      (listener as EventListener<Events[EventName]>)(payload);
    }
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}
