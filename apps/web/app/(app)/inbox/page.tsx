'use client';

import { Suspense } from 'react';
import { InboxView } from '@/components/inbox';

export default function InboxPage() {
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
