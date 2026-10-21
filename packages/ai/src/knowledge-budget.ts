/**
 * Chooses which knowledge snippets go into a reply prompt. Keeps the best match,
 * then others whose relevance is close to it (a ratio of the top score, so it
 * works whatever the embedding model's score scale), within a character budget.
 * Weak matches add tokens and give the model irrelevant text to quote.
 */
export function selectKnowledge<T extends { content: string; score: number }>(hits: T[], opts: { relativeMin?: number; maxChars?: number } = {}): T[] {
  const relativeMin = opts.relativeMin ?? 0.75;
  const maxChars = opts.maxChars ?? 4800;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (!top) return [];
  const out: T[] = [top];
  let used = top.content.length;
  for (const hit of sorted.slice(1)) {
    if (top.score > 0 && hit.score < top.score * relativeMin) break;
    if (used + hit.content.length > maxChars) continue;
    out.push(hit);
    used += hit.content.length;
  }
  return out;
}
