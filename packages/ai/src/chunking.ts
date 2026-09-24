/** Rough token estimate (≈4 characters per token for English text). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
}

/**
 * Splits text into overlapping chunks on paragraph → sentence boundaries.
 * Defaults (~500 tokens, ~60 overlap) suit FAQ/product text for retrieval.
 */
export function chunkText(text: string, opts: { maxTokens?: number; overlapTokens?: number } = {}): Chunk[] {
  const maxChars = (opts.maxTokens ?? 500) * 4;
  const overlapChars = (opts.overlapTokens ?? 60) * 4;
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  const units: string[] = [];
  for (const para of normalized.split(/\n\n/)) {
    if (para.length <= maxChars) {
      units.push(para);
      continue;
    }
    const sentences = para.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (s.length <= maxChars) units.push(s);
      else for (let i = 0; i < s.length; i += maxChars) units.push(s.slice(i, i + maxChars));
    }
  }

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length + 2 > maxChars) {
      chunks.push(current);
      const tail = current.slice(-overlapChars);
      const boundary = tail.search(/\s/);
      current = (boundary >= 0 ? tail.slice(boundary + 1) : tail) + '\n\n' + unit;
      if (current.length > maxChars) current = unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((content, index) => ({ index, content, tokenCount: estimateTokens(content) }));
}

/** Strips HTML to readable text (for website knowledge sources). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
