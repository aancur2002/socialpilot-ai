'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@socialpilot/validation';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, Field, Input } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import type { Me } from '@/lib/types';

type Form = z.input<typeof loginSchema>;

export default function LoginPage() {
  const router = useRouter();
  const signup = useQuery({ queryKey: ['public-signup'], queryFn: () => api<{ allowPublicSignup: boolean }>('/public/signup') });
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState } = useForm<Form>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/login', { body: values });
      const me = await api<Me>('/auth/me');
      router.replace(me.organizations.length ? '/dashboard' : me.user.isSuperAdmin ? '/platform-admin' : '/onboarding');
    } catch (e) {
      setError(errorMessage(e));
    }
  });

  return (
    <>
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">Welcome back. Pick up where your team left off.</p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
        <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
        </Field>
        {error && (
          <p role="alert" className="rounded-[var(--radius-control)] bg-alert-soft px-3 py-2 text-sm text-alert">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Sign in
        </Button>
      </form>
      {signup.data?.allowPublicSignup !== false && (
        <p className="mt-6 text-sm text-ink-2">
          New to SocialPilot?{' '}
          <Link href="/register" className="font-medium text-clearance hover:underline">
            Create an account
          </Link>
        </p>
      )}
    </>
  );
}
