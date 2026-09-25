'use client';

import { ClientSelect } from './client-select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  CalendarDays,
  CheckCircle2,
  Building2,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Notification, Paged } from '@/lib/types';
import { ago } from './domain';
import { DropdownMenu } from './ui/overlay';
import { Button, cn } from './ui/primitives';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Inbox;
  permission?: string;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Work',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/inbox', label: 'Inbox', icon: Inbox, permission: 'messages:view' },
      { href: '/approvals', label: 'Approvals', icon: CheckCircle2, permission: 'content:view' },
      { href: '/content', label: 'Content', icon: FileText, permission: 'content:view' },
      { href: '/content/new', label: 'AI content', icon: Sparkles, permission: 'content:create' },
      { href: '/calendar', label: 'Calendar', icon: CalendarDays, permission: 'content:view' },
      { href: '/leads', label: 'Leads', icon: Users, permission: 'leads:view' },
      { href: '/analytics', label: 'Analytics', icon: BarChart3, permission: 'analytics:view' },
    ],
  },
  {
    group: 'Setup',
    items: [
      { href: '/clients', label: 'Clients', icon: Building2, permission: 'clients:view' },
      { href: '/social-accounts', label: 'Social accounts', icon: Share2, permission: 'social_accounts:view' },
      { href: '/knowledge', label: 'Knowledge base', icon: BookOpen, permission: 'knowledge:view' },
      { href: '/automation', label: 'Automation', icon: Workflow, permission: 'automation:view' },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can, clientId, setClientId, me, org } = useSession();
  const counts = useQuery({ queryKey: ['dashboard', clientId], queryFn: () => api<{ unreadMessages: number | null; pendingApprovals: number | null }>('/dashboard', { query: { clientId } }), refetchInterval: 30_000 });
  const badge: Record<string, number | null | undefined> = { '/inbox': counts.data?.unreadMessages, '/approvals': counts.data?.pendingApprovals };

  return (
    <div className="flex h-full flex-col bg-rail text-rail-ink">
      <div className="px-4 pb-3 pt-5">
        <Link href="/dashboard" className="text-[17px] font-semibold text-white" onClick={onNavigate}>
          SocialPilot
        </Link>
        <p className="mt-0.5 truncate text-xs">{org.name}</p>
      </div>
      <div className="px-3 pb-3">
        <ClientSelect id="client-scope" aria-label="Client" variant="rail" value={clientId} onChange={setClientId} allLabel="All clients" />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
        {NAV.map((section) => (
          <div key={section.group} className="mb-4">
            <p className="px-3 pb-1 text-xs text-rail-ink/70">{section.group}</p>
            {section.items
              .filter((i) => !i.permission || can(i.permission))
              .map((item) => {
                const active = item.href === '/content' ? pathname === '/content' || (pathname.startsWith('/content/') && pathname !== '/content/new') : pathname.startsWith(item.href);
                const count = badge[item.href];
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn('flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-1.5 text-sm transition-colors', active ? 'bg-rail-active text-white' : 'hover:bg-rail-active/60 hover:text-white')}
                  >
                    <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                    <span className="flex-1">{item.label}</span>
                    {count ? <span className="rounded-full bg-runway px-1.5 text-[11px] font-semibold text-[#1f1605]">{count}</span> : null}
                  </Link>
                );
              })}
          </div>
        ))}
        {me.user.isSuperAdmin && (
          <Link href="/admin" onClick={onNavigate} className={cn('flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-1.5 text-sm', pathname.startsWith('/admin') ? 'bg-rail-active text-white' : 'hover:bg-rail-active/60 hover:text-white')}>
            <ShieldCheck className="h-4 w-4" aria-hidden /> Platform admin
          </Link>
        )}
      </nav>
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<Paged<Notification> & { unread: number }>('/notifications', { query: { limit: 15 } }), refetchInterval: 30_000 });
  const markAll = useMutation({ mutationFn: () => api('/notifications/read', { body: { ids: 'all' } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <div className="relative">
      <Button variant="ghost" size="icon" aria-label={`Notifications${q.data?.unread ? `, ${q.data.unread} unread` : ''}`} onClick={() => setOpen((o) => !o)}>
        <Bell className="h-4 w-4" />
        {q.data?.unread ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-runway" /> : null}
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(380px,calc(100vw-32px))] rounded-[var(--radius-panel)] border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {q.data?.unread ? (
              <button className="text-xs text-clearance hover:underline" onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {q.data?.items.length ? (
              q.data.items.map((n) => (
                <li key={n.id}>
                  <button
                    className={cn('block w-full border-b border-line px-4 py-3 text-left hover:bg-surface-2', !n.readAt && 'bg-sky-soft/40')}
                    onClick={() => {
                      setOpen(false);
                      api('/notifications/read', { body: { ids: [n.id] } }).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
                      if (n.link) router.push(n.link);
                    }}
                  >
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{n.body}</p>}
                    <p className="mt-1 text-xs text-ink-3">{ago(n.createdAt)}</p>
                  </button>
                </li>
              ))
            ) : (
              <li className="px-4 py-8 text-center text-sm text-ink-3">You’re all caught up.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, org, switchOrg } = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [mobileNav, setMobileNav] = useState(false);
  const router = useRouter();

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-screen lg:block">
        <Sidebar />
      </aside>
      {mobileNav && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[#0d1524]/50" onClick={() => setMobileNav(false)} />
          <div className="absolute inset-y-0 left-0 w-72">
            <button className="absolute right-3 top-4 z-10 text-rail-ink" aria-label="Close menu" onClick={() => setMobileNav(false)}>
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </div>
        </div>
      )}
      <div className="min-w-0" style={{ ['--banner-h' as string]: org.mockMode ? '28px' : '0px' }}>
        {org.mockMode && (
          <div className="flex h-7 items-center gap-2 overflow-hidden bg-runway-soft px-4 text-xs text-[#6b4608] dark:text-runway" role="status">
            <Bot className="h-3.5 w-3.5" aria-hidden />
            <span className="truncate">Mock mode is on: mock accounts simulate platforms and nothing is sent to real social networks.</span>
          </div>
        )}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-paper/90 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu" onClick={() => setMobileNav(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex-1" />
          <Notifications />
          <Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
            {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <DropdownMenu
            trigger={
              <button className="flex items-center gap-2 rounded-full pl-1 pr-2 text-sm hover:bg-surface-2" aria-label="Account menu">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-clearance-soft text-xs font-semibold text-clearance">{me.user.name.slice(0, 1).toUpperCase()}</span>
                <span className="hidden sm:inline">{me.user.name}</span>
              </button>
            }
            items={[
              ...me.organizations.filter((o) => o.id !== org.id).map((o) => ({ label: `Switch to ${o.name}`, onSelect: () => switchOrg(o.id) })),
              ...(me.organizations.length > 1 ? (['separator'] as const) : []),
              { label: 'Settings', onSelect: () => router.push('/settings') },
              {
                label: (
                  <>
                    <LogOut className="h-4 w-4" /> Sign out
                  </>
                ),
                onSelect: async () => {
                  await api('/auth/logout', { body: {} }).catch(() => undefined);
                  window.location.assign('/login');
                },
              },
            ]}
          />
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
