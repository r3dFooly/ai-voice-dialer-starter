import { Clock, DollarSign, Phone, Receipt, TrendingUp } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { DailySpendPoint } from '@/lib/dialer/types';
import { SpendBarChart } from './SpendBarChart';

type Props = {
  spendToday: number;
  spendMonth: number;
  callsToday: number;
  avgDurationSeconds: number;
  dailyCap: number;
  monthlyCap: number;
  series: DailySpendPoint[];
};

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function SpendTracker({
  spendToday,
  spendMonth,
  callsToday,
  avgDurationSeconds,
  dailyCap,
  monthlyCap,
  series,
}: Props) {
  const dailyPct = dailyCap > 0 ? Math.min(100, (spendToday / dailyCap) * 100) : 0;
  const monthlyPct = monthlyCap > 0 ? Math.min(100, (spendMonth / monthlyCap) * 100) : 0;
  // Average cost per call today = spend today ÷ calls today. Guard the zero-call
  // case so we show $0.00 rather than NaN / Infinity.
  const costPerCall = callsToday > 0 ? spendToday / callsToday : 0;

  return (
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <SpendCard
        label="Spend today"
        icon={<DollarSign className="h-3.5 w-3.5" />}
        value={`$${spendToday.toFixed(2)}`}
        sub={dailyCap > 0 ? `${dailyPct.toFixed(0)}% of $${dailyCap.toFixed(2)} cap` : 'No cap set'}
        progress={dailyPct}
        tone={dailyPct >= 90 ? 'danger' : dailyPct >= 70 ? 'warn' : 'default'}
      />
      <SpendCard
        label="Spend this month"
        icon={<TrendingUp className="h-3.5 w-3.5" />}
        value={`$${spendMonth.toFixed(2)}`}
        sub={
          monthlyCap > 0
            ? `${monthlyPct.toFixed(0)}% of $${monthlyCap.toFixed(2)} cap`
            : 'No cap set'
        }
        progress={monthlyPct}
        tone={monthlyPct >= 90 ? 'danger' : monthlyPct >= 70 ? 'warn' : 'default'}
      />
      <SpendCard
        label="Cost / call"
        icon={<Receipt className="h-3.5 w-3.5" />}
        value={`$${costPerCall.toFixed(2)}`}
        sub="Spend ÷ calls today"
      />
      <SpendCard
        label="Calls today"
        icon={<Phone className="h-3.5 w-3.5" />}
        value={callsToday.toLocaleString()}
        sub="Calls placed today"
      />
      <SpendCard
        label="Avg call duration"
        icon={<Clock className="h-3.5 w-3.5" />}
        value={formatDuration(avgDurationSeconds)}
        sub="Today's calls"
      />
      <div className="rounded-lg border border-line bg-panel p-4 sm:col-span-2 lg:col-span-3 xl:col-span-1">
        <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-[--tracking-label] text-ink-mute">
          Daily spend · 14d
        </div>
        <SpendBarChart data={series} />
      </div>
    </section>
  );
}

type Tone = 'default' | 'warn' | 'danger';

function SpendCard({
  label,
  icon,
  value,
  sub,
  progress,
  tone = 'default',
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  sub?: string;
  progress?: number;
  tone?: Tone;
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-[--color-danger]'
      : tone === 'warn'
        ? 'text-[--color-gold]'
        : 'text-ink';
  const barClass =
    tone === 'danger'
      ? 'bg-[--color-danger]'
      : tone === 'warn'
        ? 'bg-[--color-gold]'
        : 'bg-[--color-teal]';
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-[--tracking-label] text-ink-mute">
        <span>{icon}</span>
        {label}
      </div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums', valueClass)}>{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
      {progress != null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-[--color-panel-hi]">
          <div
            className={cn('h-full transition-[width] duration-300 ease-out', barClass)}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
