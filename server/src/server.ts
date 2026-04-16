import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { prisma } from "./db.js";
import { createRuntime, type SubtitleDeltaPayload } from "./app.js";
import { createAsrFromEnv } from "./asr.js";
import { createTtsFromEnv } from "./tts.js";

const HOST = process.env.CWCOMM_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CWCOMM_PORT ?? 8080);
const TLS_CERT_FILE = process.env.CWCOMM_TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.CWCOMM_TLS_KEY_FILE;

type ListenerMeta = {
  role: "listener";
  clientId: string;
  eventId: string;
  language: string;
};

type ProducerMeta = {
  role: "producer";
  clientId: string;
  eventId: string;
  sourceLanguage: string;
  targetLanguages: string[];
};

type MonitorMeta = {
  role: "monitor";
  clientId: string;
  eventId: string;
};

type ClientMeta = ListenerMeta | ProducerMeta | MonitorMeta;

type RoomState = {
  producerId: string | null;
  listenerIds: Set<string>;
  monitorIds: Set<string>;
};

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (isOpen(ws)) {
    ws.send(JSON.stringify(payload));
  }
}

function ensureRoom(rooms: Map<string, RoomState>, eventId: string): RoomState {
  const existing = rooms.get(eventId);
  if (existing) {
    return existing;
  }
  const room: RoomState = {
    producerId: null,
    listenerIds: new Set<string>(),
    monitorIds: new Set<string>(),
  };
  rooms.set(eventId, room);
  return room;
}

async function start() {
  await prisma.$connect();
  const runtime = createRuntime({ prisma });
  const asr = createAsrFromEnv();
  const tts = createTtsFromEnv();

  const server =
    TLS_CERT_FILE && TLS_KEY_FILE
      ? createHttpsServer(
          {
            cert: fs.readFileSync(path.resolve(TLS_CERT_FILE)),
            key: fs.readFileSync(path.resolve(TLS_KEY_FILE)),
          },
          runtime.app,
        )
      : createServer(runtime.app);

  const wss = new WebSocketServer({ server, path: "/ws/live" });
  const clientsBySocket = new Map<WebSocket, ClientMeta>();
  const socketByClientId = new Map<string, WebSocket>();
  const rooms = new Map<string, RoomState>();

  function broadcastMonitors(eventId: string, payload: unknown): void {
    const room = rooms.get(eventId);
    if (!room) {
      return;
    }
    for (const monitorId of room.monitorIds) {
      const ws = socketByClientId.get(monitorId);
      if (ws) {
        sendJson(ws, payload);
      }
    }
  }

  function emitRoomStats(eventId: string): void {
    const room = rooms.get(eventId);
    if (!room) {
      return;
    }
    broadcastMonitors(eventId, {
      type: "monitor.stats",
      eventId,
      producerOnline: Boolean(room.producerId),
      listenerCount: room.listenerIds.size,
      monitorCount: room.monitorIds.size,
      ts: Date.now() / 1000,
    });
  }

  runtime.onSubtitle(async (payload: SubtitleDeltaPayload) => {
    const eventId = payload.data.event_id;
    const segment = payload.data.segment;

    const listeners = Array.from(clientsBySocket.entries()).filter(
      ([ws, meta]) => isOpen(ws) && meta.role === "listener" && meta.eventId === eventId,
    ) as Array<[WebSocket, ListenerMeta]>;

    broadcastMonitors(eventId, {
      type: "monitor.subtitle",
      eventId,
      seq: segment.seq,
      sourceText: segment.source_text,
      isFinal: segment.is_final,
      ts: segment.ts,
    });

    if (listeners.length === 0) {
      return;
    }

    const ttsByLanguage = new Map<string, Promise<{ audioBase64: string; mimeType: string; ttsMs: number } | null>>();
    const ttsMetricSent = new Set<string>();

    await Promise.all(
      listeners.map(async ([ws, meta]) => {
        const translatedText = segment.translations[meta.language] ?? "";

        sendJson(ws, {
          type: "subtitle.delta",
          event_id: eventId,
          segment: {
            seq: segment.seq,
            ts: segment.ts,
            source_text: segment.source_text,
            translated_text: translatedText,
            language: meta.language,
            is_final: segment.is_final,
          },
        });

        if (!segment.is_final || !translatedText) {
          return;
        }

        if (!ttsByLanguage.has(meta.language)) {
          ttsByLanguage.set(
            meta.language,
            (async () => {
              const started = Date.now();
              const audio = await tts.synthesize({ text: translatedText, language: meta.language });
              if (!audio) {
                return null;
              }
              return {
                audioBase64: audio.audio.toString("base64"),
                mimeType: audio.mimeType,
                ttsMs: Date.now() - started,
              };
            })(),
          );
        }

        try {
          const audioPayload = await ttsByLanguage.get(meta.language)!;
          if (!audioPayload) {
            return;
          }

          sendJson(ws, {
            type: "tts.audio",
            event_id: eventId,
            segment_seq: segment.seq,
            language: meta.language,
            mime_type: audioPayload.mimeType,
            audio_base64: audioPayload.audioBase64,
          });

          const metricKey = `${segment.seq}:${meta.language}`;
          if (!ttsMetricSent.has(metricKey)) {
            ttsMetricSent.add(metricKey);
            broadcastMonitors(eventId, {
              type: "monitor.tts",
              eventId,
              seq: segment.seq,
              language: meta.language,
              ttsMs: audioPayload.ttsMs,
              mimeType: audioPayload.mimeType,
            });
          }
        } catch (error) {
          console.error("tts synth failed:", error);
        }
      }),
    );
  });

  wss.on("connection", (ws: WebSocket) => {
    const socketId = randomUUID();

    sendJson(ws, {
      type: "session.ready",
      socketId,
      ts: Date.now() / 1000,
      message: "send init message: {type:'listen'|'produce'|'monitor', ...}",
    });

    ws.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw));

        if (msg.type === "listen") {
          const language = String(msg.language ?? "en-US");
          const eventId = String(msg.eventId ?? "").trim();
          if (!eventId) {
            sendJson(ws, { type: "error", error: "eventId is required" });
            return;
          }

          const clientId = randomUUID();
          const meta: ListenerMeta = { role: "listener", clientId, eventId, language };
          clientsBySocket.set(ws, meta);
          socketByClientId.set(clientId, ws);

          const room = ensureRoom(rooms, eventId);
          room.listenerIds.add(clientId);

          sendJson(ws, {
            type: "listen.ack",
            clientId,
            eventId,
            language,
            producerId: room.producerId,
          });

          if (room.producerId) {
            const producerWs = socketByClientId.get(room.producerId);
            if (producerWs) {
              sendJson(producerWs, { type: "webrtc.listener_joined", eventId, listenerId: clientId });
            }
          }

          emitRoomStats(eventId);
          return;
        }

        if (msg.type === "monitor") {
          const eventId = String(msg.eventId ?? "").trim();
          if (!eventId) {
            sendJson(ws, { type: "error", error: "eventId is required" });
            return;
          }

          const clientId = randomUUID();
          const meta: MonitorMeta = { role: "monitor", clientId, eventId };
          clientsBySocket.set(ws, meta);
          socketByClientId.set(clientId, ws);

          const room = ensureRoom(rooms, eventId);
          room.monitorIds.add(clientId);

          sendJson(ws, { type: "monitor.ack", clientId, eventId });
          emitRoomStats(eventId);
          return;
        }

        if (msg.type === "produce") {
          const eventId = String(msg.eventId ?? "").trim();
          if (!eventId) {
            sendJson(ws, { type: "error", error: "eventId is required" });
            return;
          }

          const clientId = randomUUID();
          const meta: ProducerMeta = {
            role: "producer",
            clientId,
            eventId,
            sourceLanguage: String(msg.sourceLanguage ?? "zh-CN"),
            targetLanguages: Array.isArray(msg.targetLanguages) ? msg.targetLanguages.map(String) : ["en-US"],
          };
          clientsBySocket.set(ws, meta);
          socketByClientId.set(clientId, ws);

          const room = ensureRoom(rooms, eventId);
          room.producerId = clientId;

          sendJson(ws, { type: "produce.ack", clientId, eventId });

          for (const listenerId of room.listenerIds) {
            const listenerWs = socketByClientId.get(listenerId);
            if (!listenerWs) {
              continue;
            }
            sendJson(listenerWs, { type: "webrtc.producer_online", eventId, producerId: clientId });
            sendJson(ws, { type: "webrtc.listener_joined", eventId, listenerId });
          }

          emitRoomStats(eventId);
          return;
        }

        const meta = clientsBySocket.get(ws);
        if (!meta) {
          sendJson(ws, { type: "error", error: "send init message first" });
          return;
        }

        if (msg.type === "webrtc.offer" || msg.type === "webrtc.answer" || msg.type === "webrtc.ice") {
          const to = String(msg.to ?? "").trim();
          if (!to) {
            sendJson(ws, { type: "error", error: "missing signaling target" });
            return;
          }
          const peerWs = socketByClientId.get(to);
          if (!peerWs) {
            sendJson(ws, { type: "error", error: "target peer not found" });
            return;
          }

          sendJson(peerWs, {
            ...msg,
            from: meta.clientId,
            eventId: meta.eventId,
          });
          return;
        }

        if (msg.type === "asr.chunk" && meta.role === "producer") {
          const audioBase64 = String(msg.audioBase64 ?? "").trim();
          if (!audioBase64) {
            return;
          }

          const pipelineStart = Date.now();
          const audioBuffer = Buffer.from(audioBase64, "base64");
          const mimeType = String(msg.mimeType ?? "audio/webm");
          const magic = audioBuffer.subarray(0, 12).toString("hex");

          let text: string | null = null;
          let asrMs = 0;
          try {
            const asrStart = Date.now();
            text = await asr.transcribeChunk({
              audio: audioBuffer,
              mimeType,
              sourceLanguage: meta.sourceLanguage,
            });
            asrMs = Date.now() - asrStart;
          } catch (error) {
            console.error("asr failed:", error);
            const errMsg = String((error as Error)?.message ?? "asr failed");
            const details = `asr failed: ${errMsg}; mime=${mimeType}; bytes=${audioBuffer.length}; magic=${magic}`;
            sendJson(ws, { type: "asr.error", error: details });
            broadcastMonitors(meta.eventId, {
              type: "monitor.error",
              eventId: meta.eventId,
              stage: "asr",
              error: details,
            });
            return;
          }

          if (!text) {
            return;
          }

          try {
            const result = await runtime.ingestSpeech({
              eventId: meta.eventId,
              sourceText: text,
              sourceLanguage: meta.sourceLanguage,
              targetLanguages: meta.targetLanguages,
              isFinal: true,
            });

            const endToEndMs = Date.now() - pipelineStart;
            broadcastMonitors(meta.eventId, {
              type: "monitor.metrics",
              eventId: meta.eventId,
              seq: result.payload.data.segment.seq,
              asrMs,
              translationMs: result.metrics.translationMs,
              ttsMs: null,
              dbMs: result.metrics.dbMs,
              ingestMs: result.metrics.ingestMs,
              endToEndMs,
              cacheHit: result.metrics.cacheHit,
              textPreview: text.slice(0, 80),
            });
          } catch (error) {
            console.error("ingest speech failed:", error);
            sendJson(ws, { type: "ingest.error", error: String((error as Error).message) });
            broadcastMonitors(meta.eventId, { type: "monitor.error", eventId: meta.eventId, stage: "ingest" });
          }
          return;
        }

        sendJson(ws, { type: "error", error: "unsupported message type" });
      } catch (error) {
        sendJson(ws, { type: "error", error: String((error as Error).message) });
      }
    });

    ws.on("close", () => {
      const meta = clientsBySocket.get(ws);
      if (!meta) {
        return;
      }

      clientsBySocket.delete(ws);
      socketByClientId.delete(meta.clientId);

      const room = rooms.get(meta.eventId);
      if (room) {
        if (meta.role === "producer") {
          if (room.producerId === meta.clientId) {
            room.producerId = null;
          }
          for (const listenerId of room.listenerIds) {
            const listenerWs = socketByClientId.get(listenerId);
            if (listenerWs) {
              sendJson(listenerWs, { type: "webrtc.producer_offline", eventId: meta.eventId });
            }
          }
        } else if (meta.role === "listener") {
          room.listenerIds.delete(meta.clientId);
          if (room.producerId) {
            const producerWs = socketByClientId.get(room.producerId);
            if (producerWs) {
              sendJson(producerWs, {
                type: "webrtc.listener_left",
                eventId: meta.eventId,
                listenerId: meta.clientId,
              });
            }
          }
        } else {
          room.monitorIds.delete(meta.clientId);
        }

        emitRoomStats(meta.eventId);

        if (!room.producerId && room.listenerIds.size === 0 && room.monitorIds.size === 0) {
          rooms.delete(meta.eventId);
        }
      }
    });
  });

  server.listen(PORT, HOST, () => {
    const protocol = TLS_CERT_FILE && TLS_KEY_FILE ? "https" : "http";
    console.log(`CWcomm server running at ${protocol}://${HOST}:${PORT}`);
    console.log("HTTP API + SSE + WS+WebRTC live gateway (/ws/live)");
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
