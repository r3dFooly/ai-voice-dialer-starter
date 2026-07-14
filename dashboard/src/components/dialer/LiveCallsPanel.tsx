'use client';

// Live-calls board: the calls the dialer is on RIGHT NOW (queue rows in
// In_Progress). Read-only from existing tables — no transcript, no change to the
// call path. Seeded by the server render, then self-refreshes via the
// getActiveCalls server action every 5s, with a 1s local ticker so each call's
// duration advances between polls.

import * as React from 'react';
import { PhoneCall, User } from 'lucide-react';

import { EmptyState } from '@/components/primitives/EmptyState';
import { cn, maskPhone } from '@/lib/utils';
import { AGENT_NAME, agentDisplayName } from '@/lib/config';
import type { ActiveCall } from '@/lib/dialer/types';
import { getActiveCalls } from '@/lib/dialer/actions';

const POLL_MS = 5000;
const TICK_MS = 1000;

function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function LiveCallsPanel({ initial }: { initial: ActiveCall[] }) {
  const [calls, setCalls] = React.useState<ActiveCall[]>(initial);
  const [now, setNow] = React.useState<number>(() => Date.now());

  // Poll the active set; keep the last good list on a transient error.
  React.useEffect(() => {
    let alive = true;
    const id = setInterval(async () => {
      try {
        const next = await getActiveCalls();
        if (alive) setCalls(next);
      } catch {
        /* keep last good list */
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Advance durations between polls.
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (calls.length === 0) {
    return (
      <EmptyState
        title="No live calls"
        description={`When ${AGENT_NAME} is on a call, it shows here in real time.`}
      />
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {calls.map((c) => {
        const started = c.last_attempt_at ? new Date(c.last_attempt_at).getTime() : now;
        const agent = c.assigned_agent ? agentDisplayName(c.assigned_agent) : null;
        return (
          <div
            key={c.id}
            className="rounded-lg border border-line bg-[--color-panel-hi]/40 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[--tracking-label] text-[--color-good]">
                <span
                  className={cn(
                    'inline-block h-2 w-2 rounded-full bg-[--color-good]',
                    'animate-pulse',
                  )}
                  aria-hidden
                />
                Live
              </span>
              <span className="font-mono tabular-nums text-sm text-ink">
                {formatElapsed(now - started)}
              </span>
            </div>

            <div className="mt-2 flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 text-ink-mute" aria-hidden />
              <span className="truncate text-sm font-medium text-ink">
                {c.contact_name || 'Unknown'}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-dim">
              {c.segment && (
                <span className="inline-flex items-center rounded-md border border-line bg-[--color-panel-hi] px-1.5 py-0.5">
                  {c.segment}
                </span>
              )}
              <span className="inline-flex items-center gap-1 font-mono">
                <PhoneCall className="h-3 w-3 text-ink-mute" aria-hidden />
                {maskPhone(c.phone_e164)}
              </span>
              {agent && <span className="text-ink-mute">→ {agent}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
