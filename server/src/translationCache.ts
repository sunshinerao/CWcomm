export type TranslationCacheKeyInput = {
  sourceText: string;
  sourceLanguage: string;
  targetLanguages: string[];
};

export class TranslationCache {
  private readonly ttlMs: number;
  private readonly store = new Map<string, { expiresAt: number; value: Record<string, string> }>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  makeKey(input: TranslationCacheKeyInput): string {
    const langs = [...new Set(input.targetLanguages.map((x) => x.trim()))].sort().join(",");
    return `${input.sourceLanguage.trim()}|${langs}|${input.sourceText.trim()}`;
  }

  get(key: string): Record<string, string> | null {
    const row = this.store.get(key);
    if (!row) {
      return null;
    }
    if (row.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return row.value;
  }

  set(key: string, value: Record<string, string>): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, row] of this.store.entries()) {
      if (row.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
