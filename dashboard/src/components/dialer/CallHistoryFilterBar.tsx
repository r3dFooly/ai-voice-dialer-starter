'use client';

// URL-driven filters above call history:
//   - direction   (?dir)        All | Outbound | Inbound callbacks
//   - disposition (?disposition) the analyzed call disposition
//   - connection  (?conn)        all | connected-only (excludes voicemail/no-answer)
//   - min length  (?minlen)      minimum call duration in seconds
// Every change resets pagination (?page) so a filter starts at page 1.

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PhoneIncoming, PhoneOutgoing, Phone } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Mirrors the retell_call_queue.disposition CHECK set (server-side enum).
const DISPOSITIONS = [
  'Transferred',
  'Callback',
  'Not_Qualified',
  'Voicemail',
  'No_Answer',
  'DNC',
  'Completed',
];

const MIN_LENGTHS: { value: string; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: '30', label: '≥ 30s' },
  { value: '60', label: '≥ 1m' },
  { value: '120', label: '≥ 2m' },
];

export function CallHistoryFilterBar({ value }: { value: 'all' | 'outbound' | 'inbound' }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const disposition = params.get('disposition') ?? 'all';
  const conn = params.get('conn') ?? 'all';
  const minlen = params.get('minlen') ?? 'all';

  const push = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === 'all') sp.delete(k);
      else sp.set(k, v);
    }
    // Any filter change resets pagination — the old page may not exist under the
    // narrowed result set.
    sp.delete('page');
    router.replace(`${pathname}?${sp.toString()}`);
  };

  // Radix returns '' when the active toggle item is clicked off — treat as 'all'.
  const onDirChange = (next: string) => push({ dir: (next || 'all') === 'all' ? null : next });

  const hasFilters = disposition !== 'all' || conn !== 'all' || minlen !== 'all';

  return (
    <div className="flex flex-wrap items-center gap-3">
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={onDirChange}
        variant="outline"
        size="sm"
        className="justify-start"
      >
        <ToggleGroupItem value="all" aria-label="All calls" className="gap-1.5 text-xs">
          <Phone className="h-3.5 w-3.5" /> All
        </ToggleGroupItem>
        <ToggleGroupItem value="outbound" aria-label="Outbound calls" className="gap-1.5 text-xs">
          <PhoneOutgoing className="h-3.5 w-3.5" /> Outbound
        </ToggleGroupItem>
        <ToggleGroupItem value="inbound" aria-label="Inbound callbacks" className="gap-1.5 text-xs">
          <PhoneIncoming className="h-3.5 w-3.5" /> Inbound
        </ToggleGroupItem>
      </ToggleGroup>

      <FilterSlot label="Disposition">
        <Select value={disposition} onValueChange={(v) => push({ disposition: v })}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {DISPOSITIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {d.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSlot>

      <FilterSlot label="Connection">
        <Select value={conn} onValueChange={(v) => push({ conn: v })}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All calls</SelectItem>
            <SelectItem value="connected">Connected only</SelectItem>
          </SelectContent>
        </Select>
      </FilterSlot>

      <FilterSlot label="Min length">
        <Select value={minlen} onValueChange={(v) => push({ minlen: v })}>
          <SelectTrigger className="h-8 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MIN_LENGTHS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSlot>

      {hasFilters && (
        <button
          type="button"
          onClick={() => push({ disposition: null, conn: null, minlen: null })}
          className="text-xs text-ink-dim underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-ring]"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function FilterSlot({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink-mute">
      <span className="uppercase tracking-[--tracking-label]">{label}</span>
      {children}
    </label>
  );
}
