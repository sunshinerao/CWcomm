import { Redis } from "ioredis";

// We use two connections: one for publishing, one for subscribing due to Redis constraints.
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const redisPublisher = new Redis(REDIS_URL);
export const redisSubscriber = new Redis(REDIS_URL);

/**
 * Event payloads schema expected across the broadcast bus.
 */
export type BroadcastEvent = {
  eventId: string;
  topic: "subtitle" | "tts" | "monitor_stats" | "monitor_subtitle" | "monitor_tts" | "monitor_metrics" | "sfu_producer_state" | "sfu_consumer_state";
  payload: any;
};

type BroadcastListener = (event: BroadcastEvent) => void;
const listeners = new Set<BroadcastListener>();

// Start listening globally for this node
redisSubscriber.on("message", (channel, message) => {
  if (channel.startsWith("cwcomm:events:")) {
    try {
      const data = JSON.parse(message) as BroadcastEvent;
      for (const listener of listeners) {
        listener(data);
      }
    } catch (e) {
      console.error("Failed to parse incoming broadcast message", e);
    }
  }
});

/**
 * Subscribe to the CWcomm global topic bus.
 */
export async function startRedisBus() {
  await redisSubscriber.subscribe("cwcomm:events:*");
}

/**
 * Add a local listener (e.g., your WS server) that will receive messages from Redis.
 */
export function onBroadcast(listener: BroadcastListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Publish an event to the rest of the cluster.
 */
export async function broadcastEvent(event: BroadcastEvent) {
  const channel = `cwcomm:events:${event.eventId}`;
  await redisPublisher.publish(channel, JSON.stringify(event));
}
