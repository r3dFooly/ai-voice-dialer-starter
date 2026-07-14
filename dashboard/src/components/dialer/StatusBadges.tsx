import { cn } from '@/lib/utils';
import { tierLabel } from '@/lib/config';
import type { DialerTier } from '@/lib/dialer/types';

const QUEUE_STATUS_TONE: Record<string, string> = {
  Pending: 'bg-[--color-accent-1]/15 text-[--color-accent-1] border-[--color-accent-1]/40',
  In_Progress: 'bg-[--color-gold]/15 text-[--color-gold] border-[--color-gold]/40',
  Completed: 'bg-[--color-good]/15 text-[--color-good] border-[--color-good]/40',
  Voicemail: 'bg-[--color-accent-2]/15 text-[--color-accent-2] border-[--color-accent-2]/40',
  DNC: 'bg-[--color-danger]/15 text-[--color-danger] border-[--color-danger]/40',
  No_Answer: 'bg-[--color-panel-hi] text-ink-dim border-line',
  Skipped: 'bg-[--color-panel-hi] text-ink-mute border-line',
  Removed: 'bg-[--color-panel-hi] text-ink-mute border-line',
};

export function QueueStatusBadge({ status }: { status: string }) {
  const tone = QUEUE_STATUS_TONE[status] ?? QUEUE_STATUS_TONE.Pending;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        tone,
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

const SENTIMENT_TONE: Record<string, string> = {
  positive: 'text-[--color-good]',
  neutral: 'text-ink-dim',
  negative: 'text-[--color-danger]',
};

export function SentimentChip({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return <span className="text-ink-mute">—</span>;
  const key = sentiment.toLowerCase();
  return (
    <span className={cn('text-xs font-medium', SENTIMENT_TONE[key] ?? 'text-ink-dim')}>
      {sentiment}
    </span>
  );
}

export function BantChip({ score }: { score: number | null }) {
  if (score == null) return <span className="text-ink-mute">—</span>;
  // Thresholds: green ≥70, yellow ≥40, red <40.
  const tone =
    score >= 70
      ? 'bg-[--color-good]/15 text-[--color-good] border-[--color-good]/40'
      : score >= 40
        ? 'bg-[--color-gold]/15 text-[--color-gold] border-[--color-gold]/40'
        : 'bg-[--color-danger]/15 text-[--color-danger] border-[--color-danger]/40';
  return (
    <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-xs font-mono tabular-nums', tone)}>
      {score}
    </span>
  );
}

const TIER_TONE: Record<DialerTier, string> = {
  1: 'bg-[--color-danger]/15 text-[--color-danger] border-[--color-danger]/40',
  2: 'bg-[--color-teal]/15 text-[--color-teal] border-[--color-teal]/40',
  3: 'bg-[--color-gold]/15 text-[--color-gold] border-[--color-gold]/40',
  4: 'bg-[--color-panel-hi] text-ink-mute border-line',
};

export function TierBadge({ tier }: { tier: DialerTier }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
        TIER_TONE[tier],
      )}
    >
      {tierLabel(tier)}
    </span>
  );
}

/** Gray pill shown when a row has hit a hard cap and can no longer be dialed. */
export function CapReachedBadge({ kind }: { kind: 'attempts' | 'vm' }) {
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-[--color-panel-hi] px-2 py-0.5 text-xs font-medium text-ink-mute">
      {kind === 'vm' ? 'Max VM' : 'Max attempts'}
    </span>
  );
}
