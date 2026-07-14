'use strict';
// Pure calling-window check. Given a lead's timezone and the configured hours,
// operating-days, and blocked-dates, decide whether NOW is an allowed time to
// call. Used only when the compliance module is enabled.
function parseHhmm(s, dflt) {
  if (!s) return dflt;
  const parts = String(s).split(':').map(Number);
  const h = Number.isFinite(parts[0]) ? parts[0] : dflt;
  const m = Number.isFinite(parts[1]) ? parts[1] / 60 : 0;
  return h + m;
}

function isWithinCallingWindow(leadRow, settings = {}) {
  const tz = (leadRow && leadRow.lead_timezone) || 'America/New_York';
  // Reinterpret "now" in the lead's local timezone.
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const hourFloat = local.getHours() + local.getMinutes() / 60;

  const start = parseHhmm(settings.hoursStart, 9);
  const end = parseHhmm(settings.hoursEnd, 20);
  if (hourFloat < start || hourFloat > end) return false;

  const days = Array.isArray(settings.operatingDays) ? settings.operatingDays : [1, 2, 3, 4, 5];
  if (!days.includes(local.getDay())) return false;

  const isoDate = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const blocked = Array.isArray(settings.blockedDates) ? settings.blockedDates : [];
  if (blocked.includes(isoDate)) return false;

  return true;
}

module.exports = { isWithinCallingWindow };
