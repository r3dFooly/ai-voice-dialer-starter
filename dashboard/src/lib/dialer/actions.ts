'use server';

// Dialer server actions. All gated by requireAdmin() — admin-only.
// Writes via service role; auth gate is the security boundary.

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth/gate';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import {
  DIALER_SETTING_KEYS,
  RETRY_FIELD_BOUNDS,
  type ActiveCall,
  type DialerSettings,
  type RetryFieldKey,
} from './types';
import { fetchRetryTierSettings, valueTypeFor } from './settings';
import { listActiveCalls } from './queries';

// Live-calls poll for the dashboard board. Admin-gated read; returns the calls
// the dialer is on right now. Safe to call on a short client interval.
export async function getActiveCalls(): Promise<ActiveCall[]> {
  await requireAdmin();
  return listActiveCalls();
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type SettingRow = {
  setting_key: string;
  setting_value: string;
  value_type: string;
  effective_from: string;
  updated_at: string;
};

async function upsertSettings(rows: SettingRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('agency_settings')
    .upsert(rows, { onConflict: 'setting_key,effective_from' });
  if (error) throw new Error(error.message);
}

function settingRow(
  key: string,
  value: string,
  effective_from = todayIso(),
): SettingRow {
  // updated_at MUST be set explicitly: the onConflict upsert overwrites an
  // existing (key, effective_from) row's value but the table has no updated_at
  // trigger, so without this a same-day re-save (e.g. toggling the dialer on)
  // left updated_at stale at the row's first write — making the change look
  // like it never happened and masking which value is current.
  return {
    setting_key: key,
    setting_value: value,
    value_type: valueTypeFor(key),
    effective_from,
    updated_at: new Date().toISOString(),
  };
}

export type UpdateDialerSettingsResult =
  | { ok: true }
  | { ok: false; error: string };

function validate(input: DialerSettings): string | null {
  if (typeof input.enabled !== 'boolean') return 'enabled must be boolean';
  if (!Array.isArray(input.operating_days)) return 'operating_days must be array';
  for (const d of input.operating_days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) return 'operating_days entries must be 0..6';
  }
  if (!/^\d{2}:\d{2}$/.test(input.hours_start)) return 'hours_start must be HH:MM';
  if (!/^\d{2}:\d{2}$/.test(input.hours_end)) return 'hours_end must be HH:MM';
  if (input.hours_start >= input.hours_end) return 'hours_start must be before hours_end';
  if (!Number.isFinite(input.daily_cap) || input.daily_cap < 0) return 'daily_cap must be >= 0';
  if (input.daily_cap > 10000) return 'daily_cap unreasonably high';
  if (!Number.isFinite(input.monthly_cap) || input.monthly_cap < 0) return 'monthly_cap must be >= 0';
  if (input.monthly_cap > 100000) return 'monthly_cap unreasonably high';
  if (!Array.isArray(input.blocked_dates)) return 'blocked_dates must be array';
  for (const s of input.blocked_dates) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return 'blocked_dates entries must be YYYY-MM-DD';
    }
  }
  return null;
}

export async function updateDialerSettings(
  input: DialerSettings,
): Promise<UpdateDialerSettingsResult> {
  await requireAdmin();
  const err = validate(input);
  if (err) return { ok: false, error: err };

  const rows: SettingRow[] = [
    settingRow(DIALER_SETTING_KEYS.enabled, input.enabled ? 'true' : 'false'),
    settingRow(DIALER_SETTING_KEYS.operating_days, JSON.stringify(input.operating_days)),
    settingRow(DIALER_SETTING_KEYS.hours_start, input.hours_start),
    settingRow(DIALER_SETTING_KEYS.hours_end, input.hours_end),
    settingRow(DIALER_SETTING_KEYS.daily_cap, String(input.daily_cap)),
    settingRow(DIALER_SETTING_KEYS.monthly_cap, String(input.monthly_cap)),
    settingRow(DIALER_SETTING_KEYS.blocked_dates, JSON.stringify(input.blocked_dates)),
  ];
  try {
    await upsertSettings(rows);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/dialer');
  return { ok: true };
}

export async function toggleDialerEnabled(
  enabled: boolean,
): Promise<UpdateDialerSettingsResult> {
  await requireAdmin();
  try {
    await upsertSettings([
      settingRow(DIALER_SETTING_KEYS.enabled, enabled ? 'true' : 'false'),
    ]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/dialer');
  return { ok: true };
}

export type QueueActionResult = { ok: true } | { ok: false; error: string };

export async function callNow(queueId: string): Promise<QueueActionResult> {
  await requireAdmin();
  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('retell_call_queue')
    .update({ priority_score: 100, next_attempt_at: new Date().toISOString() })
    .eq('id', queueId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}

export async function setQueueStatus(
  queueId: string,
  status: 'Skipped' | 'Removed' | 'DNC',
): Promise<QueueActionResult> {
  await requireAdmin();
  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('retell_call_queue')
    .update({ dialer_status: status })
    .eq('id', queueId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}

export async function rescheduleQueueRow(
  queueId: string,
  nextAttemptIso: string,
): Promise<QueueActionResult> {
  await requireAdmin();
  // Light validation — must parse to a real Date in the future or today.
  const d = new Date(nextAttemptIso);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'invalid datetime' };
  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('retell_call_queue')
    .update({ next_attempt_at: d.toISOString() })
    .eq('id', queueId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}

export async function bulkSetStatus(
  queueIds: string[],
  status: 'Removed' | 'DNC',
): Promise<QueueActionResult> {
  await requireAdmin();
  if (queueIds.length === 0) return { ok: false, error: 'no rows selected' };
  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('retell_call_queue')
    .update({ dialer_status: status })
    .in('id', queueIds);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}

// --- Retry settings --------------------------------------------------------

export type UpdateRetrySettingResult = { ok: true } | { ok: false; error: string };

/** Auto-save a single retry-tier / voicemail setting on blur. Validates against
 *  RETRY_FIELD_BOUNDS (integer, within the field's min/max). One row per key. */
export async function updateRetrySetting(
  key: RetryFieldKey,
  value: number,
): Promise<UpdateRetrySettingResult> {
  await requireAdmin();
  const bounds = RETRY_FIELD_BOUNDS[key];
  if (!bounds) return { ok: false, error: `unknown setting ${key}` };
  if (!Number.isInteger(value)) return { ok: false, error: 'value must be a whole number' };
  if (value < bounds.min || value > bounds.max) {
    return { ok: false, error: `must be between ${bounds.min} and ${bounds.max}` };
  }
  try {
    await upsertSettings([
      { setting_key: key, setting_value: String(value), value_type: 'Number', effective_from: todayIso(), updated_at: new Date().toISOString() },
    ]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath('/dialer');
  return { ok: true };
}

// --- Queue row actions -----------------------------------------------------

/** Bump a row to the top of the queue without touching its schedule. */
export async function moveToTop(queueId: string): Promise<QueueActionResult> {
  await requireAdmin();
  const sb = getSupabaseServiceClient();
  const { error } = await sb
    .from('retell_call_queue')
    .update({ priority_score: 100, updated_at: new Date().toISOString() })
    .eq('id', queueId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}

/** Zero the attempt + voicemail counters so an exhausted lead re-enters
 *  rotation. Leaves DNC / Removed rows out of rotation (status untouched);
 *  otherwise resets to Pending and schedules an immediate next attempt. */
export async function resetAttempts(queueId: string): Promise<QueueActionResult> {
  await requireAdmin();
  const sb = getSupabaseServiceClient();
  const { data: row, error: readErr } = await sb
    .from('retell_call_queue')
    .select('dialer_status')
    .eq('id', queueId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: 'queue row not found' };

  const now = new Date().toISOString();
  const reactivate = row.dialer_status !== 'DNC' && row.dialer_status !== 'Removed';
  const patch: Record<string, unknown> = {
    daily_attempt_count: 0,
    monthly_attempt_count: 0,
    total_attempt_count: 0,
    vm_count: 0,
    updated_at: now,
  };
  if (reactivate) {
    patch.dialer_status = 'Pending';
    patch.next_attempt_at = now;
  }
  const { error } = await sb.from('retell_call_queue').update(patch).eq('id', queueId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}

/** Re-tier a lead: copy the chosen tier's caps onto the row so the worker
 *  dials it under that profile. lifetime_max maps to max_total_attempts. */
export async function changeTier(
  queueId: string,
  tier: 1 | 2 | 3,
): Promise<QueueActionResult> {
  await requireAdmin();
  const sb = getSupabaseServiceClient();
  const settings = await fetchRetryTierSettings(sb);
  const cfg = tier === 1 ? settings.tier1 : tier === 2 ? settings.tier2 : settings.tier3;
  const { error } = await sb
    .from('retell_call_queue')
    .update({
      max_daily_attempts: cfg.daily_max,
      max_monthly_attempts: cfg.monthly_max,
      max_total_attempts: cfg.lifetime_max,
      cool_down_hours: cfg.cooldown_hours,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queueId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dialer');
  return { ok: true };
}
