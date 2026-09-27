'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, getCurrentOrg, setCurrentOrg } from './api';
import type { Client, CurrentOrg, Me } from './types';
import { BlockedScreen } from '@/components/billing';

interface SessionValue {
  me: Me;
  org: CurrentOrg;
  clients: Client[];
  can: (permission: string) => boolean;
  /** Client scope for the whole app: null = all clients the user can see */
  clientId: string | null;
  setClientId: (id: string | null) => void;
  switchOrg: (id: string) => void;
}

const SessionContext = createContext<SessionValue | null>(null);
const CLIENT_KEY = 'sp.clientScope';

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** Loads the user, their organization and visible clients; redirects to login/onboarding when needed. */
export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [orgReady, setOrgReady] = useState(false);
  const [clientId, setClientIdState] = useState<string | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace('/login');
  }, [me.error, router]);

  useEffect(() => {
    if (!me.data) return;
    const orgs = me.data.organizations;
    if (!orgs.length) {
      router.replace(me.data.user.isSuperAdmin ? '/platform-admin' : '/onboarding');
      return;
    }
    const current = getCurrentOrg();
    if (!current || !orgs.some((o) => o.id === current)) setCurrentOrg(orgs[0]!.id);
    try {
      setClientIdState(localStorage.getItem(CLIENT_KEY));
    } catch {
      setClientIdState(null);
    }
    setOrgReady(true);
  }, [me.data, router]);

  const org = useQuery({ queryKey: ['org'], queryFn: () => api<CurrentOrg>('/organizations/current'), enabled: orgReady });
  const blocked = org.data?.access.state === 'blocked';
  // A blocked organization can't load its data; only its billing page is reachable.
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api<Client[]>('/clients'), enabled: orgReady && Boolean(org.data) && !blocked });

  useEffect(() => {
    if (org.data?.onboardingStep === 'create_client' && clients.data && clients.data.length === 0) router.replace('/onboarding');
  }, [org.data, clients.data, router]);

  const setClientId = useCallback((id: string | null) => {
    setClientIdState(id);
    try {
      if (id) localStorage.setItem(CLIENT_KEY, id);
      else localStorage.removeItem(CLIENT_KEY);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  const switchOrg = useCallback(
    (id: string) => {
      setCurrentOrg(id);
      setClientId(null);
      qc.clear();
      window.location.assign('/dashboard');
    },
    [qc, setClientId],
  );

  const value = useMemo<SessionValue | null>(() => {
    if (!me.data || !org.data || !clients.data) return null;
    const perms = new Set(org.data.permissions);
    const validClient = clientId && clients.data.some((c) => c.id === clientId) ? clientId : null;
    return { me: me.data, org: org.data, clients: clients.data, can: (p) => perms.has(p), clientId: validClient, setClientId, switchOrg };
  }, [me.data, org.data, clients.data, clientId, setClientId, switchOrg]);

  if (me.data && org.data?.access.state === 'blocked') {
    const perms = new Set(org.data.permissions);
    return (
      <BlockedScreen
        orgName={org.data.name}
        access={org.data.access}
        canSeeBilling={perms.has('settings:manage')}
        otherOrgs={me.data.organizations.filter((o) => o.id !== org.data!.id).map((o) => ({ id: o.id, name: o.name, onSelect: () => switchOrg(o.id) }))}
        onSignOut={async () => {
          await api('/auth/logout', { body: {} }).catch(() => undefined);
          qc.clear();
          window.location.assign('/login');
        }}
      />
    );
  }
  if (!value) return <>{fallback}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
