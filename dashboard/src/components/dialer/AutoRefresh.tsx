'use client';

// Re-pulls the server-rendered dialer page on a fixed cadence so spend,
// queue, and call history stay live without a manual reload. Pauses while the
// tab is hidden to avoid pointless background fetches. Renders nothing.

import * as React from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();

  React.useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
