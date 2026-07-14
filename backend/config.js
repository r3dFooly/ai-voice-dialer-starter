'use strict';
// Central configuration + all vertical-specific knobs. Everything the ORIGINAL
// system hardcoded (persona name, greetings, company, transfer numbers, vertical
// scripts) is env-driven here so the code carries zero business identity.
require('dotenv').config();
const path = require('path');

function env(k, d) { const v = process.env[k]; return v === undefined || v === '' ? d : v; }
function envInt(k, d) { const v = parseInt(process.env[k], 10); return Number.isFinite(v) ? v : d; }
function envBool(k, d) { const v = process.env[k]; return v === undefined ? d : String(v).toLowerCase() === 'true'; }

const config = {
  company: {
    name: env('COMPANY_NAME', ''),
    agentPersonaName: env('AGENT_PERSONA_NAME', 'Agent'),
    segmentLabel: env('SEGMENT_LABEL', 'Lead'),
  },
  retell: {
    apiKey: env('RETELL_API_KEY', ''),
    agentId: env('RETELL_AGENT_ID', ''),
    fromNumber: env('RETELL_FROM_NUMBER', ''),
  },
  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1'), // includes /v1
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', 'gpt-4o-mini'),
    timeoutMs: envInt('LLM_TIMEOUT_MS', 12000),
    maxTokens: envInt('LLM_MAX_TOKENS', 200),
    temperature: 0.7,
  },
  supabase: {
    url: env('SUPABASE_URL', ''),
    serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY', ''),
  },
  leadSource: env('LEAD_SOURCE', 'supabase'),
  transfer: {
    primary: env('TRANSFER_PRIMARY', ''),
    fallback: env('TRANSFER_FALLBACK', ''),
  },
  notifier: { webhookUrl: env('NOTIFY_WEBHOOK_URL', '') },
  twilio: {
    lookupEnabled: envBool('ENABLE_TWILIO_LOOKUP', false),
    accountSid: env('TWILIO_ACCOUNT_SID', ''),
    authToken: env('TWILIO_AUTH_TOKEN', ''),
  },
  compliance: { enabled: envBool('COMPLIANCE_MODULE_ENABLED', false) },
  server: {
    port: envInt('PORT', 4002),
    schedulerPollMs: envInt('SCHEDULER_POLL_INTERVAL_MS', 15000),
    candidateBatchSize: envInt('RETELL_CANDIDATE_BATCH_SIZE', 20),
    staleCallTtlMs: envInt('RETELL_STALE_CALL_TTL_MS', 600000),
  },
  knowledgeDir: env('RETELL_KNOWLEDGE_DIR', path.join(__dirname, 'knowledge')),
  // Cosmetic labels for the 3 retry tiers + "other". Override via TIER_LABELS.
  tierLabels: env('TIER_LABELS', 'Tier 1,Tier 2,Tier 3,Other').split(',').map((s) => s.trim()),
};

// What the voice agent calls itself. The ORIGINAL hardcoded a persona name; now
// it is config with a neutral fallback.
function agentDisplayName() {
  return config.company.agentPersonaName || 'the assistant';
}

module.exports = { config, agentDisplayName };
