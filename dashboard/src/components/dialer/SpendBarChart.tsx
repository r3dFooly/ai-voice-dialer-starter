'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { DailySpendPoint } from '@/lib/dialer/types';

type Props = {
  data: DailySpendPoint[];
};

function shortLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day.slice(5);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function SpendBarChart({ data }: Props) {
  const series = React.useMemo(
    () => data.map((d) => ({ ...d, label: shortLabel(d.day) })),
    [data],
  );

  return (
    <div className="h-32 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--color-ink-mute)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: 'var(--color-ink-mute)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
            width={32}
            tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-panel-hi)', opacity: 0.5 }}
            contentStyle={{
              background: 'var(--color-panel)',
              border: '1px solid var(--color-line)',
              borderRadius: 6,
              fontSize: 11,
            }}
            labelStyle={{ color: 'var(--color-ink-dim)' }}
            formatter={(value) => {
              const n = typeof value === 'number' ? value : Number(value ?? 0);
              return [`$${n.toFixed(2)}`, 'Spend'];
            }}
          />
          <Bar dataKey="spend" fill="var(--color-teal)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
