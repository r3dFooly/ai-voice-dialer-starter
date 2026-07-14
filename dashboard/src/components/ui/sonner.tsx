"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";

// PR H.4: theme config aligned to DESIGN_DIRECTION.md.
//   - font-sans cascades from <html> (Plex Sans, set in app/layout.tsx)
//   - title text-base font-medium (13px)
//   - description text-sm (12px) muted
//   - duration 4000ms — long enough to read, short enough to not loiter
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        duration: 4000,
        classNames: {
          toast:
            "group toast font-sans text-base group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-md",
          title: "text-base font-medium",
          description: "text-sm group-[.toast]:text-muted-foreground",
          actionButton: "text-xs group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "text-xs group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
