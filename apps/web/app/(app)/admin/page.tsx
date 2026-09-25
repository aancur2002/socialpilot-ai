'use client';

import { AdminConsole } from '@/components/admin-console';
import { useSession } from '@/lib/session';

export default function AdminPage() {
  const { me } = useSession();
  return <AdminConsole enabled={me.user.isSuperAdmin} />;
}
