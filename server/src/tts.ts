import { getApiKey } from "./secrets.js";

export type TtsInput = {
  text: string;
  language: string;
};

export type TtsOutput = {
  audio: Buffer;
  mimeType: string;
};

export type TtsService = {
  synthesize(input: TtsInput): Promise<TtsOutput | null>;
};

function createMockWavTone(): Buffer {
  const sampleRate = 16000;
  const durationSec = 0.18;
  const sampleCount = Math.floor(sampleRate * durationSec);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const amp = Math.sin(2 * Math.PI * 660 * t) * 0.12;
    const sample = Math.max(-1, Math.min(1, amp));
    buffer.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
  }

  return buffer;
}

class MockTtsService implements TtsService {
  private readonly tone = createMockWavTone();

  async synthesize(input: TtsInput): Promise<TtsOutput | null> {
    if (!input.text.trim()) {
      return null;
    }
    return {
      audio: this.tone,
      mimeType: "audio/wav",
    };
  }
}

class OpenAITtsService implements TtsService {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly format: string;

  constructor(params: { apiKey: string; endpoint?: string; model: string; voice: string; format: string }) {
    this.apiKey = params.apiKey;
    this.endpoint = params.endpoint ?? "https://api.openai.com/v1/audio/speech";
    this.model = params.model;
    this.voice = params.voice;
    this.format = params.format;
  }

  async synthesize(input: TtsInput): Promise<TtsOutput | null> {
    if (!input.text.trim()) {
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: input.text,
          format: this.format,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`openai tts failed (${response.status}): ${body.slice(0, 300)}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        audio: Buffer.from(arrayBuffer),
        mimeType: this.format === "wav" ? "audio/wav" : "audio/mpeg",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createTtsFromEnv(): TtsService {
  const provider = (process.env.CWCOMM_TTS_PROVIDER ?? "mock").toLowerCase();
  if (provider === "openai") {
    const apiKey = getApiKey(["CWCOMM_TTS_API_KEY", "OPENAI_API_KEY", "CWCOMM_API_KEY"]);
    if (!apiKey) {
      throw new Error("TTS API key is required (CWCOMM_TTS_API_KEY or OPENAI_API_KEY)");
    }
    return new OpenAITtsService({
      apiKey,
      endpoint: process.env.CWCOMM_OPENAI_TTS_ENDPOINT,
      model: process.env.CWCOMM_OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
      voice: process.env.CWCOMM_OPENAI_TTS_VOICE ?? "alloy",
      format: process.env.CWCOMM_OPENAI_TTS_FORMAT ?? "mp3",
    });
  }
  return new MockTtsService();
}
