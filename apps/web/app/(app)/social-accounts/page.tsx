'use client';

import { Suspense } from 'react';
import { SocialAccountsPanel } from '@/components/social';
import { EmptyState, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { useSession } from '@/lib/session';

function Accounts() {
  const { clientId, clients, setClientId } = useSession();
  return (
    <>
      <PageHeader
        title="Social accounts"
        description="Connections are per client. Pick a client to manage its accounts."
        actions={
          <Select aria-label="Client" className="w-64" value={clientId ?? ''} onChange={(e) => setClientId(e.target.value || null)}>
            <option value="">Choose a client</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
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
