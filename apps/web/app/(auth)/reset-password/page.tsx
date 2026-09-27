'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setToken(new URLSearchParams(window.location.search).get('token')), []);

  if (done) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Password changed</h1>
        <p className="mt-2 text-sm text-ink-2">You were signed out on every device. Sign in with your new password.</p>
        <Link href="/login" className="mt-6 inline-block font-medium text-clearance hover:underline">Sign in</Link>
      </>
    );
  }
  if (token === '') return <p className="text-sm text-alert">This link is incomplete. <Link href="/forgot-password" className="text-clearance hover:underline">Ask for a new one</Link>.</p>;
  const tooShort = password.length > 0 && password.length < 10;
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <>
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      <form
        className="mt-8 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/auth/reset-password', { body: { token, password } });
            setDone(true);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="New password" htmlFor="pw" hint="At least 10 characters." error={tooShort ? 'Use at least 10 characters' : undefined}><Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Repeat it" htmlFor="pw2" error={mismatch ? "The passwords don't match" : undefined}><Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        {error && <p className="text-sm text-alert" role="alert">{error} {/expired|invalid|used/i.test(error) && <Link href="/forgot-password" className="text-clearance hover:underline">Ask for a new link</Link>}</p>}
        <Button type="submit" className="w-full" loading={busy} disabled={!token || password.length < 10 || password !== confirm}>Change password</Button>
      </form>
    </>
  );
}
