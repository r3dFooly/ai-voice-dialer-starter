import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        // PR H.1: text-base (13px) per DESIGN_DIRECTION.md form input spec.
        // PR H.2: py-2 (was py-1) per DESIGN_DIRECTION.md form input padding.
        // PR H.3: transition-colors duration-150 ease-out (form input focus
        // is held longer than hover) per DESIGN_DIRECTION.md motion spec.
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-colors duration-150 ease-out file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };
