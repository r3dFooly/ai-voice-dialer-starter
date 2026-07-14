'use strict';
// DNC check against the dnc_list table (created by migration 0007). Returns false
// gracefully if the table is absent, so this is a safe no-op until 0007 is applied.
const { getLeadSource } = require('../adapters/leadSource');

async function isDnc(phone) {
  if (!phone) return false;
  try {
    const { client } = getLeadSource();
    const { data, error } = await client.from('dnc_list').select('id').eq('phone_e164', phone).limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { isDnc };
