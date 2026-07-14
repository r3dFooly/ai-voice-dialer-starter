"use client";

import * as React from "react";
import { ChevronDown, Loader2, MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/primitives/ConfirmDialog";
import { toast } from "@/components/primitives/Toaster";

export type RowAction = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  variant?: "default" | "destructive";
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  /** When true, the action is filtered out entirely (use for role-gated items). */
  hidden?: boolean;
  /** When set, wraps the action in a ConfirmDialog. */
  confirm?: { title: string; description?: React.ReactNode; confirmText?: string };
  /** When true, renders a separator after this item in the dropdown. */
  separator?: boolean;
};

export type RowActionMenuProps = {
  actions: RowAction[];
  align?: "start" | "end";
  triggerVariant?: "kebab" | "caret" | "inline";
  /** Optional ARIA label override. */
  triggerLabel?: string;
  className?: string;
};

/**
 * Per-row kebab menu wrapping shadcn DropdownMenu. Auto-collapses if all
 * actions are `hidden`. Per-action loading + toast feedback for async
 * onClicks; destructive actions can be wrapped in ConfirmDialog by
 * passing `confirm`.
 */
export function RowActionMenu({
  actions,
  align = "end",
  triggerVariant = "kebab",
  triggerLabel = "Row actions",
  className,
}: RowActionMenuProps) {
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const visible = actions.filter((a) => !a.hidden);

  if (visible.length === 0) return null;

  const runAction = async (action: RowAction) => {
    setPendingId(action.id);
    try {
      await action.onClick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Action failed";
      toast.error(msg);
    } finally {
      setPendingId(null);
    }
  };

  const Trigger =
    triggerVariant === "kebab" ? (
      <Button variant="ghost" size="sm" className={cn("h-6 w-6 p-0", className)} aria-label={triggerLabel}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </Button>
    ) : triggerVariant === "caret" ? (
      <Button variant="ghost" size="sm" className={cn("h-6 w-6 p-0", className)} aria-label={triggerLabel}>
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
    ) : (
      <Button variant="outline" size="sm" className={cn("h-7 gap-1 text-xs", className)} aria-label={triggerLabel}>
        Actions
        <ChevronDown className="h-3 w-3" />
      </Button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{Trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {visible.map((action, idx) => {
          const isPending = pendingId === action.id;
          const itemContent = (
            <>
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : action.icon}
              <span className={cn(action.variant === "destructive" && "text-[--color-danger]")}>{action.label}</span>
            </>
          );

          if (action.confirm) {
            // Destructive confirmation: render an Item that opens a Dialog.
            return (
              <React.Fragment key={action.id}>
                <ConfirmDialog
                  trigger={
                    <DropdownMenuItem
                      onSelect={(e) => e.preventDefault()}
                      disabled={action.disabled || !!pendingId}
                      className={cn(action.variant === "destructive" && "text-[--color-danger]")}
                    >
                      {itemContent}
                    </DropdownMenuItem>
                  }
                  title={action.confirm.title}
                  description={action.confirm.description}
                  confirmText={action.confirm.confirmText ?? action.label}
                  confirmVariant={action.variant === "destructive" ? "destructive" : "default"}
                  onConfirm={() => runAction(action)}
                />
                {action.separator && idx < visible.length - 1 && <DropdownMenuSeparator />}
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={action.id}>
              <DropdownMenuItem
                onClick={() => void runAction(action)}
                disabled={action.disabled || !!pendingId}
                className={cn(action.variant === "destructive" && "text-[--color-danger]")}
              >
                {itemContent}
              </DropdownMenuItem>
              {action.separator && idx < visible.length - 1 && <DropdownMenuSeparator />}
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
