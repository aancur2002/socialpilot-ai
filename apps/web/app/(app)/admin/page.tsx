'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AdminConsole } from '@/components/admin-console';
import { useSession } from '@/lib/session';

function Admin() {
  const { me } = useSession();
  const tab = useSearchParams().get('tab') === 'integrations' ? 'integrations' : 'overview';
  return <AdminConsole enabled={me.user.isSuperAdmin} initialTab={tab} />;
}

export default function AdminPage() {
  return (
    <Suspense>
      <Admin />
    </Suspense>
  );
}
