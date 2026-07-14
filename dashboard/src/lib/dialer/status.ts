// Derives the runtime status badge from settings + spend. Pure function, used
// both server- and client-side so the indicator stays in sync after edits.

import type { DialerSettings, DialerStatusIndicator } from './types';

export function computeStatusIndicator(args: {
  settings: DialerSettings;
  spendToday: number;
  spendMonth: number;
  now?: Date;
}): DialerStatusIndicator {
  const { settings, spendToday, spendMonth } = args;
  const now = args.now ?? new Date();

  if (!settings.enabled) return 'paused';

  if (settings.daily_cap > 0 && spendToday >= settings.daily_cap) return 'cap_reached';
  if (settings.monthly_cap > 0 && spendMonth >= settings.monthly_cap) return 'cap_reached';

  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (settings.blocked_dates.includes(todayIso)) return 'outside_hours';

  if (!settings.operating_days.includes(now.getDay())) return 'outside_hours';

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (hhmm < settings.hours_start || hhmm > settings.hours_end) return 'outside_hours';

  return 'active';
}

export const STATUS_LABEL: Record<DialerStatusIndicator, string> = {
  active: 'Dialer Active',
  paused: 'Dialer Paused',
  outside_hours: 'Outside Hours',
  cap_reached: 'Cap Reached',
};
