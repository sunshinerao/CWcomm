import { getApiKey } from "./secrets.js";

export type TranslateInput = {
  sourceText: string;
  sourceLanguage: string;
  targetLanguages: string[];
};

export type Translator = {
  translateMany(input: TranslateInput): Promise<Record<string, string>>;
};

const LANGUAGE_NAME_MAP: Record<string, string> = {
  zh: "Chinese",
  "zh-cn": "Chinese (Simplified)",
  "zh-hans": "Chinese (Simplified)",
  "zh-tw": "Chinese (Traditional)",
  "zh-hant": "Chinese (Traditional)",
  en: "English",
  "en-us": "English (US)",
  "en-gb": "English (UK)",
  ja: "Japanese",
  "ja-jp": "Japanese",
  ko: "Korean",
  "ko-kr": "Korean",
  fr: "French",
  "fr-fr": "French",
  de: "German",
  "de-de": "German",
  es: "Spanish",
  "es-es": "Spanish",
  it: "Italian",
  "it-it": "Italian",
  pt: "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  ru: "Russian",
  "ru-ru": "Russian",
  ar: "Arabic",
  "ar-sa": "Arabic",
  hi: "Hindi",
  "hi-in": "Hindi",
};

export function resolveLanguageLabel(languageCode: string): string {
  const normalized = languageCode.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  if (LANGUAGE_NAME_MAP[normalized]) {
    return LANGUAGE_NAME_MAP[normalized];
  }
  const base = normalized.split("-")[0];
  if (base && LANGUAGE_NAME_MAP[base]) {
    return LANGUAGE_NAME_MAP[base];
  }
  return normalized;
}

function describeLanguage(languageCode: string): string {
  const label = resolveLanguageLabel(languageCode);
  return `${label} (${languageCode})`;
}

class MockTranslator implements Translator {
  async translateMany(input: TranslateInput): Promise<Record<string, string>> {
    return Object.fromEntries(input.targetLanguages.map((lang) => [lang, `[${lang}] ${input.sourceText}`]));
  }
}

class OpenAITranslator implements Translator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(params: { apiKey: string; model: string; endpoint?: string }) {
    this.apiKey = params.apiKey;
    this.model = params.model;
    this.endpoint = params.endpoint ?? "https://api.openai.com/v1/responses";
  }

  async translateMany(input: TranslateInput): Promise<Record<string, string>> {
    const uniqueTargets = Array.from(new Set(input.targetLanguages));
    if (uniqueTargets.length === 0) {
      return {};
    }
    return this.translateBatch({
      sourceText: input.sourceText,
      sourceLanguage: input.sourceLanguage,
      targetLanguages: uniqueTargets,
    });
  }

  private async translateBatch(params: {
    sourceText: string;
    sourceLanguage: string;
    targetLanguages: string[];
  }): Promise<Record<string, string>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const sourceLang = describeLanguage(params.sourceLanguage);
      const targetLangList = params.targetLanguages.map((lang) => describeLanguage(lang));

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            {
              role: "system",
              content:
                "You are a realtime translation engine. Return strict JSON only.",
            },
            {
              role: "user",
              content: [
                `Source language: ${sourceLang}`,
                `Target languages: ${targetLangList.join(", ")}`,
                `Text: ${params.sourceText}`,
                "Return a JSON object whose keys are the exact target language codes and values are translated strings.",
                `Target codes: ${params.targetLanguages.join(", ")}`,
              ].join("\n"),
            },
          ],
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`openai translate failed (${response.status}): ${body.slice(0, 300)}`);
      }

      const payload = (await response.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };

      const textFromOutputText = String(payload.output_text ?? "").trim();
      const fallback = payload.output
        ?.flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join(" ")
        .trim();

      const raw = textFromOutputText || fallback || "";
      if (!raw) {
        throw new Error("openai translate returned empty content");
      }

      const parsed = this.tryParseJsonMap(raw);
      if (!parsed) {
        throw new Error(`openai translate returned invalid JSON: ${raw.slice(0, 300)}`);
      }

      const output: Record<string, string> = {};
      for (const code of params.targetLanguages) {
        const text = String(parsed[code] ?? "").trim();
        if (!text) {
          throw new Error(`missing translation for ${code}`);
        }
        output[code] = text;
      }
      return output;
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryParseJsonMap(raw: string): Record<string, string> | null {
    const candidate = raw
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, string>;
    } catch {
      return null;
    }
  }
}

export function createTranslatorFromEnv(): Translator {
  const provider = (process.env.CWCOMM_TRANSLATION_PROVIDER ?? "mock").toLowerCase();
  if (provider === "openai") {
    const apiKey = getApiKey(["CWCOMM_TRANSLATION_API_KEY", "OPENAI_API_KEY", "CWCOMM_API_KEY"]);
    if (!apiKey) {
      throw new Error("Translation API key is required (CWCOMM_TRANSLATION_API_KEY or OPENAI_API_KEY)");
    }
    const model = process.env.CWCOMM_OPENAI_MODEL ?? "gpt-4.1-mini";
    return new OpenAITranslator({
      apiKey,
      model,
      endpoint: process.env.CWCOMM_OPENAI_ENDPOINT,
    });
  }

  return new MockTranslator();
}
