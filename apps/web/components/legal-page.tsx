'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { SimpleMarkdown } from './simple-markdown';
import { ErrorState, Skeleton } from './ui/primitives';
import { api } from '@/lib/api';

interface Legal { productName: string; updatedOn: string | null; terms: string; privacy: string }

/** Public Terms or Privacy page; the text comes from Platform admin → Company & legal. */
export function LegalPage({ doc }: { doc: 'terms' | 'privacy' }) {
  const q = useQuery({ queryKey: ['public-legal'], queryFn: () => api<Legal>('/public/legal') });
  return (
    <main className="min-h-screen bg-paper px-4 py-10">
      <article className="mx-auto max-w-3xl rounded-[var(--radius-panel)] border border-line bg-surface p-6 sm:p-10">
        {q.isLoading ? <Skeleton className="h-96" /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <>
            {q.data!.updatedOn && <p className="mb-4 text-sm text-ink-3">Last updated {new Date(`${q.data!.updatedOn}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'long' })}</p>}
            <SimpleMarkdown source={q.data![doc]} />
          </>
        )}
        <nav className="mt-10 flex flex-wrap gap-4 border-t border-line pt-6 text-sm">
          <Link href={doc === 'terms' ? '/privacy' : '/terms'} className="text-clearance hover:underline">{doc === 'terms' ? 'Privacy Policy' : 'Terms of Service'}</Link>
          <Link href="/login" className="text-clearance hover:underline">Sign in</Link>
        </nav>
      </article>
    </main>
  );
}
