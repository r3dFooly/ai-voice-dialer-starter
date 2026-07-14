'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/primitives/Toaster';
import { rescheduleQueueRow } from '@/lib/dialer/actions';
import { useRouter } from 'next/navigation';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queueId: string | null;
  contactName: string | null;
};

function nextHourLocalIso(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function RescheduleDialog({ open, onOpenChange, queueId, contactName }: Props) {
  const router = useRouter();
  const [value, setValue] = React.useState(nextHourLocalIso);
  const [pending, startTransition] = React.useTransition();

  const submit = () => {
    if (!queueId) return;
    if (!value) {
      toast.error('Pick a date and time');
      return;
    }
    startTransition(async () => {
      const res = await rescheduleQueueRow(queueId, new Date(value).toISOString());
      if (res.ok) {
        toast.success('Reschedule queued');
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(`Failed: ${res.error}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reschedule next attempt</DialogTitle>
          <DialogDescription>
            {contactName ? `For ${contactName}.` : null} Pick a new attempt time.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="reschedule-at" className="text-xs uppercase tracking-[--tracking-label] text-ink-dim">
            Next attempt
          </Label>
          <Input
            id="reschedule-at"
            type="datetime-local"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="font-mono"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !queueId}>
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Reschedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
