'use client';

import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell';
import { SessionProvider } from '@/lib/session';

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status">
      <div className="w-64 space-y-2">
        <div className="strip strip-sky h-10 animate-pulse rounded-r-md bg-surface" />
        <div className="strip strip-clearance h-10 animate-pulse rounded-r-md bg-surface" />
        <div className="strip strip-runway h-10 animate-pulse rounded-r-md bg-surface" />
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider fallback={<Loading />}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
