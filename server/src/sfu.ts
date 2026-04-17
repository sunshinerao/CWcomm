import * as mediasoup from "mediasoup";
import type { Router, Worker, WebRtcTransport, Producer, Consumer } from "mediasoup/node/lib/types.js";

// Keep a simple global registry for the MVP-to-Prod upgrade
let worker: Worker;

// Map of eventId -> Router
const routers = new Map<string, Router>();

// Map of clientId -> WebRtcTransport
export const transports = new Map<string, WebRtcTransport>();

// Map of eventId -> Producer (The floor audio)
export const producers = new Map<string, Producer>();

// Map of clientId -> Consumer[]
export const consumers = new Map<string, Consumer[]>();

export async function initSfuWorker() {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  worker.on("died", () => {
    console.error("mediasoup Worker died, exiting in 2 seconds... [pid:%d]", worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  console.log("Mediasoup worker started.");
}

export async function getOrCreateRouter(eventId: string): Promise<Router> {
  if (routers.has(eventId)) {
    return routers.get(eventId)!;
  }
  const router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
    ],
  });
  routers.set(eventId, router);
  return router;
}

export async function createWebRtcTransport(router: Router) {
  const listenIps = [{ ip: process.env.MEDIASOUP_LISTEN_IP || "127.0.0.1", announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP }];
  
  const transport = await router.createWebRtcTransport({
    listenIps: listenIps as any,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 800000,
  });

  return transport;
}

export function cleanupClientSfu(clientId: string) {
  const t = transports.get(clientId);
  if (t) {
    t.close();
    transports.delete(clientId);
  }
  
  const consList = consumers.get(clientId) || [];
  consList.forEach(c => c.close());
  consumers.delete(clientId);
}
