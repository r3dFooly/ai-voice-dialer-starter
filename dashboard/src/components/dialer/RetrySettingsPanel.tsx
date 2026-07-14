'use client';

// Retry settings panel. Collapsible section below the spend caps. Three tier
// cards + a voicemail-limits card. Every input auto-saves on blur
// (updateRetrySetting), clamped to the field's RETRY_FIELD_BOUNDS. A blur that
// doesn't change the value is a no-op — no write, no toast.

import * as React from 'react';
import { ChevronDown, Loader2, Settings2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { toast } from '@/components/primitives/Toaster';
import { updateRetrySetting } from '@/lib/dialer/actions';
import { tierLabel } from '@/lib/config';
import {
  RETRY_FIELD_BOUNDS,
  type RetryFieldKey,
  type RetrySettings,
} from '@/lib/dialer/types';

type Props = { initial: RetrySettings };

export function RetrySettingsPanel({ initial }: Props) {
  const [open, setOpen] = React.useState(true);

  return (
    <section className="rounded-lg border border-line bg-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors duration-100',
          'hover:bg-[--color-panel-hi]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[--color-ring]',
          'active:scale-[0.997] rounded-lg',
        )}
      >
        <span className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-[--color-teal]" />
          <span className="text-sm font-medium text-ink">Retry settings</span>
          <span className="text-xs text-ink-mute">Per-tier attempt &amp; voicemail caps</span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-ink-mute transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="grid gap-4 border-t border-line-soft p-5 lg:grid-cols-2 xl:grid-cols-4">
          <TierCard
            title={tierLabel(1)}
            accent="--color-danger"
            fields={[
              { key: 'retell_tier1_daily_max', label: 'Daily max', value: initial.tier1.daily_max },
              { key: 'retell_tier1_monthly_max', label: 'Monthly max', value: initial.tier1.monthly_max },
              { key: 'retell_tier1_lifetime_max', label: 'Lifetime max', value: initial.tier1.lifetime_max },
              { key: 'retell_tier1_cooldown_hours', label: 'Cool-down (hrs)', value: initial.tier1.cooldown_hours },
              { key: 'retell_tier1_decay_days', label: 'Decay (days)', value: initial.tier1.decay_days },
            ]}
          />
          <TierCard
            title={tierLabel(2)}
            accent="--color-teal"
            fields={[
              { key: 'retell_tier2_daily_max', label: 'Daily max', value: initial.tier2.daily_max },
              { key: 'retell_tier2_monthly_max', label: 'Monthly max', value: initial.tier2.monthly_max },
              { key: 'retell_tier2_lifetime_max', label: 'Lifetime max', value: initial.tier2.lifetime_max },
              { key: 'retell_tier2_cooldown_hours', label: 'Cool-down (hrs)', value: initial.tier2.cooldown_hours },
            ]}
          />
          <TierCard
            title={tierLabel(3)}
            accent="--color-gold"
            fields={[
              { key: 'retell_tier3_daily_max', label: 'Daily max', value: initial.tier3.daily_max },
              { key: 'retell_tier3_monthly_max', label: 'Monthly max', value: initial.tier3.monthly_max },
              { key: 'retell_tier3_lifetime_max', label: 'Lifetime max', value: initial.tier3.lifetime_max },
              { key: 'retell_tier3_cooldown_hours', label: 'Cool-down (hrs)', value: initial.tier3.cooldown_hours },
            ]}
          />
          <TierCard
            title="Voicemail Limits"
            accent="--color-accent-2"
            fields={[
              { key: 'retell_vm_max_per_day', label: 'VM per day', value: initial.vm.max_per_day },
              { key: 'retell_vm_max_lifetime', label: 'VM lifetime', value: initial.vm.max_lifetime },
            ]}
          />
        </div>
      )}
    </section>
  );
}

type FieldSpec = { key: RetryFieldKey; label: string; value: number };

function TierCard({
  title,
  accent,
  fields,
}: {
  title: string;
  accent: string;
  fields: FieldSpec[];
}) {
  return (
    <div className="rounded-lg border border-line bg-[--color-panel-hi]/30 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: `var(${accent})` }} />
        <h3 className="text-xs font-semibold uppercase tracking-[--tracking-label] text-ink-dim">
          {title}
        </h3>
      </div>
      <div className="space-y-2.5">
        {fields.map((f) => (
          <RetryNumberField key={f.key} settingKey={f.key} label={f.label} initial={f.value} />
        ))}
      </div>
    </div>
  );
}

function RetryNumberField({
  settingKey,
  label,
  initial,
}: {
  settingKey: RetryFieldKey;
  label: string;
  initial: number;
}) {
  const bounds = RETRY_FIELD_BOUNDS[settingKey];
  const [value, setValue] = React.useState(String(initial));
  const [saved, setSaved] = React.useState(initial);
  const [pending, startTransition] = React.useTransition();
  const inputId = `retry-${settingKey}`;

  const commit = () => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      setValue(String(saved));
      toast.error(`${label} must be a number`);
      return;
    }
    const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
    if (clamped !== parsed) setValue(String(clamped));
    if (clamped === saved) return; // no change → no write
    startTransition(async () => {
      const res = await updateRetrySetting(settingKey, clamped);
      if (res.ok) {
        setSaved(clamped);
        toast.success(`${label} saved`);
      } else {
        setValue(String(saved));
        toast.error(`${label}: ${res.error}`);
      }
    });
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor={inputId} className="text-xs text-ink-dim">
        {label}
      </Label>
      <div className="relative w-20">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="h-8 pr-6 text-right font-mono tabular-nums"
          aria-describedby={`${inputId}-range`}
        />
        {pending && (
          <Loader2 className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-ink-mute" />
        )}
      </div>
      <span id={`${inputId}-range`} className="sr-only">
        Allowed range {bounds.min} to {bounds.max}
      </span>
    </div>
  );
}
