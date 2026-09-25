'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { AdminConsole } from '@/components/admin-console';
import { Button } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

/** Standalone console for platform super admins who don't belong to any organization. */
function PlatformAdmin() {
  const router = useRouter();
  const tab = useSearchParams().get('tab') === 'integrations' ? 'integrations' : 'overview';
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });
  useEffect(() => {
    if (me.error) router.replace('/login');
  }, [me.error, router]);
  if (!me.data) return null;
  return (
    <div className="min-h-screen bg-paper">
      <header className="flex h-14 items-center justify-between border-b border-line bg-rail px-6 text-white">
        <span className="font-semibold">SocialPilot platform admin</span>
        <Button variant="ghost" size="sm" className="text-rail-ink hover:text-white" onClick={async () => { await api('/auth/logout', { body: {} }).catch(() => undefined); window.location.assign('/login'); }}>
          Sign out
        </Button>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <AdminConsole enabled={me.data.user.isSuperAdmin} initialTab={tab} />
      </main>
    </div>
  );
}

export default function PlatformAdminPage() {
  return (
    <Suspense>
      <PlatformAdmin />
    </Suspense>
  );
}
