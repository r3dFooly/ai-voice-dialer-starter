'use strict';
// Default LeadSource adapter — retell_call_queue / retell_call_log are the system
// of record. No external CRM. This is the near 1:1 fit the audit found: the base
// queue schema is already Supabase-native.
const { createClient } = require('@supabase/supabase-js');
const { config } = require('../../config');

const client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});

// Cheap prefilter for the scheduler. The DB function is_lead_callable() is the
// AUTHORITATIVE per-row gate the scheduler applies after this (attempt caps +
// cooldown, and consent/window when the compliance module is enabled).
async function fetchCandidates({ limit = 20 } = {}) {
  const { data, error } = await client
    .from('retell_call_queue')
    .select('*')
    .eq('dialer_status', 'Pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('priority_score', { ascending: false })
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function updateQueueRow(id, patch) {
  const { error } = await client.from('retell_call_queue').update(patch).eq('id', id);
  if (error) throw error;
}

async function recordCallLog(row) {
  const { error } = await client.from('retell_call_log').insert(row);
  if (error) throw error;
}

async function ingestLead(payload = {}) {
  const row = {
    contact_name: payload.contact_name || payload.name || 'Unknown',
    phone_e164: payload.phone_e164 || payload.phone,
    source: payload.source || 'api',
    external_lead_id: payload.external_lead_id || null,
    lead_labels: payload.lead_labels || null,
    segment: payload.segment || null,
    priority_score: payload.priority_score != null ? payload.priority_score : 20,
    lead_context: payload.lead_context || {},
  };
  if (!row.phone_e164) throw new Error('ingestLead: phone_e164 required');
  const { data, error } = await client.from('retell_call_queue').insert(row).select('id').single();
  if (error) throw error;
  return { id: data.id };
}

async function markDnc(phone /* , reason */) {
  const { error } = await client
    .from('retell_call_queue')
    .update({ dialer_status: 'DNC', disposition: 'DNC', dnc_checked: true })
    .eq('phone_e164', phone);
  if (error) throw error;
}

// Supabase is the system of record — nothing to push elsewhere.
async function writeback(/* queueRow, outcome */) { /* no-op */ }

module.exports = { client, fetchCandidates, updateQueueRow, recordCallLog, ingestLead, markDnc, writeback };
