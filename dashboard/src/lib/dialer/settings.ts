// Helpers for reading + writing dialer-related agency_settings rows.
// Each setting is its own key. We pick the most recent effective_from ≤ today
// to mirror the sales-targets read pattern; older rows linger as history.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_DIALER_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
  DIALER_SETTING_KEYS,
  RETRY_FIELD_BOUNDS,
  type DialerSettings,
  type RetrySettings,
} from './types';

const RETRY_KEYS = Object.keys(RETRY_FIELD_BOUNDS);

const KEYS = Object.values(DIALER_SETTING_KEYS);

type RawRow = {
  setting_key: string;
  setting_value: string;
  effective_from: string | null;
};

function parseBoolean(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseTime(raw: string, fallback: string): string {
  // Expect "HH:MM" or "HH:MM:SS" — normalize to HH:MM.
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hh = match[1].padStart(2, '0');
  return `${hh}:${match[2]}`;
}

function parseNumber(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Read all dialer settings, picking the most-recent value per key. */
export async function fetchDialerSettings(sb: SupabaseClient): Promise<DialerSettings> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('agency_settings')
    .select('setting_key, setting_value, effective_from')
    .in('setting_key', KEYS)
    .order('effective_from', { ascending: false });
  if (error) throw new Error(`fetchDialerSettings: ${error.message}`);

  const out: DialerSettings = { ...DEFAULT_DIALER_SETTINGS };
  const seen = new Set<string>();
  for (const r of (data ?? []) as RawRow[]) {
    if (seen.has(r.setting_key)) continue;
    if (r.effective_from && r.effective_from > today) continue;
    seen.add(r.setting_key);
    switch (r.setting_key) {
      case DIALER_SETTING_KEYS.enabled:
        out.enabled = parseBoolean(r.setting_value);
        break;
      case DIALER_SETTING_KEYS.operating_days:
        out.operating_days = parseJsonArray<number>(r.setting_value).filter(
          (n) => Number.isInteger(n) && n >= 0 && n <= 6,
        );
        break;
      case DIALER_SETTING_KEYS.hours_start:
        out.hours_start = parseTime(r.setting_value, DEFAULT_DIALER_SETTINGS.hours_start);
        break;
      case DIALER_SETTING_KEYS.hours_end:
        out.hours_end = parseTime(r.setting_value, DEFAULT_DIALER_SETTINGS.hours_end);
        break;
      case DIALER_SETTING_KEYS.daily_cap:
        out.daily_cap = parseNumber(r.setting_value, DEFAULT_DIALER_SETTINGS.daily_cap);
        break;
      case DIALER_SETTING_KEYS.monthly_cap:
        out.monthly_cap = parseNumber(r.setting_value, DEFAULT_DIALER_SETTINGS.monthly_cap);
        break;
      case DIALER_SETTING_KEYS.blocked_dates:
        out.blocked_dates = parseJsonArray<string>(r.setting_value).filter(
          (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s),
        );
        break;
    }
  }
  return out;
}

/** Read retry-tier + voicemail settings (retell_tier* / retell_vm* keys),
 *  picking the most-recent value per key. Falls back to DEFAULT_RETRY_SETTINGS
 *  for any key absent from agency_settings. */
export async function fetchRetryTierSettings(sb: SupabaseClient): Promise<RetrySettings> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('agency_settings')
    .select('setting_key, setting_value, effective_from')
    .in('setting_key', RETRY_KEYS)
    .order('effective_from', { ascending: false });
  if (error) throw new Error(`fetchRetryTierSettings: ${error.message}`);

  // most-recent (≤ today) value per key
  const latest = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of (data ?? []) as RawRow[]) {
    if (seen.has(r.setting_key)) continue;
    if (r.effective_from && r.effective_from > today) continue;
    seen.add(r.setting_key);
    const n = Number(r.setting_value);
    if (Number.isFinite(n)) latest.set(r.setting_key, n);
  }

  const pick = (key: string, fallback: number) => latest.get(key) ?? fallback;
  const d = DEFAULT_RETRY_SETTINGS;
  return {
    tier1: {
      daily_max: pick('retell_tier1_daily_max', d.tier1.daily_max),
      monthly_max: pick('retell_tier1_monthly_max', d.tier1.monthly_max),
      lifetime_max: pick('retell_tier1_lifetime_max', d.tier1.lifetime_max),
      cooldown_hours: pick('retell_tier1_cooldown_hours', d.tier1.cooldown_hours),
      decay_days: pick('retell_tier1_decay_days', d.tier1.decay_days),
    },
    tier2: {
      daily_max: pick('retell_tier2_daily_max', d.tier2.daily_max),
      monthly_max: pick('retell_tier2_monthly_max', d.tier2.monthly_max),
      lifetime_max: pick('retell_tier2_lifetime_max', d.tier2.lifetime_max),
      cooldown_hours: pick('retell_tier2_cooldown_hours', d.tier2.cooldown_hours),
    },
    tier3: {
      daily_max: pick('retell_tier3_daily_max', d.tier3.daily_max),
      monthly_max: pick('retell_tier3_monthly_max', d.tier3.monthly_max),
      lifetime_max: pick('retell_tier3_lifetime_max', d.tier3.lifetime_max),
      cooldown_hours: pick('retell_tier3_cooldown_hours', d.tier3.cooldown_hours),
    },
    vm: {
      max_per_day: pick('retell_vm_max_per_day', d.vm.max_per_day),
      max_lifetime: pick('retell_vm_max_lifetime', d.vm.max_lifetime),
    },
  };
}

// agency_settings.value_type carries a CHECK constraint that accepts ONLY
// 'Currency' | 'Percent' | 'Number' | 'Text'. Writing 'Boolean'/'JSON'/'Time'/
// 'String' (the natural shapes for these keys) violates that constraint, so the
// dialer-settings upsert was rejected and Save never persisted. value_type is
// descriptive metadata only — every reader (dashboard fetchDialerSettings and
// the scheduler) parses by setting_key, never by value_type — so we map each
// key to an allowed type and keep the underlying string serialization intact:
// booleans as "true"/"false", JSON arrays as their JSON text, times as "HH:MM".
// This matches the value_types on the rows seeded for these keys.
export function valueTypeFor(key: string): string {
  switch (key) {
    case DIALER_SETTING_KEYS.daily_cap:
    case DIALER_SETTING_KEYS.monthly_cap:
      return 'Currency';
    default:
      return 'Text';
  }
}
