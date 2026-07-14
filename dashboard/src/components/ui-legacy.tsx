// Minimal vendored legacy primitive(s) the dialer page depends on. The source
// app imported PageHeader from a large ui-legacy barrel; the standalone build
// only needs the page header, so it lives here on its own.

import { ReactNode } from "react";

export function PageHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      {hint && <p className="mt-1 text-sm text-ink-dim">{hint}</p>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-panel/60 p-8 text-center text-sm text-ink-dim">
      {children}
    </div>
  );
}
