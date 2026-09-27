import { Fragment, type ReactNode } from 'react';

/**
 * Renders the small Markdown subset used for legal pages: # headings, paragraphs,
 * "- " lists, **bold** and [links](https://…). Builds React elements (never raw
 * HTML), so pasted text can't inject scripts.
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${key}-b${i++}`}>{m[1]}</strong>);
    else out.push(<a key={`${key}-a${i++}`} href={m[3]} className="text-clearance underline" rel="noreferrer">{m[2]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function SimpleMarkdown({ source }: { source: string }) {
  // A heading line always starts its own block, even without a blank line after it.
  const blocks = source.replace(/\r\n/g, '\n').replace(/^(#{1,3}\s.*)$/gm, '\n$1\n').split(/\n{2,}/);
  return (
    <div className="space-y-4 leading-relaxed">
      {blocks.map((block, b) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (!lines.length) return null;
        const h = /^(#{1,3})\s+(.*)$/.exec(lines[0]!);
        if (h && lines.length === 1) {
          const level = h[1]!.length;
          const cls = level === 1 ? 'text-3xl font-semibold' : level === 2 ? 'pt-2 text-xl font-semibold' : 'text-lg font-semibold';
          const Tag = (`h${level}` as 'h1' | 'h2' | 'h3');
          return <Tag key={b} className={cls}>{inline(h[2]!, `h${b}`)}</Tag>;
        }
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return <ul key={b} className="list-disc space-y-1 pl-6">{lines.map((l, i) => <li key={i}>{inline(l.replace(/^\s*[-*]\s+/, ''), `l${b}-${i}`)}</li>)}</ul>;
        }
        return (
          <p key={b}>
            {lines.map((l, i) => (
              <Fragment key={i}>{i > 0 && <br />}{inline(l, `p${b}-${i}`)}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
