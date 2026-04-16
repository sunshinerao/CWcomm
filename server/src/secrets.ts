function normalizeSecret(raw: string): string {
  let out = raw.trim().replace(/^\uFEFF/, "");
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["\u201c", "\u201d"],
    ["\u2018", "\u2019"],
  ];
  let changed = true;
  while (changed && out.length >= 2) {
    changed = false;
    for (const [left, right] of quotePairs) {
      if (out.startsWith(left) && out.endsWith(right)) {
        out = out.slice(left.length, out.length - right.length).trim();
        changed = true;
        break;
      }
    }
  }
  const trimQuoteEdges = /^[\s"'“”‘’]+|[\s"'“”‘’]+$/g;
  out = out.replace(trimQuoteEdges, "").trim();
  return out;
}

export function getApiKey(candidates: string[]): string | undefined {
  for (const key of candidates) {
    const value = process.env[key];
    if (value && value.trim()) {
      const normalized = normalizeSecret(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}
