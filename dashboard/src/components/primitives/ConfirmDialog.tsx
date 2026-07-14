"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export type ConfirmDialogProps = {
  /** Element rendered as the trigger. Wrap with `asChild` semantics — Radix Slot. */
  trigger: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Visual treatment of the confirm button. Destructive paints it red. */
  confirmVariant?: "default" | "destructive";
  /**
   * Promise-returning confirm handler. The dialog stays open while pending,
   * closes on resolve, stays open + surfaces the error message on reject.
   */
  onConfirm: () => Promise<void> | void;
  /** Optional callback fired when the user cancels. */
  onCancel?: () => void;
  className?: string;
};

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmVariant = "default",
  onConfirm,
  onCancel,
  className,
}: ConfirmDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && !busy) {
      onCancel?.();
      setError(null);
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className={cn("sm:max-w-md", className)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {confirmVariant === "destructive" && (
              <AlertTriangle className="h-4 w-4 text-[--color-danger]" />
            )}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-[--color-danger]">
            {error}
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            {cancelText}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
