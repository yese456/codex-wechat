/** Split long text into WeChat-friendly bubbles. Prefer paragraph / line breaks. */
export function splitText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars 必须是正整数");
  }
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;

  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut =
      lastIndexOfAny(window, ["\n\n", "\n", "。", "！", "？", ". ", "; ", " "]) ??
      maxChars;

    // Avoid tiny leftovers when cut is near the start
    if (cut < Math.floor(maxChars * 0.4)) {
      cut = maxChars;
    }

    const piece = rest.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function lastIndexOfAny(s: string, seps: string[]): number | null {
  let best = -1;
  for (const sep of seps) {
    const i = s.lastIndexOf(sep);
    if (i > best) best = i + (sep.length > 1 && sep.endsWith(" ") ? sep.length : 0);
    // For paragraph break, include the break point after \n\n
    if (sep === "\n\n" && i >= 0) best = Math.max(best, i + 2);
    if (sep === "\n" && i >= 0) best = Math.max(best, i + 1);
  }
  return best > 0 ? best : null;
}

export function clip(s: string, max: number): string {
  if (!Number.isInteger(max) || max < 1) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function shortId(id: string, n = 8): string {
  if (!id) return "-";
  return id.length <= n ? id : id.slice(0, n);
}
