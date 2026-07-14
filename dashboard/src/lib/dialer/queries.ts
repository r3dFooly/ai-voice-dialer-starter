// Server-side queries for the Dialer tab. Admin-only — requireAdmin() gates the
// page so service-role reads are safe here.

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import type {
  ActiveCall,
  CallHistoryRow,
  DailySpendPoint,
  DialerTier,
  QueueFilters,
  QueueRow,
  QueueStats,
  RetrySettings,
} from './types';

export type SortDir = 'asc' | 'desc';
export type SortSpec = { col: string; dir: SortDir } | null;

// UI sort key -> DB column. Whitelisted so a URL param can never order by an
// arbitrary/unsafe column.
const QUEUE_SORT_COLUMNS: Record<string, string> = {
  priority: 'priority_score',
  status: 'dialer_status',
  attempts: 'total_attempt_count',
  vm: 'vm_count',
  lastcalled: 'last_attempt_at',
  nextattempt: 'next_attempt_at',
  name: 'contact_name',
  created: 'created_at',
};
const HISTORY_SORT_COLUMNS: Record<string, string> = {
  date: 'created_at',
  duration: 'duration_seconds',
  cost: 'cost_cents',
  disposition: 'disposition',
  direction: 'call_direction',
  recording: 'recording_url',
  bant: 'bant_score',
  sentiment: 'sentiment',
};
// Statuses that mean the lead has left the live queue — hidden from the default
// "Active queue" view (they show only when explicitly filtered to that status).
const TERMINAL_QUEUE_STATUSES = '(Removed,Completed,DNC,Transferred,Skipped)';

// Tier is not a stored column — derive it from the row's own cap profile
// (the worker seeds max_daily_attempts / cool_down_hours per tier at enqueue).
// (daily, cooldown) uniquely identifies tiers 1/2/3 under the default settings.
// Anything that matches no tier profile is Tier 4 (Other / uncategorized).
function deriveTier(
  row: { max_daily_attempts: number; cool_down_hours: number },
  retry: RetrySettings,
): DialerTier {
  const matches = (t: { daily_max: number; cooldown_hours: number }) =>
    row.max_daily_attempts === t.daily_max && row.cool_down_hours === t.cooldown_hours;
  if (matches(retry.tier1)) return 1;
  if (matches(retry.tier2)) return 2;
  if (matches(retry.tier3)) return 3;
  return 4;
}

const QUEUE_SELECT =
  'id, contact_name, phone_e164, dialer_status, source, assigned_agent, priority_score, ' +
  'next_attempt_at, created_at, segment, product_interest, daily_attempt_count, ' +
  'monthly_attempt_count, total_attempt_count, max_daily_attempts, max_monthly_attempts, ' +
  'max_total_attempts, cool_down_hours, vm_count, last_attempt_at, ' +
  'consent_verified, dnc_checked, lead_context';

type RawQueueRow = Omit<QueueRow, 'tier' | 'exhausted'>;

export async function fetchSpendToday(): Promise<number> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb.rpc('get_retell_spend_today');
  if (error) throw new Error(`fetchSpendToday: ${error.message}`);
  return Number(data ?? 0);
}

export async function fetchSpendMonth(): Promise<number> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb.rpc('get_retell_spend_month');
  if (error) throw new Error(`fetchSpendMonth: ${error.message}`);
  return Number(data ?? 0);
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function fetchCallsTodayCount(): Promise<number> {
  const sb = getSupabaseServiceClient();
  const { count, error } = await sb
    .from('retell_call_log')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', startOfTodayIso());
  if (error) throw new Error(`fetchCallsTodayCount: ${error.message}`);
  return count ?? 0;
}

export async function fetchAvgDurationToday(): Promise<number> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb
    .from('retell_call_log')
    .select('duration_seconds')
    .gte('created_at', startOfTodayIso());
  if (error) throw new Error(`fetchAvgDurationToday: ${error.message}`);
  const rows = (data ?? []) as { duration_seconds: number | null }[];
  let total = 0;
  let n = 0;
  for (const r of rows) {
    if (typeof r.duration_seconds === 'number') {
      total += r.duration_seconds;
      n += 1;
    }
  }
  return n === 0 ? 0 : Math.round(total / n);
}

/** Spend per day for the last 14 days. Missing days are filled with 0. */
export async function fetchDailySpendSeries(days = 14): Promise<DailySpendPoint[]> {
  const sb = getSupabaseServiceClient();
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));

  const { data, error } = await sb
    .from('retell_call_log')
    .select('created_at, cost_cents')
    .gte('created_at', from.toISOString());
  if (error) throw new Error(`fetchDailySpendSeries: ${error.message}`);

  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of (data ?? []) as { created_at: string; cost_cents: number | null }[]) {
    const day = row.created_at.slice(0, 10);
    if (!buckets.has(day)) continue;
    buckets.set(day, (buckets.get(day) ?? 0) + (row.cost_cents ?? 0) / 100);
  }

  return Array.from(buckets.entries()).map(([day, spend]) => ({
    day,
    spend: Math.round(spend * 100) / 100,
  }));
}

export async function listQueue(
  filters: QueueFilters = {},
  retry: RetrySettings,
  page = 1,
  pageSize = 20,
  sort: SortSpec = null,
): Promise<{ rows: QueueRow[]; total: number }> {
  const sb = getSupabaseServiceClient();
  let q = sb.from('retell_call_queue').select(QUEUE_SELECT, { count: 'exact' });

  if (filters.status && filters.status !== 'all') {
    q = q.eq('dialer_status', filters.status);
  } else {
    // Default "Active queue" hides terminal rows (Removed/Completed/DNC/...), so
    // retired + test leads don't clutter the live view. Choosing a specific
    // status in the filter still surfaces them.
    q = q.not('dialer_status', 'in', TERMINAL_QUEUE_STATUSES);
  }
  if (filters.source && filters.source !== 'all') {
    q = q.eq('source', filters.source);
  }
  if (filters.start_date) {
    q = q.gte('created_at', `${filters.start_date}T00:00:00Z`);
  }
  if (filters.end_date) {
    q = q.lte('created_at', `${filters.end_date}T23:59:59Z`);
  }

  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;

  const sortCol = sort && QUEUE_SORT_COLUMNS[sort.col];
  let ordered = q;
  if (sortCol) {
    ordered = ordered
      .order(sortCol, { ascending: sort!.dir === 'asc', nullsFirst: false })
      .order('id', { ascending: true }); // stable tiebreak for pagination
  } else {
    ordered = ordered
      .order('priority_score', { ascending: false })
      .order('next_attempt_at', { ascending: true });
  }

  const { data, error, count } = await ordered.range(from, to);
  if (error) throw new Error(`listQueue: ${error.message}`);

  // Cast through unknown: a non-literal .select() arg makes supabase-js infer
  // GenericStringError[] rather than the row shape.
  const rows = ((data ?? []) as unknown as RawQueueRow[]).map((r) => ({
    ...r,
    tier: deriveTier(r, retry),
    exhausted: r.total_attempt_count >= r.max_total_attempts,
  }));
  return { rows, total: count ?? rows.length };
}

/** Average cost per logged call over the trailing window, in dollars. Used to
 *  estimate calls remaining under the daily spend cap. Returns 0 when there is
 *  no cost data to average. */
export async function fetchAvgCallCost(days = 14): Promise<number> {
  const sb = getSupabaseServiceClient();
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  const { data, error } = await sb
    .from('retell_call_log')
    .select('cost_cents')
    .gte('created_at', from.toISOString())
    .not('cost_cents', 'is', null);
  if (error) throw new Error(`fetchAvgCallCost: ${error.message}`);
  const rows = (data ?? []) as { cost_cents: number | null }[];
  let total = 0;
  let n = 0;
  for (const r of rows) {
    if (typeof r.cost_cents === 'number' && r.cost_cents > 0) {
      total += r.cost_cents;
      n += 1;
    }
  }
  return n === 0 ? 0 : total / 100 / n;
}

/** Aggregate counts for the queue stats bar. Counts every row (ignores the
 *  page's display filters by design — the bar reflects the whole queue). */
export async function fetchQueueStats(args: {
  retry: RetrySettings;
  dailyCap: number;
  spendToday: number;
  avgCallCost: number;
}): Promise<QueueStats> {
  const { retry, dailyCap, spendToday, avgCallCost } = args;
  const sb = getSupabaseServiceClient();

  const { data, error } = await sb
    .from('retell_call_queue')
    .select('dialer_status, max_daily_attempts, cool_down_hours')
    .limit(5000);
  if (error) throw new Error(`fetchQueueStats: ${error.message}`);

  const rows = (data ?? []) as {
    dialer_status: string;
    max_daily_attempts: number;
    cool_down_hours: number;
  }[];

  let pending = 0;
  let in_progress = 0;
  let tier1 = 0;
  let tier2 = 0;
  let tier3 = 0;
  for (const r of rows) {
    if (r.dialer_status === 'Pending') pending += 1;
    else if (r.dialer_status === 'In_Progress') in_progress += 1;
    const t = deriveTier(r, retry);
    if (t === 1) tier1 += 1;
    else if (t === 2) tier2 += 1;
    else if (t === 3) tier3 += 1;
  }

  const { count: completedToday, error: cErr } = await sb
    .from('retell_call_queue')
    .select('id', { count: 'exact', head: true })
    .eq('dialer_status', 'Completed')
    .gte('updated_at', startOfTodayIso());
  if (cErr) throw new Error(`fetchQueueStats(completed): ${cErr.message}`);

  const budgetLeft = Math.max(0, dailyCap - spendToday);
  const calls_remaining_today =
    dailyCap > 0 && avgCallCost > 0 ? Math.floor(budgetLeft / avgCallCost) : 0;

  return {
    total: rows.length,
    pending,
    in_progress,
    completed_today: completedToday ?? 0,
    tier1,
    tier2,
    tier3,
    calls_remaining_today,
  };
}

export async function listQueueSources(): Promise<string[]> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb.from('retell_call_queue').select('source');
  if (error) throw new Error(`listQueueSources: ${error.message}`);
  const set = new Set<string>();
  for (const r of (data ?? []) as { source: string | null }[]) {
    if (r.source) set.add(r.source);
  }
  return Array.from(set).sort();
}

// Calls the dialer is on RIGHT NOW: queue rows the scheduler flipped to
// In_Progress at dial time. Read-only from existing tables (no transcript).
const ACTIVE_CALL_SELECT =
  'id, contact_name, segment, product_interest, phone_e164, from_number, ' +
  'assigned_agent, provider_call_id, last_attempt_at';

export async function listActiveCalls(): Promise<ActiveCall[]> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb
    .from('retell_call_queue')
    .select(ACTIVE_CALL_SELECT)
    .eq('dialer_status', 'In_Progress')
    .order('last_attempt_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw new Error(`listActiveCalls: ${error.message}`);
  return (data ?? []) as unknown as ActiveCall[];
}

const CALL_LOG_SELECT =
  'id, provider_call_id, queue_id, created_at, duration_seconds, cost_cents, bant_score, ' +
  'disposition, sentiment, recording_url, transcript, call_summary, from_number, to_number, ' +
  'call_direction, disconnection_reason, transferred_to_agent, transfer_outcome';

type RawCallLogRow = Omit<CallHistoryRow, 'contact_name' | 'dnc_flagged'>;

// Disconnect reasons that mean the call was NOT answered by a person — used by
// the "Connected only" filter to exclude voicemail / no-answer / failed dials.
const UNCONNECTED_REASONS = '(voicemail_reached,dial_no_answer,dial_failed,dial_busy)';

export type CallHistoryFilters = {
  disposition?: string | null;
  connected?: boolean;
  minDuration?: number | null;
};

export async function listCallHistory(
  page = 1,
  pageSize = 25,
  direction: 'inbound' | 'outbound' | null = null,
  filters: CallHistoryFilters = {},
  sort: SortSpec = null,
): Promise<{ rows: CallHistoryRow[]; total: number }> {
  const sb = getSupabaseServiceClient();
  const from = Math.max(0, (page - 1) * pageSize);
  const to = from + pageSize - 1;

  let q = sb.from('retell_call_log').select(CALL_LOG_SELECT, { count: 'exact' });
  if (direction) q = q.eq('call_direction', direction);
  if (filters.disposition) q = q.eq('disposition', filters.disposition);
  if (filters.connected) q = q.not('disconnection_reason', 'in', UNCONNECTED_REASONS);
  if (filters.minDuration && filters.minDuration > 0) {
    q = q.gte('duration_seconds', filters.minDuration);
  }

  const sortCol = sort && HISTORY_SORT_COLUMNS[sort.col];
  if (sortCol) {
    q = q
      .order(sortCol, { ascending: sort!.dir === 'asc', nullsFirst: false })
      .order('created_at', { ascending: false }); // stable tiebreak
  } else {
    q = q.order('created_at', { ascending: false });
  }

  const { data, error, count } = await q.range(from, to);
  if (error) throw new Error(`listCallHistory: ${error.message}`);

  const rows = (data ?? []) as unknown as RawCallLogRow[];
  const queueIds = Array.from(
    new Set(rows.map((r) => r.queue_id).filter((qid): qid is string => !!qid)),
  );

  // Join contact name + DNC flag from the originating queue row.
  const metaById = new Map<string, { name: string | null; dnc: boolean }>();
  if (queueIds.length > 0) {
    const { data: qd, error: qe } = await sb
      .from('retell_call_queue')
      .select('id, contact_name, dnc_checked, dialer_status')
      .in('id', queueIds);
    if (qe) throw new Error(`listCallHistory(join): ${qe.message}`);
    for (const r of (qd ?? []) as {
      id: string;
      contact_name: string | null;
      dnc_checked: boolean;
      dialer_status: string;
    }[]) {
      metaById.set(r.id, {
        name: r.contact_name,
        dnc: r.dnc_checked || r.dialer_status === 'DNC',
      });
    }
  }

  return {
    rows: rows.map((r) => {
      const meta = r.queue_id ? metaById.get(r.queue_id) : undefined;
      return {
        ...r,
        contact_name: meta?.name ?? null,
        dnc_flagged: meta?.dnc ?? false,
      };
    }),
    total: count ?? rows.length,
  };
}
