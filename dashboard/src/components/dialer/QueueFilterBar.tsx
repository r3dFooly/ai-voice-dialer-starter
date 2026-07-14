'use client';

// URL-driven filter bar for the queue. status / source / date range live in
// the query string so deep links and the back button survive a page reload.

import * as React from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DIALER_STATUSES } from '@/lib/dialer/types';

type Props = {
  sources: string[];
};

export function QueueFilterBar({ sources }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const status = params.get('status') ?? 'all';
  const source = params.get('source') ?? 'all';
  const start = params.get('start') ?? '';
  const end = params.get('end') ?? '';

  const push = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === 'all') sp.delete(k);
      else sp.set(k, v);
    }
    // Any filter change resets queue pagination — the old page may not exist
    // under the narrowed result set.
    sp.delete('qpage');
    router.replace(`${pathname}?${sp.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterSlot label="Status">
        <Select value={status} onValueChange={(v) => push({ status: v })}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {DIALER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSlot>

      <FilterSlot label="Source">
        <Select value={source} onValueChange={(v) => push({ source: v })}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSlot>

      <FilterSlot label="Created from">
        <Input
          type="date"
          value={start}
          onChange={(e) => push({ start: e.target.value })}
          className="h-8 w-36 font-mono text-xs"
          aria-label="Start date"
        />
      </FilterSlot>
      <FilterSlot label="to">
        <Input
          type="date"
          value={end}
          onChange={(e) => push({ end: e.target.value })}
          className="h-8 w-36 font-mono text-xs"
          aria-label="End date"
        />
      </FilterSlot>

      {(status !== 'all' || source !== 'all' || start || end) && (
        <button
          type="button"
          onClick={() => push({ status: null, source: null, start: null, end: null })}
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
