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
import { initSfuWorker, getOrCreateRouter, createWebRtcTransport, transports, producers, consumers, cleanupClientSfu } from "./sfu.js";
import { startRedisBus, onBroadcast, broadcastEvent } from "./redisHub.js";

const HOST = process.env.CWCOMM_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CWCOMM_PORT ?? 8080);
const TLS_CERT_FILE = process.env.CWCOMM_TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.CWCOMM_TLS_KEY_FILE;

type ListenerMeta = { role: "listener"; clientId: string; eventId: string; language: string };
type ProducerMeta = { role: "producer"; clientId: string; eventId: string; sourceLanguage: string; targetLanguages: string[] };
type MonitorMeta = { role: "monitor"; clientId: string; eventId: string };
type ClientMeta = ListenerMeta | ProducerMeta | MonitorMeta;

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (isOpen(ws)) {
    ws.send(JSON.stringify(payload));
  }
}

async function start() {
  await prisma.$connect();
  const runtime = createRuntime({ prisma });
  const asr = createAsrFromEnv();
  const tts = createTtsFromEnv();
  
  await initSfuWorker();
  await startRedisBus();

  const server = TLS_CERT_FILE && TLS_KEY_FILE
    ? createHttpsServer({ cert: fs.readFileSync(path.resolve(TLS_CERT_FILE)), key: fs.readFileSync(path.resolve(TLS_KEY_FILE)) }, runtime.app)
    : createServer(runtime.app);

  const wss = new WebSocketServer({ server, path: "/ws/live" });
  const clientsBySocket = new Map<WebSocket, ClientMeta>();
  const socketByClientId = new Map<string, WebSocket>();
  let localStats = { producer: 0, listener: 0, monitor: 0 };

  // --- REDIS SUBSCRIBER HUB: Handling global broadcasts ---
  onBroadcast((ev) => {
    // Deliver to all matching local clients
    for (const [ws, meta] of clientsBySocket.entries()) {
      if (meta.eventId !== ev.eventId || !isOpen(ws)) continue;

      if (ev.topic === "monitor_stats" && meta.role === "monitor") {
         sendJson(ws, ev.payload); 
      }
      if (ev.topic === "monitor_subtitle" && meta.role === "monitor") {
         sendJson(ws, ev.payload);
      }
      if (ev.topic === "monitor_tts" && meta.role === "monitor") {
         sendJson(ws, ev.payload);
      }
      if (ev.topic === "monitor_metrics" && meta.role === "monitor") {
         sendJson(ws, ev.payload);
      }
      if (ev.topic === "subtitle") {
         // Only listener needs this delta, and we filter language on client or here.
         // Here we just send it if language matches.
         if (meta.role === "listener" && meta.language === ev.payload.segment.language) {
            sendJson(ws, { type: "subtitle.delta", event_id: ev.eventId, segment: ev.payload.segment });
         }
      }
      if (ev.topic === "tts") {
         if (meta.role === "listener" && meta.language === ev.payload.language) {
            sendJson(ws, { type: "tts.audio", event_id: ev.eventId, ...ev.payload });
         }
      }
      if (ev.topic === "sfu_producer_state" && meta.role === "listener") {
         sendJson(ws, { type: "sfu.producer_state", eventId: ev.eventId, active: ev.payload.active });
      }
    }
  });

  function emitMonitorStats(eventId: string) {
    const isProducerLocal = Array.from(clientsBySocket.values()).some(m => m.eventId === eventId && m.role === "producer");
    broadcastEvent({
      eventId,
      topic: "monitor_stats",
      payload: { type: "monitor.stats", eventId, producerOnline: isProducerLocal, ts: Date.now()/1000 }
    });
  }

  // AI Pipeline Output -> Broadcast to Redis!
  runtime.onSubtitle(async (payload: SubtitleDeltaPayload) => {
    const eventId = payload.data.event_id;
    const segment = payload.data.segment;
    
    broadcastEvent({ eventId, topic: "monitor_subtitle", payload: { type: "monitor.subtitle", eventId, seq: segment.seq, sourceText: segment.source_text, isFinal: segment.is_final, ts: segment.ts }});

    // We do one TTS gen per language globally (assuming sticky session) or locally
    // For MVP scale, running TS per node is fine, but checking translation target is better.
    const langs = Object.keys(segment.translations || {});
    for (const lang of langs) {
      const translatedText = segment.translations[lang] ?? "";
      
      broadcastEvent({
        eventId, topic: "subtitle",
        payload: { segment: { seq: segment.seq, ts: segment.ts, source_text: segment.source_text, translated_text: translatedText, language: lang, is_final: segment.is_final } }
      });

      if (segment.is_final && translatedText) {
         try {
           const started = Date.now();
           const audio = await tts.synthesize({ text: translatedText, language: lang });
           if (audio) {
             const ttsMs = Date.now() - started;
             broadcastEvent({ eventId, topic: "tts", payload: { segment_seq: segment.seq, language: lang, mime_type: audio.mimeType, audio_base64: audio.audio.toString("base64") } });
             broadcastEvent({ eventId, topic: "monitor_tts", payload: { type: "monitor.tts", eventId, seq: segment.seq, language: lang, ttsMs, mimeType: audio.mimeType } });
           }
         } catch (err) { console.error("tts synth error", err); }
      }
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    const socketId = randomUUID();
    sendJson(ws, { type: "session.ready", socketId, ts: Date.now() / 1000 });

    ws.on("message", async (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw));

        if (msg.type === "listen") {
          const clientId = randomUUID();
          const meta: ListenerMeta = { role: "listener", clientId, eventId: msg.eventId, language: msg.language || "en-US" };
          clientsBySocket.set(ws, meta); socketByClientId.set(clientId, ws);
          sendJson(ws, { type: "listen.ack", clientId, eventId: msg.eventId });
          
          // Let client know if producer is ready implicitly via global pubsub if desired.
          return;
        }

        if (msg.type === "produce") {
          const clientId = randomUUID();
          const meta: ProducerMeta = { role: "producer", clientId, eventId: msg.eventId, sourceLanguage: msg.sourceLanguage || "zh-CN", targetLanguages: msg.targetLanguages || ["en-US"] };
          clientsBySocket.set(ws, meta); socketByClientId.set(clientId, ws);
          sendJson(ws, { type: "produce.ack", clientId, eventId: msg.eventId });
          return;
        }

        if (msg.type === "monitor") {
          const clientId = randomUUID();
          const meta: MonitorMeta = { role: "monitor", clientId, eventId: msg.eventId };
          clientsBySocket.set(ws, meta); socketByClientId.set(clientId, ws);
          sendJson(ws, { type: "monitor.ack", clientId, eventId: msg.eventId });
          return;
        }

        const meta = clientsBySocket.get(ws);
        if (!meta) return;

        // Mediasoup SFU Signaling
        if (msg.type === "sfu.getRouterRtpCapabilities") {
          const router = await getOrCreateRouter(meta.eventId);
          sendJson(ws, { type: "sfu.routerRtpCapabilities", rtpCapabilities: router.rtpCapabilities });
          return;
        }
        
        if (msg.type === "sfu.createWebRtcTransport") {
          const router = await getOrCreateRouter(meta.eventId);
          const transport = await createWebRtcTransport(router);
          transports.set(meta.clientId, transport);

          transport.on("dtlsstatechange", state => {
             if (state === "closed" || state === "failed") transport.close();
          });

          sendJson(ws, { type: "sfu.transportCreated", id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
          return;
        }

        if (msg.type === "sfu.connectTransport") {
          const transport = transports.get(meta.clientId);
          if (transport) await transport.connect({ dtlsParameters: msg.dtlsParameters });
          sendJson(ws, { type: "sfu.transportConnected" });
          return;
        }

        if (msg.type === "sfu.produce" && meta.role === "producer") {
          const transport = transports.get(meta.clientId);
          if (transport) {
            const producer = await transport.produce({ kind: msg.kind, rtpParameters: msg.rtpParameters });
            producers.set(meta.eventId, producer);
            broadcastEvent({ eventId: meta.eventId, topic: "sfu_producer_state", payload: { active: true } });
            sendJson(ws, { type: "sfu.produced", id: producer.id });
          }
          return;
        }

        if (msg.type === "sfu.consume" && meta.role === "listener") {
          const router = await getOrCreateRouter(meta.eventId);
          const transport = transports.get(meta.clientId);
          const producer = producers.get(meta.eventId);
          
          if (transport && producer && router.canConsume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities })) {
            const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities, paused: false });
            let clist = consumers.get(meta.clientId) || [];
            clist.push(consumer); consumers.set(meta.clientId, clist);
            sendJson(ws, { type: "sfu.consumed", id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
          } else {
            sendJson(ws, { type: "error", error: "Producer not found or cannot consume." });
          }
          return;
        }

        if (msg.type === "asr.chunk" && meta.role === "producer") {
           // (Kept MVP ASR logic for chunks)
           const audioBase64 = String(msg.audioBase64 ?? "").trim();
           if (!audioBase64) return;
           const pipelineStart = Date.now();
           const audioBuffer = Buffer.from(audioBase64, "base64");
           
           try {
             const asrStart = Date.now();
             const text = await asr.transcribeChunk({ audio: audioBuffer, mimeType: msg.mimeType || "audio/webm", sourceLanguage: meta.sourceLanguage });
             const asrMs = Date.now() - asrStart;
             if (text) {
               const result = await runtime.ingestSpeech({ eventId: meta.eventId, sourceText: text, sourceLanguage: meta.sourceLanguage, targetLanguages: meta.targetLanguages, isFinal: true });
               broadcastEvent({ eventId: meta.eventId, topic: "monitor_metrics", payload: { type: "monitor.metrics", eventId: meta.eventId, seq: result.payload.data.segment.seq, asrMs, translationMs: result.metrics.translationMs, ttsMs: null, dbMs: result.metrics.dbMs, ingestMs: result.metrics.ingestMs, endToEndMs: Date.now() - pipelineStart, cacheHit: result.metrics.cacheHit, textPreview: text.slice(0, 80) }});
             }
           } catch (err) {
             console.error("asr/ingest err", err);
           }
           return;
        }

      } catch (err) {
        console.error(err);
      }
    });

    ws.on("close", () => {
      const meta = clientsBySocket.get(ws);
      if (meta) {
        cleanupClientSfu(meta.clientId);
        if (meta.role === "producer") {
           broadcastEvent({ eventId: meta.eventId, topic: "sfu_producer_state", payload: { active: false } });
        }
        clientsBySocket.delete(ws);
        socketByClientId.delete(meta.clientId);
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[CWcomm] Live at ${TLS_CERT_FILE ? "https" : "http"}://${HOST}:${PORT}`);
    console.log("[Notice] Running with SFU and Redis Pub/Sub Broadcast engine.");
  });
}

start().catch(e => { console.error(e); process.exit(1); });
