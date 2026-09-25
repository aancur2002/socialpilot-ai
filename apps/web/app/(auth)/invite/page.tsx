'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { api, errorMessage, setCurrentOrg } from '@/lib/api';

function AcceptInvite() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ organizationId: string }>('/invitations/accept', { body: { token, ...(name ? { name } : {}), ...(password ? { password } : {}) } });
      setCurrentOrg(res.organizationId);
      router.replace('/dashboard');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <p className="text-sm text-alert">This invitation link is incomplete. Ask your admin to send it again.</p>;
  return (
    <>
      <h1 className="text-2xl font-semibold">Join your team</h1>
      <p className="mt-1 text-sm text-ink-2">If you already have an account, sign in first and open this link again. Otherwise create your login below.</p>
      <div className="mt-8 space-y-4">
        <Field label="Your name" htmlFor="name">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters">
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="rounded-[var(--radius-control)] bg-alert-soft px-3 py-2 text-sm text-alert">{error}</p>}
        <Button className="w-full" loading={busy} onClick={accept}>
          Accept invitation
        </Button>
      </div>
    </>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <AcceptInvite />
    </Suspense>
  );
}
