'use client';

// Call history table. Row click expands an inline detail panel with the full
// transcript, summary, audio player, transfer outcome, and DNC flag.
// Pagination via URL ?page= and CSV export builds from the current page's rows
// (server already paged them). Columns: direction, phone, sentiment emoji, and
// the inbound CALLBACK badge.

import * as React from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/primitives/EmptyState';
import { cn, maskPhone } from '@/lib/utils';
import type { CallHistoryRow } from '@/lib/dialer/types';
import { BantChip } from './StatusBadges';
import { SortableHeader } from './SortableHeader';

const HS = { sortParam: 'hsort', ordParam: 'hord', pageParam: 'page' } as const;

type Props = {
  rows: CallHistoryRow[];
  total: number;
  page: number;
  pageSize: number;
};

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCost(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
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

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: '🙂',
  neutral: '😐',
  negative: '🙁',
};

function isInbound(direction: string): boolean {
  return direction.toLowerCase() === 'inbound';
}

function toCsv(rows: CallHistoryRow[]): string {
  const header = [
    'date',
    'name',
    'direction',
    'from_number',
    'to_number',
    'duration_seconds',
    'cost_usd',
    'bant_score',
    'disposition',
    'sentiment',
    'transferred_to_agent',
    'transfer_outcome',
    'dnc_flagged',
    'recording_url',
    'provider_call_id',
  ];
  const escape = (v: unknown): string => {
    if (v == null) return '';
    const s = String(v);
    if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.created_at,
        r.contact_name ?? '',
        r.call_direction,
        r.from_number ?? '',
        r.to_number,
        r.duration_seconds ?? '',
        r.cost_cents != null ? (r.cost_cents / 100).toFixed(2) : '',
        r.bant_score ?? '',
        r.disposition ?? '',
        r.sentiment ?? '',
        r.transferred_to_agent ?? '',
        r.transfer_outcome ?? '',
        r.dnc_flagged,
        r.recording_url ?? '',
        r.provider_call_id,
      ]
        .map(escape)
        .join(','),
    );
  }
  return lines.join('\n');
}

function downloadCsv(rows: CallHistoryRow[]) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `call-history-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function CallHistoryTable({ rows, total, page, pageSize }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const setPage = (p: number) => {
    const sp = new URLSearchParams(params.toString());
    if (p <= 1) sp.delete('page');
    else sp.set('page', String(p));
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No call history yet"
        description="Once the dialer makes calls, they'll appear here with transcripts and BANT scores."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-mute">
          Showing <span className="font-mono text-ink">{from}</span>–
          <span className="font-mono text-ink">{to}</span> of{' '}
          <span className="font-mono text-ink">{total}</span>
        </p>
        <Button size="sm" variant="outline" onClick={() => downloadCsv(rows)} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-line">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-[--color-panel-hi]/40 text-xs uppercase tracking-[--tracking-label] text-ink-mute">
              <tr>
                <Th className="w-8" />
                <Th>Name</Th>
                <Th>Phone</Th>
                <SortableHeader label="Direction" col="direction" {...HS} />
                <SortableHeader label="Duration" col="duration" {...HS} />
                <SortableHeader label="BANT" col="bant" {...HS} />
                <SortableHeader label="Disposition" col="disposition" {...HS} />
                <SortableHeader label="Sentiment" col="sentiment" {...HS} />
                <SortableHeader label="Cost" col="cost" {...HS} />
                <SortableHeader label="Date" col="date" {...HS} />
                <SortableHeader label="Recording" col="recording" {...HS} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = expanded === r.id;
                const inbound = isInbound(r.call_direction);
                return (
                  <React.Fragment key={r.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : r.id)}
                      className={cn(
                        'cursor-pointer border-b border-line-soft transition-colors duration-100',
                        'hover:bg-[--color-panel-hi]/40',
                        isOpen && 'bg-[--color-panel-hi]/60',
                      )}
                      tabIndex={0}
                      role="button"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpanded(isOpen ? null : r.id);
                        }
                      }}
                    >
                      <Td className="text-ink-mute">
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </Td>
                      <Td className="font-medium text-ink">{r.contact_name ?? '—'}</Td>
                      <Td className="font-mono text-xs text-ink-dim">
                        {maskPhone(inbound ? r.from_number : r.to_number)}
                      </Td>
                      <Td>
                        <DirectionCell inbound={inbound} />
                      </Td>
                      <Td className="font-mono tabular-nums text-ink-dim">
                        {formatDuration(r.duration_seconds)}
                      </Td>
                      <Td>
                        <BantChip score={r.bant_score} />
                      </Td>
                      <Td className="text-ink-dim">{r.disposition ?? '—'}</Td>
                      <Td>
                        <SentimentEmoji sentiment={r.sentiment} />
                      </Td>
                      <Td className="font-mono tabular-nums text-ink-dim">
                        {formatCost(r.cost_cents)}
                      </Td>
                      <Td className="font-mono text-xs text-ink-mute">{formatDate(r.created_at)}</Td>
                      <Td>
                        {r.recording_url ? (
                          <a
                            href={r.recording_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-[--color-teal] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-ring]"
                          >
                            Open
                          </a>
                        ) : (
                          <span className="text-ink-mute">—</span>
                        )}
                      </Td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line-soft bg-[--color-panel-hi]/30">
                        <td colSpan={11} className="px-4 py-4">
                          <CallDetail row={r} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
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
  );
}

function DirectionCell({ inbound }: { inbound: boolean }) {
  if (inbound) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <PhoneIncoming className="h-3.5 w-3.5 text-[--color-teal]" aria-hidden />
        <span className="inline-flex items-center rounded-md border border-[--color-teal]/40 bg-[--color-teal]/15 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-[--tracking-label] text-[--color-teal]">
          Callback
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-dim">
      <PhoneOutgoing className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
      Outbound
    </span>
  );
}

function SentimentEmoji({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return <span className="text-ink-mute">—</span>;
  const key = sentiment.toLowerCase();
  const emoji = SENTIMENT_EMOJI[key];
  if (!emoji) return <span className="text-xs text-ink-dim">{sentiment}</span>;
  return (
    <span className="text-base" title={sentiment} role="img" aria-label={sentiment}>
      {emoji}
    </span>
  );
}

function bantLabel(score: number | null): string {
  if (score == null) return 'Not scored';
  if (score >= 70) return 'Hot — strong fit';
  if (score >= 40) return 'Warm — partial fit';
  return 'Cold — weak fit';
}

function CallDetail({ row }: { row: CallHistoryRow }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-1">
        <DetailField label="Summary">
          {row.call_summary ? (
            <p className="whitespace-pre-wrap text-sm text-ink-dim">{row.call_summary}</p>
          ) : (
            <p className="text-sm text-ink-mute">No summary recorded.</p>
          )}
        </DetailField>

        <DetailField label="BANT">
          <div className="flex items-center gap-2">
            <BantChip score={row.bant_score} />
            <span className="text-xs text-ink-dim">{bantLabel(row.bant_score)}</span>
          </div>
        </DetailField>

        <DetailField label="Transfer outcome">
          {row.transferred_to_agent ? (
            <p className="text-sm text-[--color-good]">
              Transferred to agent{row.transfer_outcome ? ` — ${row.transfer_outcome}` : ''}
            </p>
          ) : row.transfer_outcome ? (
            <p className="text-sm text-ink-dim">{row.transfer_outcome}</p>
          ) : (
            <p className="text-sm text-ink-mute">No transfer.</p>
          )}
        </DetailField>

        <div className="flex flex-wrap items-center gap-2">
          {row.dnc_flagged && (
            <span className="inline-flex items-center rounded-md border border-[--color-danger]/40 bg-[--color-danger]/15 px-2 py-0.5 text-xs font-medium text-[--color-danger]">
              DNC flagged
            </span>
          )}
          {row.disconnection_reason && (
            <span className="inline-flex items-center rounded-md border border-line bg-[--color-panel-hi] px-2 py-0.5 text-xs text-ink-dim">
              {row.disconnection_reason.replace(/_/g, ' ')}
            </span>
          )}
        </div>

        {row.recording_url && (
          <DetailField label="Recording">
            <audio controls preload="none" src={row.recording_url} className="w-full">
              Your browser does not support the audio element.
            </audio>
          </DetailField>
        )}

        <DetailField label="Provider call id">
          <code className="break-all font-mono text-xs text-ink-dim">{row.provider_call_id}</code>
        </DetailField>
      </div>
      <div className="lg:col-span-2">
        <DetailField label="Transcript">
          {row.transcript ? (
            <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-[--color-canvas] p-3 font-mono text-xs leading-relaxed text-ink-dim">
              {row.transcript}
            </div>
          ) : (
            <p className="text-sm text-ink-mute">Transcript not available.</p>
          )}
        </DetailField>
      </div>
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-[--tracking-label] text-ink-mute">{label}</div>
      {children}
    </div>
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
