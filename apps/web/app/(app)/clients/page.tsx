'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { TimezoneSelect, browserTimezone } from '@/components/timezone-select';
import { Modal } from '@/components/ui/overlay';
import { Button, EmptyState, Field, Input, PageHeader, Panel } from '@/components/ui/primitives';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Client } from '@/lib/types';

export default function ClientsPage() {
  const { clients, can, setClientId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const create = useMutation({
    mutationFn: () => api<Client>('/clients', { body: { name, timezone } }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      toast.success('Client created');
      router.push(`/clients/${c.id}?tab=brand`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="Clients" description="Each client has its own accounts, content, inbox, knowledge and settings." actions={can('clients:create') && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add client</Button>} />
      <Panel>
        {clients.length === 0 && <EmptyState icon={<Building2 className="h-8 w-8" />} title="No clients yet" description="Add the first brand you manage." />}
        <ul className="divide-y divide-line">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                <p className="text-xs text-ink-3">{c.brandProfile?.industry ?? 'Industry not set'}, {c.timezone}</p>
              </div>
              <dl className="flex gap-6 text-xs text-ink-2">
                <div><dt className="text-ink-3">Accounts</dt><dd className="tabular-nums">{c._count?.socialAccounts ?? 0}</dd></div>
                <div><dt className="text-ink-3">Posts</dt><dd className="tabular-nums">{c._count?.contents ?? 0}</dd></div>
                <div><dt className="text-ink-3">Leads</dt><dd className="tabular-nums">{c._count?.leads ?? 0}</dd></div>
              </dl>
              <Button size="sm" variant="secondary" onClick={() => { setClientId(c.id); router.push('/dashboard'); }}>Focus on this client</Button>
            </li>
          ))}
        </ul>
      </Panel>
      <Modal open={open} onOpenChange={setOpen} title="Add client" footer={<Button loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create client</Button>}>
        <div className="space-y-4">
          <Field label="Client or brand name" htmlFor="c-name"><Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Timezone" htmlFor="c-tz" hint="Used for scheduling and business hours"><TimezoneSelect id="c-tz" value={timezone} onChange={setTimezone} /></Field>
        </div>
      </Modal>
    </>
  );
}
