import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../src/app.js";

const prisma = new PrismaClient();
const app = createApp({ prisma });

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

beforeAll(async () => {
  await prisma.$connect();
  server = app.listen(0);
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unable to resolve test server address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await prisma.$transaction([
    prisma.$executeRawUnsafe('TRUNCATE TABLE "subtitle_segments" RESTART IDENTITY CASCADE;'),
    prisma.$executeRawUnsafe('TRUNCATE TABLE "events" CASCADE;'),
  ]);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
});

describe("CWcomm API integration", () => {
  it("creates event, transitions to LIVE, stores and reads subtitles", async () => {
    const create = await request(baseUrl).post("/api/events").send({
      name: "Integration Event",
      source_language: "zh-CN",
      target_languages: ["en-US"],
    });

    expect(create.status).toBe(201);
    const eventId = create.body.item.id as string;

    const toReady = await request(baseUrl)
      .post(`/api/events/${eventId}/transition`)
      .send({ target_status: "READY" });
    expect(toReady.status).toBe(200);

    const toLive = await request(baseUrl)
      .post(`/api/events/${eventId}/transition`)
      .send({ target_status: "LIVE" });
    expect(toLive.status).toBe(200);

    const push = await request(baseUrl)
      .post(`/api/events/${eventId}/subtitles`)
      .send({
        source_text: "你好，欢迎来到活动现场",
        translations: {
          "en-US": "Hello, welcome to the venue",
        },
      });

    expect(push.status).toBe(201);
    expect(push.body.item.seq).toBe(1);

    const list = await request(baseUrl).get(`/api/events/${eventId}/subtitles?lang=en-US&after=0`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].translated_text).toBe("Hello, welcome to the venue");
  });

  it("rejects invalid status transition", async () => {
    const create = await request(baseUrl).post("/api/events").send({
      name: "Transition Guard",
      source_language: "zh-CN",
      target_languages: ["en-US"],
    });

    const eventId = create.body.item.id as string;
    const invalid = await request(baseUrl)
      .post(`/api/events/${eventId}/transition`)
      .send({ target_status: "ENDED" });

    expect(invalid.status).toBe(409);
    expect(String(invalid.body.error)).toContain("invalid transition");
  });

  it("ingests speech text and generates placeholder translations", async () => {
    const create = await request(baseUrl).post("/api/events").send({
      name: "Speech Ingest Event",
      source_language: "zh-CN",
      target_languages: ["en-US"],
    });
    const eventId = create.body.item.id as string;

    await request(baseUrl).post(`/api/events/${eventId}/transition`).send({ target_status: "READY" });
    await request(baseUrl).post(`/api/events/${eventId}/transition`).send({ target_status: "LIVE" });

    const ingest = await request(baseUrl).post(`/api/events/${eventId}/speech/ingest`).send({
      source_text: "欢迎来到现场",
      source_language: "zh-CN",
      target_languages: ["en-US"],
      is_final: true,
    });

    expect(ingest.status).toBe(201);
    expect(ingest.body.item.translations["en-US"]).toBe("[en-US] 欢迎来到现场");
  });

  it("rejects unsupported language in event creation", async () => {
    const create = await request(baseUrl).post("/api/events").send({
      name: "Unsupported Lang Event",
      source_language: "zh-CN",
      target_languages: ["ja-JP"],
    });
    expect(create.status).toBe(400);
    expect(String(create.body.error)).toContain("unsupported language");
  });

  it("opens SSE stream and emits session.ready", async () => {
    const create = await request(baseUrl).post("/api/events").send({
      name: "SSE Event",
      source_language: "zh-CN",
      target_languages: ["en-US"],
    });

    const eventId = create.body.item.id as string;

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events/${eventId}/subtitles/stream`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();

    const first = await reader!.read();
    const chunk = new TextDecoder().decode(first.value ?? new Uint8Array());

    expect(chunk).toContain("session.ready");

    controller.abort();
  });
});
