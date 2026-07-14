'use strict';
// GoHighLevel LeadSource adapter — STUB. Implement the three TODO methods to
// pull leads from / write results back to GHL. Shapes mirror the supabase
// adapter so the scheduler/server need zero changes. Your local retell_call_queue
// is still the work queue; GHL only feeds ingest + receives writeback.
//
// Set LEAD_SOURCE=ghl once implemented, and add your GHL_* env vars.
const supa = require('./supabase');

function notImplemented(name) {
  throw new Error(`[leadSource:ghl] ${name}() not implemented — see adapters/leadSource/ghl.stub.js`);
}

module.exports = {
  client: supa.client,
  fetchCandidates: supa.fetchCandidates, // leads still drain from the local queue
  updateQueueRow: supa.updateQueueRow,
  recordCallLog: supa.recordCallLog,

  // TODO: create/lookup the GHL contact, then upsert into retell_call_queue.
  //   const contact = await ghlPost('/contacts/upsert', {...});
  //   return supa.ingestLead({ ...payload, external_lead_id: contact.id });
  async ingestLead(/* payload */) { return notImplemented('ingestLead'); },

  // TODO: PATCH the GHL contact / add a note with disposition + bant + sentiment.
  //   await ghlPatch(`/contacts/${queueRow.external_lead_id}`, { customFields: {...} });
  async writeback(/* queueRow, outcome */) { return notImplemented('writeback'); },

  // TODO: add the GHL DNC tag, then suppress locally too.
  async markDnc(phone, reason) { return supa.markDnc(phone, reason); },
};
