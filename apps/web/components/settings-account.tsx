'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { changePasswordSchema } from '@socialpilot/validation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Field, Input, Panel, PanelHeader } from './ui/primitives';

const passwordForm = changePasswordSchema.and(z.object({ confirmPassword: z.string() })).refine((v) => v.newPassword === v.confirmPassword, { message: 'The passwords don’t match', path: ['confirmPassword'] });
type PasswordForm = z.input<typeof passwordForm>;

function ProfileForm() {
  const { me } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const save = useMutation({
    mutationFn: () => api('/auth/me', { method: 'PATCH', body: { name } }),
    onSuccess: () => {
      toast.success('Profile saved');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Panel>
      <PanelHeader title="Profile" actions={<Button disabled={!name.trim() || name === me.user.name} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      <div className="space-y-4 p-5">
        <Field label="Name" htmlFor="p-name"><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
        <Field label="Email" htmlFor="p-email" hint="Your sign-in email can’t be changed here."><Input id="p-email" value={me.user.email} disabled /></Field>
      </div>
    </Panel>
  );
}

function PasswordFormPanel() {
  const { register, handleSubmit, formState, reset, setError } = useForm<PasswordForm>({ resolver: zodResolver(passwordForm) });
  const onSubmit = handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      const res = await api<{ otherSessionsSignedOut: number }>('/auth/password', { body: { currentPassword, newPassword } });
      reset();
      toast.success(res.otherSessionsSignedOut ? `Password changed. Signed out ${res.otherSessionsSignedOut} other session${res.otherSessionsSignedOut === 1 ? '' : 's'}.` : 'Password changed');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION_ERROR' && Array.isArray(e.details)) {
        for (const d of e.details as { path: string; message: string }[]) {
          if (d.path === 'currentPassword' || d.path === 'newPassword') setError(d.path, { message: d.message });
        }
      }
      toast.error(errorMessage(e));
    }
  });
  return (
    <Panel>
      <PanelHeader title="Change password" description="You stay signed in here; every other device is signed out." />
      <form className="space-y-4 p-5" onSubmit={onSubmit} noValidate>
        <Field label="Current password" htmlFor="pw-current" error={formState.errors.currentPassword?.message}>
          <Input id="pw-current" type="password" autoComplete="current-password" {...register('currentPassword')} />
        </Field>
        <Field label="New password" htmlFor="pw-new" hint="At least 10 characters" error={formState.errors.newPassword?.message}>
          <Input id="pw-new" type="password" autoComplete="new-password" {...register('newPassword')} />
        </Field>
        <Field label="Confirm new password" htmlFor="pw-confirm" error={formState.errors.confirmPassword?.message}>
          <Input id="pw-confirm" type="password" autoComplete="new-password" {...register('confirmPassword')} />
        </Field>
        <Button type="submit" loading={formState.isSubmitting}>Change password</Button>
      </form>
    </Panel>
  );
}

export function AccountSettings() {
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <ProfileForm />
      <PasswordFormPanel />
    </div>
  );
}
