import { describe, expect, it } from 'vitest';
import { selectKnowledge } from './knowledge-budget';

const hit = (id: string, score: number, len = 100) => ({ id, score, content: 'x'.repeat(len) });

describe('selectKnowledge', () => {
  it('keeps matches close to the best one and drops weak ones', () => {
    expect(selectKnowledge([hit('b', 0.5), hit('a', 0.62), hit('c', 0.4), hit('d', 0.47)]).map((h) => h.id)).toEqual(['a', 'b', 'd']);
  });
  it('always keeps the best match, even if it alone exceeds the budget', () => {
    expect(selectKnowledge([hit('a', 0.9, 6000), hit('b', 0.89)], { maxChars: 4800 }).map((h) => h.id)).toEqual(['a']);
  });
  it('stays within the character budget', () => {
    const picked = selectKnowledge([hit('a', 0.9, 2000), hit('b', 0.88, 2000), hit('c', 0.87, 2000), hit('d', 0.86, 500)], { maxChars: 4800 });
    expect(picked.map((h) => h.id)).toEqual(['a', 'b', 'd']);
  });
  it('handles no hits and non-positive scores', () => {
    expect(selectKnowledge([])).toEqual([]);
    expect(selectKnowledge([hit('a', 0), hit('b', -0.1)]).map((h) => h.id)).toEqual(['a', 'b']);
  });
});
