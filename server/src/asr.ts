import { getApiKey } from "./secrets.js";

export type AsrInput = {
  audio: Buffer;
  mimeType: string;
  sourceLanguage: string;
};

export type AsrService = {
  transcribeChunk(input: AsrInput): Promise<string | null>;
};

class MockAsrService implements AsrService {
  async transcribeChunk(): Promise<string | null> {
    return null;
  }
}

class OpenAIAsrService implements AsrService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(params: { apiKey: string; model: string; endpoint?: string }) {
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.endpoint = params.endpoint ?? "https://api.openai.com/v1/audio/transcriptions";
  }

  async transcribeChunk(input: AsrInput): Promise<string | null> {
    if (!input.audio.length) {
      return null;
    }

    const form = new FormData();
    const mimeType = input.mimeType || "audio/webm";
    const blob = new Blob([input.audio], { type: mimeType });
    form.append("file", blob, `chunk.${guessExtFromMime(mimeType)}`);
    form.append("model", this.model);
    if (input.sourceLanguage && input.sourceLanguage.toLowerCase() !== "auto") {
      form.append("language", input.sourceLanguage.split("-")[0].toLowerCase());
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`openai asr failed (${response.status}): ${body.slice(0, 300)}`);
      }

      const payload = (await response.json()) as { text?: string };
      const text = String(payload.text ?? "").trim();
      return text || null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function guessExtFromMime(mimeType: string): string {
  const clean = String(mimeType).toLowerCase().split(";")[0].trim();
  if (clean === "audio/webm") return "webm";
  if (clean === "audio/mp4") return "mp4";
  if (clean === "audio/mpeg") return "mp3";
  if (clean === "audio/wav" || clean === "audio/x-wav") return "wav";
  if (clean === "audio/ogg") return "ogg";
  if (clean === "audio/flac") return "flac";
  if (clean === "audio/m4a" || clean === "audio/mp4a-latm") return "m4a";
  return "webm";
}

export function createAsrFromEnv(): AsrService {
  const provider = (process.env.CWCOMM_ASR_PROVIDER ?? "mock").toLowerCase();
  if (provider === "openai") {
    const apiKey = getApiKey(["CWCOMM_ASR_API_KEY", "OPENAI_API_KEY", "CWCOMM_API_KEY"]);
    if (!apiKey) {
      throw new Error("ASR API key is required (CWCOMM_ASR_API_KEY or OPENAI_API_KEY)");
    }
    return new OpenAIAsrService({
      apiKey,
      model: process.env.CWCOMM_OPENAI_ASR_MODEL ?? "gpt-4o-mini-transcribe",
      endpoint: process.env.CWCOMM_OPENAI_ASR_ENDPOINT,
    });
  }
  return new MockAsrService();
}
