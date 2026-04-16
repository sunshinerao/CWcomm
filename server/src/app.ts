import cors from "cors";
import express, { type Request, type Response } from "express";
import { EventStatus, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { SseHub } from "./sseHub.js";
import { createTranslatorFromEnv } from "./translator.js";
import { TranslationCache } from "./translationCache.js";

const transitionRules: Record<EventStatus, EventStatus[]> = {
  DRAFT: ["READY", "ARCHIVED"],
  READY: ["LIVE", "ARCHIVED"],
  LIVE: ["ENDED"],
  ENDED: ["ARCHIVED"],
  ARCHIVED: [],
};

const createEventSchema = z.object({
  name: z.string().trim().min(1),
  source_language: z.string().trim().min(1).default("zh-CN"),
  target_languages: z.array(z.string().trim().min(1)).min(1),
});

const transitionSchema = z.object({
  target_status: z.nativeEnum(EventStatus),
});

const createSubtitleSchema = z.object({
  source_text: z.string().trim().min(1),
  translations: z.record(z.string(), z.string()),
  is_final: z.boolean().optional().default(false),
});

const ingestSpeechSchema = z.object({
  source_text: z.string().trim().min(1),
  source_language: z.string().trim().min(1).optional(),
  target_languages: z.array(z.string().trim().min(1)).optional(),
  is_final: z.boolean().optional().default(true),
});

const SUPPORTED_LANGUAGES = new Set(["zh-CN", "en-US"]);
const CJK_REGEX = /[\u3400-\u9FFF]/;

function normalizeLanguageCode(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    throw new Error("language code is required");
  }
  if (normalized.startsWith("zh")) {
    return "zh-CN";
  }
  if (normalized.startsWith("en")) {
    return "en-US";
  }
  throw new Error(`unsupported language: ${input} (only zh/en supported now)`);
}

function detectLanguageFromText(text: string): string {
  return CJK_REGEX.test(text) ? "zh-CN" : "en-US";
}

function toEventDto(event: {
  id: string;
  name: string;
  sourceLanguage: string;
  targetLanguages: Prisma.JsonValue;
  status: EventStatus;
  createdAt: Date;
}) {
  return {
    id: event.id,
    name: event.name,
    source_language: event.sourceLanguage,
    target_languages: Array.isArray(event.targetLanguages) ? event.targetLanguages : [],
    status: event.status,
    created_at: event.createdAt.getTime() / 1000,
  };
}

export type SubtitleDeltaPayload = {
  event: "subtitle.delta";
  data: {
    event_id: string;
    segment: {
      seq: number;
      ts: number;
      source_text: string;
      translations: Record<string, string>;
      is_final: boolean;
    };
  };
};

export type Runtime = {
  app: ReturnType<typeof express>;
  ingestSpeech: (params: {
    eventId: string;
    sourceText: string;
    sourceLanguage?: string;
    targetLanguages?: string[];
    isFinal?: boolean;
  }) => Promise<{ payload: SubtitleDeltaPayload; metrics: { translationMs: number; dbMs: number; ingestMs: number; cacheHit: boolean } }>;
  onSubtitle: (handler: (payload: SubtitleDeltaPayload) => void | Promise<void>) => void;
};

export function createRuntime(params: { prisma: PrismaClient; hub?: SseHub }): Runtime {
  const { prisma } = params;
  const hub = params.hub ?? new SseHub();
  const translator = createTranslatorFromEnv();
  const translationCache = new TranslationCache(Number(process.env.CWCOMM_TRANSLATION_CACHE_TTL_MS ?? 15000));
  const subtitleHandlers = new Set<(payload: SubtitleDeltaPayload) => void | Promise<void>>();

  setInterval(() => {
    translationCache.sweep();
  }, 10000).unref();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  async function insertSubtitle(params2: {
    eventId: string;
    sourceText: string;
    translations: Record<string, string>;
    isFinal: boolean;
  }): Promise<SubtitleDeltaPayload> {
    let inserted: Awaited<ReturnType<typeof prisma.subtitleSegment.create>> | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        inserted = await prisma.$transaction(async (tx) => {
          const agg = await tx.subtitleSegment.aggregate({
            where: { eventId: params2.eventId },
            _max: { seq: true },
          });
          const nextSeq = (agg._max.seq ?? 0) + 1;

          return tx.subtitleSegment.create({
            data: {
              eventId: params2.eventId,
              seq: nextSeq,
              sourceText: params2.sourceText,
              translations: params2.translations,
              isFinal: params2.isFinal,
            },
          });
        });
        break;
      } catch (error) {
        const isUniqueConflict =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
        if (!isUniqueConflict || attempt === 3) {
          throw error;
        }
      }
    }

    if (!inserted) {
      throw new Error("failed to insert subtitle segment");
    }

    const payload: SubtitleDeltaPayload = {
      event: "subtitle.delta",
      data: {
        event_id: params2.eventId,
        segment: {
          seq: inserted.seq,
          ts: inserted.ts.getTime() / 1000,
          source_text: inserted.sourceText,
          translations: inserted.translations as Record<string, string>,
          is_final: inserted.isFinal,
        },
      },
    };

    hub.publish(params2.eventId, payload);
    for (const handler of subtitleHandlers) {
      Promise.resolve(handler(payload)).catch((error) => {
        console.error("subtitle handler failed:", error);
      });
    }
    return payload;
  }

  async function ingestSpeech(params2: {
    eventId: string;
    sourceText: string;
    sourceLanguage?: string;
    targetLanguages?: string[];
    isFinal?: boolean;
  }): Promise<{ payload: SubtitleDeltaPayload; metrics: { translationMs: number; dbMs: number; ingestMs: number; cacheHit: boolean } }> {
    const ingestStart = Date.now();
    const event = await prisma.event.findUnique({ where: { id: params2.eventId } });
    if (!event) {
      throw new Error("event not found");
    }
    if (event.status !== EventStatus.LIVE) {
      throw new Error("event must be LIVE before speech ingestion");
    }

    const requestedSource = String(params2.sourceLanguage ?? event.sourceLanguage).trim();
    const sourceLanguage =
      requestedSource.toLowerCase() === "auto"
        ? detectLanguageFromText(params2.sourceText)
        : normalizeLanguageCode(requestedSource);
    const rawTargets =
      params2.targetLanguages?.length
        ? params2.targetLanguages
        : Array.isArray(event.targetLanguages)
          ? (event.targetLanguages as string[])
          : [];

    const targets = Array.from(new Set(rawTargets.map(normalizeLanguageCode))).filter((lang) => lang !== sourceLanguage);
    if (targets.length === 0) {
      throw new Error("no valid target language (only zh/en supported now)");
    }

    const cacheKey = translationCache.makeKey({
      sourceText: params2.sourceText,
      sourceLanguage,
      targetLanguages: targets,
    });

    const translationStart = Date.now();
    let translations = translationCache.get(cacheKey);
    let cacheHit = Boolean(translations);
    if (!translations) {
      try {
        translations = await translator.translateMany({
          sourceText: params2.sourceText,
          sourceLanguage,
          targetLanguages: targets,
        });
        translationCache.set(cacheKey, translations);
      } catch (error) {
        console.error("translation failed, fallback to mock:", error);
        translations = Object.fromEntries(targets.map((lang) => [lang, `[${lang}] ${params2.sourceText}`]));
      }
      cacheHit = false;
    }
    const translationMs = Date.now() - translationStart;

    const dbStart = Date.now();
    const payload = await insertSubtitle({
      eventId: params2.eventId,
      sourceText: params2.sourceText,
      translations,
      isFinal: params2.isFinal ?? true,
    });
    const dbMs = Date.now() - dbStart;
    const ingestMs = Date.now() - ingestStart;

    return {
      payload,
      metrics: {
        translationMs,
        dbMs,
        ingestMs,
        cacheHit,
      },
    };
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "cwcomm", ts: Date.now() / 1000 });
  });

  app.get("/api/events", async (req, res) => {
    const statusRaw = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";
    const where =
      statusRaw && Object.prototype.hasOwnProperty.call(EventStatus, statusRaw)
        ? { status: statusRaw as EventStatus }
        : undefined;

    const events = await prisma.event.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json({ items: events.map(toEventDto) });
  });

  app.post("/api/events", async (req, res) => {
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid payload" });
    }

    let sourceLanguage = "zh-CN";
    let targetLanguages: string[] = [];
    try {
      sourceLanguage = normalizeLanguageCode(parsed.data.source_language);
      targetLanguages = Array.from(new Set(parsed.data.target_languages.map(normalizeLanguageCode))).filter(
        (lang) => lang !== sourceLanguage,
      );
    } catch (error) {
      return res.status(400).json({ error: String((error as Error).message) });
    }

    if (!SUPPORTED_LANGUAGES.has(sourceLanguage) || targetLanguages.length === 0) {
      return res.status(400).json({ error: "source/target languages must be zh/en and not identical" });
    }

    const item = await prisma.event.create({
      data: {
        name: parsed.data.name,
        sourceLanguage,
        targetLanguages,
      },
    });

    return res.status(201).json({ item: toEventDto(item) });
  });

  app.post("/api/events/:eventId/transition", async (req, res) => {
    const { eventId } = req.params;
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "target_status is required" });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      return res.status(404).json({ error: "event not found" });
    }

    if (!transitionRules[event.status].includes(parsed.data.target_status)) {
      return res.status(409).json({ error: `invalid transition: ${event.status} -> ${parsed.data.target_status}` });
    }

    const updated = await prisma.event.update({
      where: { id: eventId },
      data: { status: parsed.data.target_status },
    });

    return res.json({ item: toEventDto(updated) });
  });

  app.get("/api/events/:eventId/subtitles", async (req, res) => {
    const { eventId } = req.params;
    const lang = typeof req.query.lang === "string" ? req.query.lang : "en-US";
    const after = Number(req.query.after ?? 0);

    if (Number.isNaN(after)) {
      return res.status(400).json({ error: "after must be int" });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) {
      return res.status(404).json({ error: "event not found" });
    }

    const segments = await prisma.subtitleSegment.findMany({
      where: { eventId, seq: { gt: after } },
      orderBy: { seq: "asc" },
    });

    const items = segments.map((seg) => {
      const translations = seg.translations as Record<string, string>;
      return {
        seq: seg.seq,
        ts: seg.ts.getTime() / 1000,
        source_text: seg.sourceText,
        translated_text: translations[lang] ?? "",
        is_final: seg.isFinal,
      };
    });

    return res.json({ items });
  });

  app.post("/api/events/:eventId/subtitles", async (req, res) => {
    const { eventId } = req.params;
    const parsed = createSubtitleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid payload" });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      return res.status(404).json({ error: "event not found" });
    }
    if (event.status !== EventStatus.LIVE) {
      return res.status(409).json({ error: "event must be LIVE before subtitle ingestion" });
    }

    const payload = await insertSubtitle({
      eventId,
      sourceText: parsed.data.source_text,
      translations: parsed.data.translations,
      isFinal: parsed.data.is_final,
    });
    return res.status(201).json({ item: payload.data.segment });
  });

  app.post("/api/events/:eventId/speech/ingest", async (req, res) => {
    const { eventId } = req.params;
    const parsed = ingestSpeechSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid payload" });
    }

    try {
      const result = await ingestSpeech({
        eventId,
        sourceText: parsed.data.source_text,
        sourceLanguage: parsed.data.source_language,
        targetLanguages: parsed.data.target_languages,
        isFinal: parsed.data.is_final,
      });
      return res.status(201).json({
        item: result.payload.data.segment,
        metrics: result.metrics,
      });
    } catch (error) {
      const message = String((error as Error).message || "speech ingest failed");
      if (message.includes("event not found")) {
        return res.status(404).json({ error: message });
      }
      if (message.includes("LIVE")) {
        return res.status(409).json({ error: message });
      }
      return res.status(400).json({ error: message });
    }
  });

  app.get("/api/events/:eventId/subtitles/stream", async (req: Request, res: Response) => {
    const { eventId } = req.params;
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) {
      return res.status(404).json({ error: "event not found" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    hub.subscribe(eventId, res);
    res.write(`data: ${JSON.stringify({ event: "session.ready", data: { event_id: eventId, ts: Date.now() / 1000 } })}\n\n`);

    const timer = setInterval(() => {
      hub.ping(eventId);
    }, 15000);

    req.on("close", () => {
      clearInterval(timer);
      hub.unsubscribe(eventId, res);
    });
  });

  return {
    app,
    ingestSpeech,
    onSubtitle(handler) {
      subtitleHandlers.add(handler);
    },
  };
}

export function createApp(params: { prisma: PrismaClient; hub?: SseHub }) {
  return createRuntime(params).app;
}
