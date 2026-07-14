"use client";

import * as React from "react";
import { Inbox } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type EmptyStateProps = {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: {
    label: string;
    onClick: () => void;
    variant?: "default" | "outline" | "ghost" | "secondary";
  };
  /** Compact reduces padding. */
  density?: "compact" | "regular";
  className?: string;
};

/**
 * Replaces ui-legacy.EmptyState with a centered, muted block + optional CTA.
 * Use for any list/table/dashboard zero-state.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  density = "regular",
  className,
}: EmptyStateProps) {
  const padY = density === "compact" ? "py-6" : "py-12";
  // PR H.4: visual hierarchy bumped per the H.4 spec — title text-lg
  // font-semibold, description text-sm. Slightly larger icon container and
  // generous vertical padding so empty states read as deliberate copy, not
  // missing data. Decision Log entry recorded in DESIGN_DIRECTION.md.
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/60 px-6 text-center",
        padY,
        className
      )}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[--color-panel-hi]/40 text-muted-foreground">
        {icon ?? <Inbox className="h-6 w-6" />}
      </div>
      <h3 className="text-lg font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {action && (
        <Button
          variant={action.variant ?? "default"}
          size="sm"
          onClick={action.onClick}
          className="mt-4"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
