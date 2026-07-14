'use client';

// Active queue table with row actions + bulk select. Filter inputs live in a
// sibling component (QueueFilterBar) and flow through the URL — this table
// just renders what the server sent. Tier / attempt / voicemail columns and the
// move-to-top / reset / change-tier row actions live here.

import * as React from 'react';
import {
  ArrowUpToLine,
  Ban,
  CalendarClock,
  ChevronsLeft,
  ChevronsRight,
  Forward,
  Layers,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, maskPhone } from '@/lib/utils';
import { SEGMENT_LABEL } from '@/lib/config';
import { EmptyState } from '@/components/primitives/EmptyState';
import { RowActionMenu, type RowAction } from '@/components/primitives/RowActionMenu';
import { toast } from '@/components/primitives/Toaster';
import {
  bulkSetStatus,
  moveToTop,
  resetAttempts,
  setQueueStatus,
} from '@/lib/dialer/actions';
import type { QueueRow } from '@/lib/dialer/types';
import { CapReachedBadge, QueueStatusBadge, TierBadge } from './StatusBadges';
import { RescheduleDialog } from './RescheduleDialog';
import { ChangeTierDialog } from './ChangeTierDialog';
import { SortableHeader } from './SortableHeader';

const QS = { sortParam: 'qsort', ordParam: 'qord', pageParam: 'qpage' } as const;

type Props = {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  vmMaxLifetime: number;
};

function formatDt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

// Render an em-dash for missing / empty values so columns stay aligned.
function ctxText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export function ActiveQueueTable({ rows, total, page, pageSize, vmMaxLifetime }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [rawSelected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = React.useState(false);
  const [rescheduleId, setRescheduleId] = React.useState<string | null>(null);
  const [tierEditId, setTierEditId] = React.useState<string | null>(null);

  const setPage = (p: number) => {
    const sp = new URLSearchParams(params.toString());
    if (p <= 1) sp.delete('qpage');
    else sp.set('qpage', String(p));
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const selected = React.useMemo(() => {
    const ids = new Set(rows.map((r) => r.id));
    const out = new Set<string>();
    for (const id of rawSelected) if (ids.has(id)) out.add(id);
    return out;
  }, [rawSelected, rows]);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && selected.size < rows.length;

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  const runBulk = async (action: 'Removed' | 'DNC') => {
    if (selected.size === 0) return;
    setBulkPending(true);
    try {
      const res = await bulkSetStatus(Array.from(selected), action);
      if (res.ok) {
        toast.success(`${selected.size} row(s) marked ${action}`);
        setSelected(new Set());
        router.refresh();
      } else {
        toast.error(`Bulk action failed: ${res.error}`);
      }
    } finally {
      setBulkPending(false);
    }
  };

  const rescheduleRow = rows.find((r) => r.id === rescheduleId) ?? null;
  const tierRow = rows.find((r) => r.id === tierEditId) ?? null;

  if (total === 0) {
    return (
      <EmptyState
        title="Queue is empty"
        description="No contacts match these filters. Adjust filters or wait for the next sync."
      />
    );
  }

  return (
    <>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[--color-teal]/40 bg-[--color-teal]/10 px-4 py-2">
          <span className="text-xs text-ink-dim">
            <span className="font-semibold text-ink">{selected.size}</span> selected
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runBulk('Removed')}
              disabled={bulkPending}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runBulk('DNC')}
              disabled={bulkPending}
              className="text-[--color-danger] hover:text-[--color-danger]"
            >
              <Ban className="mr-1.5 h-3.5 w-3.5" /> DNC
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-[--color-panel-hi]/40 text-xs uppercase tracking-[--tracking-label] text-ink-mute">
              <tr>
                <Th className="w-8">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAll}
                    aria-label="Select all rows"
                  />
                </Th>
                <SortableHeader label="Priority" col="priority" {...QS} />
                <Th>Tier</Th>
                <SortableHeader label="Name" col="name" {...QS} />
                <Th>Phone</Th>
                <SortableHeader label="Status" col="status" {...QS} />
                <SortableHeader label="Attempts" col="attempts" {...QS} />
                <SortableHeader label="VM" col="vm" {...QS} />
                <Th>Source</Th>
                <Th>{SEGMENT_LABEL}</Th>
                <SortableHeader label="Last called" col="lastcalled" {...QS} />
                <SortableHeader label="Next attempt" col="nextattempt" {...QS} />
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isSelected = selected.has(r.id);
                const vmExhausted = vmMaxLifetime > 0 && r.vm_count >= vmMaxLifetime;
                const actions: RowAction[] = [
                  {
                    id: 'move-top',
                    label: 'Move to top',
                    icon: <ArrowUpToLine className="h-3.5 w-3.5" />,
                    onClick: async () => {
                      const res = await moveToTop(r.id);
                      if (res.ok) {
                        toast.success('Moved to top of queue');
                        router.refresh();
                      } else {
                        toast.error(`Move failed: ${res.error}`);
                      }
                    },
                  },
                  {
                    id: 'reschedule',
                    label: 'Reschedule',
                    icon: <CalendarClock className="h-3.5 w-3.5" />,
                    onClick: () => setRescheduleId(r.id),
                  },
                  {
                    id: 'change-tier',
                    label: 'Change tier',
                    icon: <Layers className="h-3.5 w-3.5" />,
                    onClick: () => setTierEditId(r.id),
                  },
                  {
                    id: 'reset',
                    label: 'Reset attempts',
                    icon: <RotateCcw className="h-3.5 w-3.5" />,
                    confirm: {
                      title: `Reset attempts for ${r.contact_name}?`,
                      description:
                        'Clears daily, monthly, lifetime, and voicemail counters and returns the lead to Pending (unless DNC / Removed).',
                    },
                    onClick: async () => {
                      const res = await resetAttempts(r.id);
                      if (res.ok) {
                        toast.success('Attempts reset');
                        router.refresh();
                      } else {
                        toast.error(`Reset failed: ${res.error}`);
                      }
                    },
                  },
                  {
                    id: 'skip',
                    label: 'Skip',
                    icon: <Forward className="h-3.5 w-3.5" />,
                    separator: true,
                    onClick: async () => {
                      const res = await setQueueStatus(r.id, 'Skipped');
                      if (res.ok) {
                        toast.success('Skipped');
                        router.refresh();
                      } else {
                        toast.error(`Skip failed: ${res.error}`);
                      }
                    },
                  },
                  {
                    id: 'remove',
                    label: 'Remove',
                    icon: <Trash2 className="h-3.5 w-3.5" />,
                    variant: 'destructive',
                    confirm: {
                      title: `Remove ${r.contact_name} from queue?`,
                      description: 'They will stop receiving outbound dials immediately.',
                    },
                    onClick: async () => {
                      const res = await setQueueStatus(r.id, 'Removed');
                      if (res.ok) {
                        toast.success('Removed');
                        router.refresh();
                      } else {
                        toast.error(`Remove failed: ${res.error}`);
                      }
                    },
                  },
                  {
                    id: 'dnc',
                    label: 'Mark DNC',
                    icon: <Ban className="h-3.5 w-3.5" />,
                    variant: 'destructive',
                    confirm: {
                      title: `Mark ${r.contact_name} as Do Not Call?`,
                      description: 'Removes them from all outbound queues.',
                    },
                    onClick: async () => {
                      const res = await setQueueStatus(r.id, 'DNC');
                      if (res.ok) {
                        toast.success('Marked DNC');
                        router.refresh();
                      } else {
                        toast.error(`DNC failed: ${res.error}`);
                      }
                    },
                  },
                ];
                return (
                  <tr
                    key={r.id}
                    className={cn(
                      'border-b border-line-soft transition-colors duration-100',
                      'hover:bg-[--color-panel-hi]/40',
                      isSelected && 'bg-[--color-panel-hi]/60',
                    )}
                  >
                    <Td>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleRow(r.id)}
                        aria-label={`Select ${r.contact_name}`}
                      />
                    </Td>
                    <Td>
                      <span className="inline-flex items-center rounded-md border border-line bg-[--color-panel-hi] px-2 py-0.5 font-mono text-xs tabular-nums text-ink-dim">
                        {r.priority_score}
                      </span>
                    </Td>
                    <Td>
                      <TierBadge tier={r.tier} />
                    </Td>
                    <Td className="font-medium text-ink">{r.contact_name}</Td>
                    <Td className="font-mono text-xs text-ink-dim">{maskPhone(r.phone_e164)}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        <QueueStatusBadge status={r.dialer_status} />
                        {r.exhausted && r.dialer_status !== 'DNC' && r.dialer_status !== 'Removed' && (
                          <CapReachedBadge kind="attempts" />
                        )}
                        {vmExhausted && !r.exhausted && <CapReachedBadge kind="vm" />}
                      </div>
                    </Td>
                    <Td>
                      <span
                        className="font-mono text-xs tabular-nums text-ink-dim"
                        title={`${r.daily_attempt_count} today / ${r.monthly_attempt_count} this month / ${r.total_attempt_count} total (max ${r.max_daily_attempts}/${r.max_monthly_attempts}/${r.max_total_attempts})`}
                      >
                        {r.daily_attempt_count}/{r.monthly_attempt_count}/{r.total_attempt_count}
                      </span>
                    </Td>
                    <Td className="font-mono text-xs tabular-nums text-ink-dim">
                      {r.vm_count}
                      {vmMaxLifetime > 0 && <span className="text-ink-mute">/{vmMaxLifetime}</span>}
                    </Td>
                    <Td className="text-ink-dim">{r.source}</Td>
                    <Td className="text-ink-dim">{ctxText(r.segment)}</Td>
                    <Td className="font-mono text-xs text-ink-mute">
                      {formatRelative(r.last_attempt_at)}
                    </Td>
                    <Td className="font-mono text-xs text-ink-mute">
                      {formatDt(r.next_attempt_at)}
                    </Td>
                    <Td className="text-right">
                      <RowActionMenu actions={actions} triggerVariant="kebab" />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-mute">
          Showing <span className="font-mono text-ink">{from}</span>–
          <span className="font-mono text-ink">{to}</span> of{' '}
          <span className="font-mono text-ink">{total}</span>
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage(1)}
            disabled={page <= 1}
            className="h-8 w-8 p-0"
            aria-label="First page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="h-8 px-3"
          >
            Prev
          </Button>
          <span className="font-mono text-xs text-ink-dim">
            {page} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="h-8 px-3"
          >
            Next
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPage(totalPages)}
            disabled={page >= totalPages}
            className="h-8 w-8 p-0"
            aria-label="Last page"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <RescheduleDialog
        open={rescheduleId !== null}
        onOpenChange={(o) => {
          if (!o) setRescheduleId(null);
        }}
        queueId={rescheduleId}
        contactName={rescheduleRow?.contact_name ?? null}
      />

      <ChangeTierDialog
        open={tierEditId !== null}
        onOpenChange={(o) => {
          if (!o) setTierEditId(null);
        }}
        queueId={tierEditId}
        contactName={tierRow?.contact_name ?? null}
        currentTier={tierRow?.tier ?? null}
      />
    </>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn('whitespace-nowrap px-3 py-2.5 text-left font-medium', className)}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn('whitespace-nowrap px-3 py-2.5', className)}>{children}</td>
  );
}
