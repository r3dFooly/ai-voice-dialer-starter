// /dialer — admin-only voice dialer console. The full control surface for the
// outbound dialer: master controls + spend caps, retry-tier settings, spend
// metrics, queue stats, the active queue, and call history with post-call
// analysis.
//
// Filters + pagination live in the URL so deep links survive a reload. The
// page is force-dynamic and auto-refreshes every 10s on the client.

import { Phone } from 'lucide-react';

import { PageHeader } from '@/components/ui-legacy';
import { requireTab } from '@/lib/auth/gate';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { APP_NAME } from '@/lib/config';
import { fetchDialerSettings, fetchRetryTierSettings } from '@/lib/dialer/settings';
import {
  fetchAvgCallCost,
  fetchAvgDurationToday,
  fetchCallsTodayCount,
  fetchDailySpendSeries,
  fetchQueueStats,
  fetchSpendMonth,
  fetchSpendToday,
  listActiveCalls,
  listCallHistory,
  listQueue,
  listQueueSources,
} from '@/lib/dialer/queries';
import { computeStatusIndicator } from '@/lib/dialer/status';
import {
  DEFAULT_DIALER_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
  DIALER_STATUSES,
  type QueueStats,
} from '@/lib/dialer/types';
import { ActiveQueueTable } from '@/components/dialer/ActiveQueueTable';
import { AutoRefresh } from '@/components/dialer/AutoRefresh';
import { CallHistoryTable } from '@/components/dialer/CallHistoryTable';
import { CallHistoryFilterBar } from '@/components/dialer/CallHistoryFilterBar';
import { LiveCallsPanel } from '@/components/dialer/LiveCallsPanel';
import { DialerControls } from '@/components/dialer/DialerControls';
import { QueueFilterBar } from '@/components/dialer/QueueFilterBar';
import { QueueStatsBar } from '@/components/dialer/QueueStatsBar';
import { RetrySettingsPanel } from '@/components/dialer/RetrySettingsPanel';
import { SpendTracker } from '@/components/dialer/SpendTracker';

export const dynamic = 'force-dynamic';
export const metadata = { title: `Dialer | ${APP_NAME}` };

const PAGE_SIZE = 25;
const QUEUE_PAGE_SIZE = 20;

type SP = {
  status?: string;
  source?: string;
  start?: string;
  end?: string;
  page?: string;
  qpage?: string;
  dir?: string;
  disposition?: string;
  conn?: string;
  minlen?: string;
  hsort?: string;
  hord?: string;
  qsort?: string;
  qord?: string;
};

function parseSort(col: string | undefined, ord: string | undefined) {
  if (!col) return null;
  return { col, dir: ord === 'asc' ? ('asc' as const) : ('desc' as const) };
}

function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function parseStatus(raw: string | undefined): string | undefined {
  if (!raw || raw === 'all') return undefined;
  return (DIALER_STATUSES as readonly string[]).includes(raw) ? raw : undefined;
}

function parseIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

function parseDir(raw: string | undefined): 'all' | 'outbound' | 'inbound' {
  if (raw === 'outbound' || raw === 'inbound') return raw;
  return 'all';
}

export default async function DialerPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  await requireTab('dialer');
  const sp = await searchParams;

  const sb = await getSupabaseServerClient();

  const queueFilters = {
    status: parseStatus(sp.status),
    source: sp.source && sp.source !== 'all' ? sp.source : undefined,
    start_date: parseIsoDate(sp.start),
    end_date: parseIsoDate(sp.end),
  };
  const page = parsePage(sp.page);
  const queuePage = parsePage(sp.qpage);
  const dir = parseDir(sp.dir);
  const historyDir = dir === 'all' ? null : dir;
  const historyFilters = {
    disposition: typeof sp.disposition === 'string' && sp.disposition ? sp.disposition : null,
    connected: sp.conn === 'connected',
    minDuration: sp.minlen && Number.isFinite(Number(sp.minlen)) ? Number(sp.minlen) : null,
  };
  const historySort = parseSort(sp.hsort, sp.hord);
  const queueSort = parseSort(sp.qsort, sp.qord);

  const errors: string[] = [];

  // Round 1 — independent reads. Queue + stats depend on the retry settings
  // and today's spend resolved here, so they run in round 2.
  let settings = { ...DEFAULT_DIALER_SETTINGS };
  let retry = { ...DEFAULT_RETRY_SETTINGS };
  let spendToday = 0;
  let spendMonth = 0;
  let callsToday = 0;
  let avgDuration = 0;
  let avgCallCost = 0;
  let series: Awaited<ReturnType<typeof fetchDailySpendSeries>> = [];
  let sources: string[] = [];
  let history: Awaited<ReturnType<typeof listCallHistory>> = { rows: [], total: 0 };
  let activeCalls: Awaited<ReturnType<typeof listActiveCalls>> = [];

  const [
    settingsR,
    retryR,
    spendTodayR,
    spendMonthR,
    callsTodayR,
    avgDurR,
    avgCostR,
    seriesR,
    sourcesR,
    historyR,
    activeCallsR,
  ] = await Promise.allSettled([
    fetchDialerSettings(sb),
    fetchRetryTierSettings(sb),
    fetchSpendToday(),
    fetchSpendMonth(),
    fetchCallsTodayCount(),
    fetchAvgDurationToday(),
    fetchAvgCallCost(),
    fetchDailySpendSeries(14),
    listQueueSources(),
    listCallHistory(page, PAGE_SIZE, historyDir, historyFilters, historySort),
    listActiveCalls(),
  ]);

  if (settingsR.status === 'fulfilled') settings = settingsR.value;
  else errors.push(`settings: ${settingsR.reason}`);
  if (retryR.status === 'fulfilled') retry = retryR.value;
  else errors.push(`retry_settings: ${retryR.reason}`);
  if (spendTodayR.status === 'fulfilled') spendToday = spendTodayR.value;
  else errors.push(`spend_today: ${spendTodayR.reason}`);
  if (spendMonthR.status === 'fulfilled') spendMonth = spendMonthR.value;
  else errors.push(`spend_month: ${spendMonthR.reason}`);
  if (callsTodayR.status === 'fulfilled') callsToday = callsTodayR.value;
  else errors.push(`calls_today: ${callsTodayR.reason}`);
  if (avgDurR.status === 'fulfilled') avgDuration = avgDurR.value;
  else errors.push(`avg_duration: ${avgDurR.reason}`);
  if (avgCostR.status === 'fulfilled') avgCallCost = avgCostR.value;
  else errors.push(`avg_cost: ${avgCostR.reason}`);
  if (seriesR.status === 'fulfilled') series = seriesR.value;
  else errors.push(`series: ${seriesR.reason}`);
  if (sourcesR.status === 'fulfilled') sources = sourcesR.value;
  else errors.push(`sources: ${sourcesR.reason}`);
  if (historyR.status === 'fulfilled') history = historyR.value;
  else errors.push(`history: ${historyR.reason}`);
  if (activeCallsR.status === 'fulfilled') activeCalls = activeCallsR.value;
  else errors.push(`active_calls: ${activeCallsR.reason}`);

  // Round 2 — queue + aggregate stats (depend on round-1 values).
  let queue: Awaited<ReturnType<typeof listQueue>> = { rows: [], total: 0 };
  let stats: QueueStats | null = null;

  const [queueR, statsR] = await Promise.allSettled([
    listQueue(queueFilters, retry, queuePage, QUEUE_PAGE_SIZE, queueSort),
    fetchQueueStats({ retry, dailyCap: settings.daily_cap, spendToday, avgCallCost }),
  ]);

  if (queueR.status === 'fulfilled') queue = queueR.value;
  else errors.push(`queue: ${queueR.reason}`);
  if (statsR.status === 'fulfilled') stats = statsR.value;
  else errors.push(`queue_stats: ${statsR.reason}`);

  const statusIndicator = computeStatusIndicator({ settings, spendToday, spendMonth });

  return (
    <div className="space-y-6">
      <AutoRefresh intervalMs={10_000} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-[--color-panel-hi] text-[--color-teal]"
          >
            <Phone className="h-4 w-4" />
          </span>
          <PageHeader
            title="Dialer"
            hint="Voice dialer — controls, retry policy, spend, queue, and call history."
          />
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-lg border border-[--color-danger]/40 bg-[--color-danger]/10 p-3 text-xs text-[--color-danger]">
          <div className="font-semibold">Some panels failed to load</div>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e, i) => (
              <li key={i} className="font-mono">{e}</li>
            ))}
          </ul>
        </div>
      )}

      <DialerControls
        initial={settings}
        initialStatus={statusIndicator}
        spendToday={spendToday}
        spendMonth={spendMonth}
      />

      <RetrySettingsPanel initial={retry} />

      <SpendTracker
        spendToday={spendToday}
        spendMonth={spendMonth}
        callsToday={callsToday}
        avgDurationSeconds={avgDuration}
        dailyCap={settings.daily_cap}
        monthlyCap={settings.monthly_cap}
        series={series}
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[--tracking-label] text-ink-dim">
            Live calls
          </h2>
          <span className="text-xs text-ink-mute">on a call right now</span>
        </div>
        <LiveCallsPanel initial={activeCalls} />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[--tracking-label] text-ink-dim">
            Active queue
          </h2>
          <span className="text-xs text-ink-mute">
            {queue.total} active row(s) · click a column to sort
          </span>
        </div>
        {stats && <QueueStatsBar stats={stats} />}
        <QueueFilterBar sources={sources} />
        <ActiveQueueTable
          rows={queue.rows}
          total={queue.total}
          page={queuePage}
          pageSize={QUEUE_PAGE_SIZE}
          vmMaxLifetime={retry.vm.max_lifetime}
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[--tracking-label] text-ink-dim">
            Call history
          </h2>
          <CallHistoryFilterBar value={dir} />
        </div>
        <CallHistoryTable
          rows={history.rows}
          total={history.total}
          page={page}
          pageSize={PAGE_SIZE}
        />
      </section>
    </div>
  );
}
