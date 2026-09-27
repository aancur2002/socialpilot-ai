'use client';

import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { LeadsTable, NewLeadButton } from '@/components/crm';
import { Button, PageHeader, Panel } from '@/components/ui/primitives';
import { downloadFile, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function LeadsPage() {
  const { clientId } = useSession();
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadFile('/leads/export.csv', { clientId }, `leads-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <PageHeader
        title="Leads"
        description="Everyone who showed interest: from conversations, website forms, the lead API, or added by your team."
        actions={
          <>
            <Link href="/pipeline"><Button variant="secondary">Pipeline view</Button></Link>
            <Link href="/contacts"><Button variant="secondary">Contacts</Button></Link>
            <Link href="/lead-capture"><Button variant="secondary">Lead capture</Button></Link>
            <Button variant="secondary" loading={exporting} onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>
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
