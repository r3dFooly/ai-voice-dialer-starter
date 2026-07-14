'use strict';
// Compliance façade. DISABLED by default (COMPLIANCE_MODULE_ENABLED=false) so the
// starter is a BARE dialer — every lead passes. ENABLED -> enforces DNC + calling
// window at the app layer. You must ALSO apply migration 0007 for the matching
// DB-level consent/window gate inside is_lead_callable(). See COMPLIANCE-MODULE.md.
//
// ⚠️ US outbound telemarketing is subject to the TCPA (quiet hours, DNC, consent)
// with statutory damages of $500–$1,500 PER CALL. This module is a starting
// point, not legal advice — own your compliance posture before dialing at scale.
const { config } = require('../config');
const { isWithinCallingWindow } = require('./callingWindow');
const { isDnc } = require('./dnc');

const enabled = config.compliance.enabled;

// leadRow: the retell_call_queue row. settings: { hoursStart, hoursEnd,
// operatingDays[], blockedDates[] } (parsed from agency_settings by the caller).
async function checkLead(leadRow, settings = {}) {
  if (!enabled) return { ok: true };
  if (await isDnc(leadRow.phone_e164)) return { ok: false, reason: 'dnc' };
  if (!isWithinCallingWindow(leadRow, settings)) return { ok: false, reason: 'outside_window' };
  return { ok: true };
}

module.exports = { enabled, checkLead };
