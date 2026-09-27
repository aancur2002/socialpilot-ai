'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-ink-2">If an account uses {email}, we sent a link to reset its password. It works once and expires in 1 hour. Check your spam folder if it doesn&apos;t arrive in a few minutes.</p>
        <Link href="/login" className="mt-6 inline-block font-medium text-clearance hover:underline">Back to sign in</Link>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <p className="mt-1 text-sm text-ink-2">Enter your account email and we&apos;ll send you a reset link.</p>
      <form
        className="mt-8 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/auth/forgot-password', { body: { email } });
            setSent(true);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {error && <p className="text-sm text-alert" role="alert">{error}</p>}
        <Button type="submit" className="w-full" loading={busy} disabled={!email}>Send reset link</Button>
      </form>
      <Link href="/login" className="mt-6 inline-block text-sm text-clearance hover:underline">Back to sign in</Link>
    </>
  );
}
