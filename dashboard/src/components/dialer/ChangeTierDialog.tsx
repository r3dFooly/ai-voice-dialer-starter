'use client';

// Re-tier a queued lead. Copies the chosen tier's caps onto the row via
// changeTier(). Tier 4 (Other) is read-only and not offered as a target.

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/primitives/Toaster';
import { changeTier } from '@/lib/dialer/actions';
import { tierLabel } from '@/lib/config';
import type { DialerTier } from '@/lib/dialer/types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queueId: string | null;
  contactName: string | null;
  currentTier: DialerTier | null;
};

const TIER_OPTIONS: { value: '1' | '2' | '3'; label: string }[] = [
  { value: '1', label: tierLabel(1) },
  { value: '2', label: tierLabel(2) },
  { value: '3', label: tierLabel(3) },
];

export function ChangeTierDialog({ open, onOpenChange, queueId, contactName, currentTier }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed inner form remounts per row (Radix only renders content while
            open), so the select seeds from currentTier without a setState
            effect. */}
        <TierForm
          key={queueId ?? 'none'}
          queueId={queueId}
          contactName={contactName}
          currentTier={currentTier}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function TierForm({
  queueId,
  contactName,
  currentTier,
  onClose,
}: {
  queueId: string | null;
  contactName: string | null;
  currentTier: DialerTier | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const initialTier: '1' | '2' | '3' =
    currentTier && currentTier <= 3 ? (String(currentTier) as '1' | '2' | '3') : '1';
  const [tier, setTier] = React.useState<'1' | '2' | '3'>(initialTier);
  const [pending, startTransition] = React.useTransition();

  const submit = () => {
    if (!queueId) return;
    startTransition(async () => {
      const res = await changeTier(queueId, Number(tier) as 1 | 2 | 3);
      if (res.ok) {
        toast.success(`Re-tiered to ${tierLabel(Number(tier))}`);
        onClose();
        router.refresh();
      } else {
        toast.error(`Failed: ${res.error}`);
      }
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Change tier</DialogTitle>
        <DialogDescription>
          {contactName ? `For ${contactName}. ` : null}Applies the tier&apos;s attempt caps and
          cool-down to this lead.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 py-2">
        <Label htmlFor="tier-select" className="text-xs uppercase tracking-[--tracking-label] text-ink-dim">
          Target tier
        </Label>
        <Select value={tier} onValueChange={(v) => setTier(v as '1' | '2' | '3')}>
          <SelectTrigger id="tier-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={pending || !queueId}>
          {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Apply tier
        </Button>
      </DialogFooter>
    </>
  );
}
