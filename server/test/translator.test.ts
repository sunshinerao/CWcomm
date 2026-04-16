import { describe, expect, it } from "vitest";
import { resolveLanguageLabel } from "../src/translator.js";

describe("translator language label", () => {
  it("resolves known full language tags", () => {
    expect(resolveLanguageLabel("zh-CN")).toBe("Chinese (Simplified)");
    expect(resolveLanguageLabel("en-US")).toBe("English (US)");
    expect(resolveLanguageLabel("ja-JP")).toBe("Japanese");
  });

  it("falls back to base language code", () => {
    expect(resolveLanguageLabel("en-AU")).toBe("English");
    expect(resolveLanguageLabel("fr-CA")).toBe("French");
  });

  it("returns normalized code for unknown language", () => {
    expect(resolveLanguageLabel("xx-YY")).toBe("xx-yy");
  });
});
