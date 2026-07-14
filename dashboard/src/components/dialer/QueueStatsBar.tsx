// At-a-glance queue counters shown above the active queue. Pure presentation —
// the page computes the aggregates server-side (fetchQueueStats).

import { cn } from '@/lib/utils';
import type { QueueStats } from '@/lib/dialer/types';

export function QueueStatsBar({ stats }: { stats: QueueStats }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-7">
      <Stat label="In queue" value={stats.total} />
      <Stat label="Pending" value={stats.pending} tone="info" />
      <Stat label="In progress" value={stats.in_progress} tone="warn" />
      <Stat label="Completed today" value={stats.completed_today} tone="good" />
      <Stat
        label="By tier"
        value={
          <span className="flex items-baseline gap-1.5 font-mono text-base tabular-nums">
            <span className="text-[--color-danger]">{stats.tier1}</span>
            <span className="text-ink-mute">/</span>
            <span className="text-[--color-teal]">{stats.tier2}</span>
            <span className="text-ink-mute">/</span>
            <span className="text-[--color-gold]">{stats.tier3}</span>
          </span>
        }
        hint="T1 / T2 / T3"
      />
      <Stat
        label="Calls left today"
        value={stats.calls_remaining_today}
        hint="Under daily cap"
        tone="info"
        className="col-span-2 sm:col-span-1 lg:col-span-2"
      />
    </div>
  );
}

type Tone = 'default' | 'info' | 'warn' | 'good';

function Stat({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: Tone;
  className?: string;
}) {
  const valueClass =
    tone === 'info'
      ? 'text-[--color-teal]'
      : tone === 'warn'
        ? 'text-[--color-gold]'
        : tone === 'good'
          ? 'text-[--color-good]'
          : 'text-ink';
  return (
    <div className={cn('bg-panel px-4 py-3', className)}>
      <div className="text-xs uppercase tracking-[--tracking-label] text-ink-mute">{label}</div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', valueClass)}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-mute">{hint}</div>}
    </div>
  );
}
