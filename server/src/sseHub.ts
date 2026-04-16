import type { Response } from "express";

export class SseHub {
  private channels = new Map<string, Set<Response>>();

  subscribe(eventId: string, res: Response): void {
    const set = this.channels.get(eventId) ?? new Set<Response>();
    set.add(res);
    this.channels.set(eventId, set);
  }

  unsubscribe(eventId: string, res: Response): void {
    const set = this.channels.get(eventId);
    if (!set) {
      return;
    }
    set.delete(res);
    if (set.size === 0) {
      this.channels.delete(eventId);
    }
  }

  publish(eventId: string, payload: unknown): void {
    const set = this.channels.get(eventId);
    if (!set) {
      return;
    }
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(data);
      } catch {
        this.unsubscribe(eventId, res);
      }
    }
  }

  ping(eventId: string): void {
    const set = this.channels.get(eventId);
    if (!set) {
      return;
    }
    for (const res of set) {
      try {
        res.write(": ping\n\n");
      } catch {
        this.unsubscribe(eventId, res);
      }
    }
  }
}
