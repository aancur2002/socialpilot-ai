'use client';

import Link from 'next/link';
import { NewLeadButton, Pipeline } from '@/components/crm';
import { Button, PageHeader } from '@/components/ui/primitives';

export default function PipelinePage() {
  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Drag a lead to move it to the next stage."
        actions={
          <>
            <Link href="/leads"><Button variant="secondary">List view</Button></Link>
            <NewLeadButton />
          </>
        }
      />
      <Pipeline />
    </>
  );
}
