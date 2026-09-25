'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { InboxView } from '@/components/inbox';

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Suspense>
      <InboxView conversationId={id} />
    </Suspense>
  );
}
