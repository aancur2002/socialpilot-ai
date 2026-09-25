'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema } from '@socialpilot/validation';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Field, Input } from '@/components/ui/primitives';
import { api, errorMessage, setCurrentOrg } from '@/lib/api';

type Form = z.input<typeof registerSchema>;

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<{ organizationId: string | null }>('/auth/register', { body: values });
      if (res.organizationId) setCurrentOrg(res.organizationId);
      router.replace('/onboarding');
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <>
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-ink-2">You’ll set up your agency and first client next.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        <Field label="Your name" htmlFor="name" error={formState.errors.name?.message}>
          <Input id="name" autoComplete="name" {...register('name')} />
        </Field>
        <Field label="Work email" htmlFor="email" error={formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters" error={formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
        </Field>
        <Field label="Agency or company name" htmlFor="org" error={formState.errors.organizationName?.message}>
          <Input id="org" placeholder="e.g. Northside Digital" {...register('organizationName')} />
        </Field>
        {error && (
          <p role="alert" className="rounded-[var(--radius-control)] bg-alert-soft px-3 py-2 text-sm text-alert">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-sm text-ink-2">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-clearance hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
