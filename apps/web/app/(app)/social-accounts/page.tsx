'use client';

import { ClientSelect } from '@/components/client-select';
import { Suspense } from 'react';
import { SocialAccountsPanel } from '@/components/social';
import { EmptyState, PageHeader, Panel } from '@/components/ui/primitives';
import { useSession } from '@/lib/session';

function Accounts() {
  const { clientId, setClientId } = useSession();
  return (
    <>
      <PageHeader
        title="Social accounts"
        description="Connections are per client. Pick a client to manage its accounts."
        actions={
          <ClientSelect aria-label="Client" className="w-64" value={clientId} onChange={setClientId} />
        }
      />
      {clientId ? <SocialAccountsPanel clientId={clientId} /> : <Panel><EmptyState title="Choose a client" description="Use the selector above or the client switcher in the sidebar." /></Panel>}
    </>
  );
}

export default function SocialAccountsPage() {
  return (
    <Suspense>
      <Accounts />
    </Suspense>
  );
}
