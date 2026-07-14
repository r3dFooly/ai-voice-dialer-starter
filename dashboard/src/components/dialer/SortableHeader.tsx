'use client';

// Clickable table header that drives server-side sort via the URL. Click a column
// to sort by it (defaults to desc); click the active column again to flip
// direction. Sort state lives in the query string so it survives reload + the
// back button. Pagination is reset on any sort change. Used by both the call
// history and active queue tables (each passes its own param namespace so the two
// tables sort independently on the same page).

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';

type Props = {
  label: string;
  /** sort key for this column (must match the server whitelist) */
  col: string;
  /** URL param holding the active sort column (e.g. 'hsort' / 'qsort') */
  sortParam: string;
  /** URL param holding the active direction asc|desc (e.g. 'hord' / 'qord') */
  ordParam: string;
  /** pagination param to reset on sort change (e.g. 'page' / 'qpage') */
  pageParam?: string;
  className?: string;
};

export function SortableHeader({ label, col, sortParam, ordParam, pageParam, className }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const activeCol = params.get(sortParam);
  const activeOrd = params.get(ordParam) === 'asc' ? 'asc' : 'desc';
  const isActive = activeCol === col;

  const onClick = () => {
    const sp = new URLSearchParams(params.toString());
    sp.set(sortParam, col);
    sp.set(ordParam, isActive && activeOrd === 'desc' ? 'asc' : 'desc');
    if (pageParam) sp.delete(pageParam);
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const Icon = isActive ? (activeOrd === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <th className={cn('whitespace-nowrap px-3 py-2.5 text-left font-medium', className)}>
      <button
        type="button"
        onClick={onClick}
        aria-label={`Sort by ${label}`}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-ink',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-ring]',
          'active:opacity-80',
          isActive && 'text-ink',
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', isActive ? 'text-ink' : 'text-ink-mute/60')} aria-hidden />
      </button>
    </th>
  );
}
