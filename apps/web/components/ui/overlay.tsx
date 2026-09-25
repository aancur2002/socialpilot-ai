'use client';

import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, cn } from './primitives';

export function Modal({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#0d1524]/50" />
        <Dialog.Content className={cn('fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-surface shadow-xl', wide ? 'max-w-2xl' : 'max-w-lg')}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <Dialog.Title className="font-semibold">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-0.5 text-sm text-ink-2">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="rounded p-1 text-ink-3 hover:bg-surface-2" aria-label="Close">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Right-hand drawer for detail views. */
export function Drawer({ open, onOpenChange, title, children, wide, footer }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#0d1524]/40" />
        <Dialog.Content aria-describedby={undefined} className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-xl', wide ? 'max-w-2xl' : 'max-w-md')}>
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-ink-3 hover:bg-surface-2" aria-label="Close">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirmation for destructive or outward-facing actions. */
export function ConfirmButton({ children, title, description, confirmLabel, onConfirm, variant = 'danger', size = 'sm' }: { children: ReactNode; title: string; description: string; confirmLabel: string; onConfirm: () => Promise<unknown> | void; variant?: 'danger' | 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={variant === 'danger' ? 'secondary' : variant} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={title}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={variant === 'danger' ? 'danger' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">{description}</p>
      </Modal>
    </>
  );
}

export function DropdownMenu({ trigger, items, align = 'end' }: { trigger: ReactNode; items: ({ label: ReactNode; onSelect: () => void; danger?: boolean } | 'separator')[]; align?: 'start' | 'end' }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-[var(--radius-panel)] border border-line bg-surface p-1 shadow-lg">
          {items.map((it, i) =>
            it === 'separator' ? (
              <Menu.Separator key={i} className="my-1 h-px bg-line" />
            ) : (
              <Menu.Item key={i} onSelect={it.onSelect} className={cn('flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2', it.danger && 'text-alert')}>
                {it.label}
              </Menu.Item>
            ),
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
