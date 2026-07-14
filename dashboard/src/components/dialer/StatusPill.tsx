import { cn } from '@/lib/utils';
import { STATUS_LABEL } from '@/lib/dialer/status';
import type { DialerStatusIndicator } from '@/lib/dialer/types';

const TONE: Record<DialerStatusIndicator, { dot: string; text: string; ring: string }> = {
  active: {
    dot: 'bg-[--color-good]',
    text: 'text-[--color-good]',
    ring: 'border-[--color-good]/40 bg-[--color-good]/10',
  },
  paused: {
    dot: 'bg-[--color-gold]',
    text: 'text-[--color-gold]',
    ring: 'border-[--color-gold]/40 bg-[--color-gold]/10',
  },
  outside_hours: {
    dot: 'bg-ink-mute',
    text: 'text-ink-dim',
    ring: 'border-line bg-[--color-panel-hi]',
  },
  cap_reached: {
    dot: 'bg-[--color-danger]',
    text: 'text-[--color-danger]',
    ring: 'border-[--color-danger]/40 bg-[--color-danger]/10',
  },
};

export function DialerStatusPill({ status }: { status: DialerStatusIndicator }) {
  const tone = TONE[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium',
        tone.ring,
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', tone.dot)} aria-hidden />
      <span className={tone.text}>{STATUS_LABEL[status]}</span>
    </span>
  );
}
