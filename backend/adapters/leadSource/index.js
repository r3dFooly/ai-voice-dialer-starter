'use strict';
// LeadSource adapter contract — makes the dialer CRM-agnostic. The scheduler and
// server talk to leads ONLY through this interface. The default 'supabase'
// adapter treats retell_call_queue as the system of record. Set LEAD_SOURCE=ghl
// (and implement ghl.stub.js) to pull leads from / write results back to a CRM.
//
// Interface (all async unless noted):
//   client                       raw supabase client (shared reads/writes)
//   fetchCandidates({ limit })   -> queueRow[]   Pending + due, priority order
//   updateQueueRow(id, patch)    -> void
//   recordCallLog(row)           -> void         insert into retell_call_log
//   ingestLead(payload)          -> { id }       normalize + insert a new lead
//   markDnc(phone, reason)       -> void
//   writeback(queueRow, outcome) -> void         push result to external CRM (no-op for supabase)
const { config } = require('../../config');

let _adapter = null;
function getLeadSource() {
  if (_adapter) return _adapter;
  const kind = String(config.leadSource || 'supabase').toLowerCase();
  _adapter = kind === 'ghl' ? require('./ghl.stub') : require('./supabase');
  return _adapter;
}

module.exports = { getLeadSource };
