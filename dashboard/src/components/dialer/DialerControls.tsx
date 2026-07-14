'use client';

// Top control bar — master toggle + operating window + caps + holiday blocks.
// Edits are buffered locally and committed via the Save button so a quick
// click on the master switch doesn't silently flush a half-edited time window.
// Save calls updateDialerSettings and then router.refresh() to re-pull the
// derived status pill from the server.

import * as React from 'react';
import { CalendarPlus, Loader2, Save, X } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { toast } from '@/components/primitives/Toaster';
import { cn } from '@/lib/utils';
import { computeStatusIndicator } from '@/lib/dialer/status';
import { DAY_LABELS, type DialerSettings, type DialerStatusIndicator } from '@/lib/dialer/types';
import { DialerStatusPill } from './StatusPill';
import { updateDialerSettings } from '@/lib/dialer/actions';

type Props = {
  initial: DialerSettings;
  initialStatus: DialerStatusIndicator;
  spendToday: number;
  spendMonth: number;
};

export function DialerControls({ initial, initialStatus, spendToday, spendMonth }: Props) {
  const router = useRouter();
  const [settings, setSettings] = React.useState<DialerSettings>(initial);
  const [pending, startTransition] = React.useTransition();
  const [dirty, setDirty] = React.useState(false);

  // Re-derive the status pill from local edits so the user sees the effect
  // of a change before clicking Save. Server is the source of truth on next
  // refresh.
  const derivedStatus: DialerStatusIndicator = React.useMemo(
    () => computeStatusIndicator({ settings, spendToday, spendMonth }),
    [settings, spendToday, spendMonth],
  );
  const displayStatus = dirty ? derivedStatus : initialStatus;

  const update = (patch: Partial<DialerSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const toggleDay = (idx: number) => {
    update({
      operating_days: settings.operating_days.includes(idx)
        ? settings.operating_days.filter((d) => d !== idx)
        : [...settings.operating_days, idx].sort((a, b) => a - b),
    });
  };

  const addBlockedDate = (iso: string) => {
    if (settings.blocked_dates.includes(iso)) return;
    update({ blocked_dates: [...settings.blocked_dates, iso].sort() });
  };

  const removeBlockedDate = (iso: string) => {
    update({ blocked_dates: settings.blocked_dates.filter((d) => d !== iso) });
  };

  const save = () => {
    startTransition(async () => {
      const res = await updateDialerSettings(settings);
      if (res.ok) {
        toast.success('Dialer settings saved');
        setDirty(false);
        router.refresh();
      } else {
        toast.error(`Save failed: ${res.error}`);
      }
    });
  };

  return (
    <section className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
        <div className="flex items-center gap-3">
          <Switch
            id="dialer-master"
            checked={settings.enabled}
            onCheckedChange={(v) => update({ enabled: v })}
          />
          <Label htmlFor="dialer-master" className="text-sm font-medium text-ink">
            Master dialer
          </Label>
          <DialerStatusPill status={displayStatus} />
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-ink-mute">Unsaved changes</span>}
          <Button size="sm" onClick={save} disabled={pending || !dirty} className="gap-1.5">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <div className="space-y-2">
          <FieldLabel>Operating days</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {DAY_LABELS.map((d) => {
              const on = settings.operating_days.includes(d.idx);
              return (
                <button
                  key={d.idx}
                  type="button"
                  onClick={() => toggleDay(d.idx)}
                  aria-pressed={on}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors duration-100',
                    'hover:border-[--color-teal]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-ring]',
                    'active:scale-[0.98]',
                    on
                      ? 'border-[--color-teal]/60 bg-[--color-teal]/15 text-[--color-teal]'
                      : 'border-line bg-[--color-panel-hi] text-ink-dim',
                  )}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <FieldLabel>Calling hours</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={settings.hours_start}
              onChange={(e) => update({ hours_start: e.target.value })}
              className="w-32 font-mono"
              aria-label="Start time"
            />
            <span className="text-xs text-ink-mute">to</span>
            <Input
              type="time"
              value={settings.hours_end}
              onChange={(e) => update({ hours_end: e.target.value })}
              className="w-32 font-mono"
              aria-label="End time"
            />
          </div>
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="daily-cap">Daily spend cap</FieldLabel>
          <div className="relative w-40">
            <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-xs text-ink-mute">
              $
            </span>
            <Input
              id="daily-cap"
              type="number"
              step="0.01"
              min="0"
              value={settings.daily_cap}
              onChange={(e) => update({ daily_cap: Number(e.target.value) })}
              className="pl-6 font-mono tabular-nums"
            />
          </div>
        </div>

        <div className="space-y-2">
          <FieldLabel htmlFor="monthly-cap">Monthly spend cap</FieldLabel>
          <div className="relative w-40">
            <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-xs text-ink-mute">
              $
            </span>
            <Input
              id="monthly-cap"
              type="number"
              step="0.01"
              min="0"
              value={settings.monthly_cap}
              onChange={(e) => update({ monthly_cap: Number(e.target.value) })}
              className="pl-6 font-mono tabular-nums"
            />
          </div>
        </div>

        <div className="space-y-2 lg:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>Holiday blocks</FieldLabel>
            <BlockedDatePopover
              onAdd={addBlockedDate}
              disabledDates={settings.blocked_dates}
            />
          </div>
          {settings.blocked_dates.length === 0 ? (
            <p className="text-xs text-ink-mute">No blocked dates.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {settings.blocked_dates.map((iso) => (
                <span
                  key={iso}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-[--color-panel-hi] px-2 py-1 font-mono text-xs text-ink-dim"
                >
                  {iso}
                  <button
                    type="button"
                    onClick={() => removeBlockedDate(iso)}
                    className="rounded text-ink-mute hover:text-[--color-danger] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-ring]"
                    aria-label={`Remove ${iso}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

      </div>
    </section>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <Label
      htmlFor={htmlFor}
      className="text-xs uppercase tracking-[--tracking-label] text-ink-dim"
    >
      {children}
    </Label>
  );
}

function BlockedDatePopover({
  onAdd,
  disabledDates,
}: {
  onAdd: (iso: string) => void;
  disabledDates: string[];
}) {
  const [open, setOpen] = React.useState(false);
  const blockedSet = React.useMemo(() => new Set(disabledDates), [disabledDates]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <CalendarPlus className="h-3.5 w-3.5" />
          Add date
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <Calendar
          mode="single"
          onSelect={(d) => {
            if (!d) return;
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            onAdd(iso);
            setOpen(false);
          }}
          disabled={(d) => {
            const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return blockedSet.has(iso);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

