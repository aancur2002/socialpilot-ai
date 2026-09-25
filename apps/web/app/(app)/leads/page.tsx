'use client';

import Link from 'next/link';
import { LeadsTable, NewLeadButton } from '@/components/crm';
import { Button, PageHeader, Panel } from '@/components/ui/primitives';

export default function LeadsPage() {
  return (
    <>
      <PageHeader
        title="Leads"
        description="People who showed buying intent, detected from conversations or added by your team."
        actions={
          <>
            <Link href="/pipeline"><Button variant="secondary">Pipeline view</Button></Link>
            <Link href="/contacts"><Button variant="secondary">Contacts</Button></Link>
            <NewLeadButton />
          </>
        }
      />
      <Panel>
        <LeadsTable />
      </Panel>
    </>
  );
}
