// Voice Dialer — Retell Custom-LLM WebSocket turn loop + post-call webhook.
// Reusable, CRM-neutral, voice-only. All business identity lives in config +
// knowledge/; all external systems are reached through the adapters below.

// --- Reusable-starter adapters (loaded first — top-level greeting/screener
// strings below are evaluated at module load and reference config) ---
// LLM turns go through adapters/llm (was the LLM), lead reads/writes through the
// leadSource adapter (retell_call_* system of record), outbound alerts through the
// notifier webhook (was the the notifier/the notifier card POST), and compliance through the
// (default-disabled) compliance façade.
const { config, agentDisplayName } = require('./config');
const { callLLM, callLLMStream } = require('./adapters/llm');
const { notify, notifyTransferIntent } = require('./adapters/notifier/webhook');
const { getLeadSource } = require('./adapters/leadSource');
const leadSource = getLeadSource();
const compliance = require('./compliance');

var FIRST_MESSAGE_GREETING = process.env.RETELL_FIRST_MESSAGE_GREETING || "";

// RD.10 — two-part greeting. the voice agent opens with just a short, natural "Hello!" on
// connect (call_details), waits for the lead to respond, then delivers the full
// personalized introduction on the first response_required turn (see
// buildFirstGreeting). Keeps the proactive "speaks first" behavior from RD.6.
var SHORT_GREETING = "Hello!";

// Vertical script loader — reads the vertical/the vertical scripts from /knowledge/
// RD.21b: cache the formatted script in memory keyed by filename. Previously
// this hit disk on EVERY response_required turn; the file never changes during
// a process lifetime, so the first read is cached and reused for all later turns
// (removes per-turn fs latency from the live-call hot path).
var _vsPath = require("path"), _vsFs = require("fs");
var _vsScriptCache = {};
// Segment-neutral: the original hardcoded an the vertical/the vertical filename map. The
// starter loads ONE knowledge/vertical-script.txt for ANY segment (override the
// filename per-segment via SEGMENT_SCRIPT_MAP='{"the vertical":"the vertical-script.txt"}'
// if you split scripts). Empty segment or a missing file → no vertical section.
var _segmentScriptMap = (function () {
  try { return JSON.parse(process.env.SEGMENT_SCRIPT_MAP || "{}"); } catch (_e) { return {}; }
})();
function loadVerticalScript(segment) {
  var v = String(segment || "").trim().toLowerCase();
  var f = _segmentScriptMap[v] || "vertical-script.txt";
  if (_vsScriptCache[f] !== undefined) return _vsScriptCache[f];
  try {
    var p = _vsPath.join(config.knowledgeDir, f);
    if (_vsFs.existsSync(p)) {
      var c = _vsFs.readFileSync(p, "utf8").trim();
      var out = "\n\n--- VERTICAL-SPECIFIC CALL FLOW ---\n" + c;
      console.log("[voice-dialer] cached vertical script:", f, "(" + c.length + " chars)");
      _vsScriptCache[f] = out;
      return out;
    }
  } catch (e) { console.error("[voice-dialer] vertical script error:", e.message); }
  _vsScriptCache[f] = "";
  return "";
}

// Inbound call flow — wires the previously-orphaned knowledge/inbound-script.txt
// for calls the consumer placed TO us (callbacks / new inbound). Cached like the
// vertical scripts. The override header tells the model it is ANSWERING a call,
// so it must NOT use the outbound "just following up on your inquiry" opener.
function loadInboundScript() {
  var f = "inbound-script.txt";
  if (_vsScriptCache[f] !== undefined) return _vsScriptCache[f];
  try {
    var p = _vsPath.join(config.knowledgeDir, f);
    if (_vsFs.existsSync(p)) {
      var c = _vsFs.readFileSync(p, "utf8").trim();
      var out = "\n\n--- INBOUND CALL FLOW (the caller phoned US — you are ANSWERING the call, NOT following up; this OVERRIDES the outbound opener/framing) ---\n" + c;
      console.log("[retell-dialer] cached inbound script (" + c.length + " chars)");
      _vsScriptCache[f] = out;
      return out;
    }
  } catch (e) { console.error("[retell-dialer] inbound script error:", e.message); }
  return "";
}

// True when Retell reports the call as inbound (consumer dialed in).
function isInboundCall(callObject) {
  var d = callObject && (callObject.direction || callObject.call_type);
  return String(d || "").toLowerCase().includes("inbound");
}

// Proactive answer the voice agent speaks when picking up an inbound call. Env-tunable so
// the greeting can be tuned without a deploy.
var INBOUND_GREETING = process.env.RETELL_INBOUND_GREETING ||
  `Thanks for calling ${config.company.name || '{{company}}'}, this is ${agentDisplayName()}. How can I help you today?`;
// plus the Retell Custom-LLM WebSocket that drives live calls.
//
// Port 4002 (internal only — front by nginx/Make.com if exposed).
// HTTP: receives GHL Contact.Create / Opportunity.StageChange / SMS events,
// scores priority, dedupes, and inserts into public.retell_call_queue.
// WebSocket (/retell-llm): Retell connects here per live call and we proxy
// each conversational turn to Claude (via the LLM) with an enriched prompt.
//
// Owns NO outbound call execution — that is a downstream worker (scheduler.js).

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
// NOTE: retell-sdk v5 (Stainless rewrite) removed the webhook-verification helper
// that older versions shipped in lib/webhook_auth.js, so there is no Retell.verify
// (static or instance) to import. Signature verification is reimplemented below in
// verifyRetellSignature() using Retell's exact published algorithm.
const {
  getTier,
  tierConfig,
  getNextAttemptTime,
  clampToCooldownFloor,
  nextBusinessDay9amInTz,
  zonedWallClockToUtc,
  tzParts,
} = require('./tiers');
const { detectCallback, buildCallbackPromptPrefix, chooseInboundLead } = require('./callback-detector');

let SYSTEM_PROMPT_TEMPLATE = '';
try {
  SYSTEM_PROMPT_TEMPLATE = require('fs').readFileSync(require('path').join(__dirname, 'system-prompt.txt'), 'utf8').trim();
  console.log('[retell-dialer] loaded system-prompt.txt (' + SYSTEM_PROMPT_TEMPLATE.length + ' chars)');
} catch (_e) {
  console.error('[retell-dialer] FAILED to load system-prompt.txt:', _e.message);
}

const PORT = config.server.port;
const SUPABASE_URL = config.supabase.url;
const SUPABASE_SERVICE_ROLE_KEY = config.supabase.serviceRoleKey;
// Post-call webhook (Task 5 processor, restored + extended for Task 15). All
// optional — the /retell-webhook route degrades gracefully when absent.
const RETELL_API_KEY = config.retell.apiKey;
// RD.8: shared-secret guarding POST /retell/remove-lead. Mirrors the ?token=
// query-param guard used by the webhook-server ingest endpoints. Fail-closed:
// when unset the endpoint refuses all callers (503) rather than running open.
const REMOVE_LEAD_TOKEN = process.env.RETELL_REMOVE_LEAD_TOKEN || '';
// Voicemail-per-day limit (Task 15 step 5): max 1 voicemail/day, max 2 lifetime.
const MAX_VOICEMAILS_LIFETIME = 2;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[retell-dialer] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!RETELL_API_KEY) {
  console.warn('[retell-dialer] RETELL_API_KEY not set — /retell-webhook will reject all events (cannot verify signatures)');
}

// All lead reads/writes go through the leadSource adapter; `supabase` is its
// shared client so the original retell_call_* queries stay intact.
const supabase = leadSource.client;

const ET_TIMEZONE = 'America/New_York';

// Dialer statuses that end the row's life in the queue.
const TERMINAL_DIALER_STATUSES = [
  'Removed',
  'Max_Attempts_Reached',
  'Max_VM_Reached',
  'Completed',
  'DNC',
  'Transferred',
];

// --- Voice-LLM config (used by the /retell-llm WebSocket during calls) -------
// All model wiring (base URL / key / model / timeout) now lives in adapters/llm
// via config.llm — the turn loop calls callLLM / callLLMStream. Only the display
// model name + streaming flag are needed here.
const RETELL_VOICE_MODEL = config.llm.model;
// Voice latency fix: stream the model's reply to Retell token-by-token so TTS
// starts on the first sentence instead of waiting for the full completion.
// Flag-gated + default OFF so the proven non-streaming path stays live until
// streaming is validated on a test call — including the cold-transfer bridge.
const RETELL_VOICE_STREAMING =
  String(process.env.RETELL_VOICE_STREAMING || '').toLowerCase() === 'true';
// Spoken when the model is slow or errors — keeps the call alive gracefully.
const RETELL_FALLBACK = 'I appreciate your patience. Could you say that one more time?';
// Spoken when the caller opts out (TCPA) but the model is unreachable: the
// opt-out is detected locally from the transcript, so we still honor it
// immediately and end the call rather than falling back into another turn.
const RETELL_DNC_ACK =
  'I completely understand, and I apologize for the inconvenience. ' +
  "I'll make sure you're not contacted again. Take care.";

// Cold transfer target. The ONE number every cold transfer routes to (the agency
// main line). Per-agent / warm-transfer routing is not supported for Retell
// Custom-LLM agents, so there is a single config-driven number and no name map.
const COLD_TRANSFER_NUMBER = config.transfer.primary;
const TRANSFER_FALLBACK_NUMBER = config.transfer.fallback;

// --- /retell-llm enrichment config -------------------------------------------
// Before each live-call turn we enrich the system prompt with lead history,
// avatar psychology, product knowledge, and a compliance reminder. The Supabase
// lookup is the only network hop here; it is HARD-CAPPED so it can never block a
// live call — if it exceeds this budget (or errors) we proceed with the static
// prompt plus the disk-loaded briefs. Knowledge files are read once at startup
// into memory, so per-turn brief injection costs nothing.
const KNOWLEDGE_DIR = process.env.RETELL_KNOWLEDGE_DIR || path.join(__dirname, 'knowledge');
const LEAD_LOOKUP_TIMEOUT_MS = Number(process.env.RETELL_LEAD_LOOKUP_TIMEOUT_MS || 500);
// Lead context (history, avatar, vertical) is immutable for the life of a call,
// so we cache it per call_id and only hit Supabase on the first turn. This keeps
// added latency near zero for turns 2..N and slashes DB load.
const LEAD_CONTEXT_TTL_MS = Number(process.env.RETELL_LEAD_CONTEXT_TTL_MS || 10 * 60 * 1000);
const LEAD_CONTEXT_CACHE_MAX = 1000;

// Always-injected safety guardrail. Generic + config-overridable — no vertical
// rules baked in. Set RETELL_COMPLIANCE_REMINDER for regulated-industry wording.
const COMPLIANCE_REMINDER =
  process.env.RETELL_COMPLIANCE_REMINDER ||
  'SAFETY REMINDER: Do not make promises, quote prices, or state facts you are ' +
  'not certain of. Do not collect sensitive personal data (full SSN, full date of ' +
  'birth, financial or health details). If the caller asks for specifics you ' +
  'cannot confirm, offer to connect them with a specialist.';

// --- helpers ----------------------------------------------------------------

function buildSystemPrompt(dynamicVariables) {
  const dv = dynamicVariables && typeof dynamicVariables === 'object' ? dynamicVariables : {};
  const leadName = (dv.lead_name && String(dv.lead_name).trim()) || 'there';
  const agentName =
    (dv.agent_name && String(dv.agent_name).trim()) || agentDisplayName();
  const vertical = String(dv.vertical || dv.product_interest || '').trim().toLowerCase();
  const company = config.company.name || 'our company';

  const lines = [
    `You are a friendly advisor calling on behalf of ${company}. You are speaking with ${leadName}. Your goal is to qualify this lead using BANT (Budget, Authority, Need, Timeline) and if qualified, offer to connect them with ${agentName}, a licensed advisor.`,
    '',
    'Rules:',
    'Keep your responses conversational and brief. Two to three sentences maximum per turn.',
    'Never read formatting characters like asterisks, bullets, or dashes out loud.',
    "Use the lead's name naturally but not every sentence.",
  ];

  // Optional per-segment prompt rules. The blank starter ships none — add your own
  // via a product brief (knowledge/product-briefs.json) or RETELL_COMPLIANCE_REMINDER
  // if your vertical is regulated.
  void vertical;

  lines.push('Never collect sensitive personal data (SSN, full date of birth, financial or health details) on this call.');
  lines.push(
    'If they say stop calling or do not call, immediately say you understand, apologize for the inconvenience, and end the call.'
  );

  return lines.join('\n');
}

// Retell transcript roles are "agent"/"user"; the chat-completions API wants
// "assistant"/"user". Drop empty or malformed turns.
function mapTranscriptToMessages(transcript) {
  if (!Array.isArray(transcript)) return [];
  const messages = [];
  for (const turn of transcript) {
    if (!turn || typeof turn !== 'object') continue;
    const content = typeof turn.content === 'string' ? turn.content : '';
    if (!content) continue;
    messages.push({ role: turn.role === 'agent' ? 'assistant' : 'user', content });
  }
  return messages;
}

const DNC_PATTERNS = [
  'stop calling', 'stop call', 'do not call', "don't call", 'dont call',
  'do not contact', "don't contact", 'dont contact', 'stop contacting',
  'remove me', 'take me off', 'no more calls',
];

// Compliance-critical (TCPA): opt-outs must be honored immediately. Scanned
// against both the caller's last words and the model's reply.
function containsDncSignal(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return DNC_PATTERNS.some((p) => t.includes(p));
}

// DNC opt-out PRIMITIVE (kept when the compliance module is stripped from the hot
// path). When a stop / do-not-call signal is detected mid-call the turn loop ends
// the call AND records the number on the do-not-call list via the leadSource
// adapter. One-shot per call, fire-and-forget — never throws into the live path.
const _dncMarked = new Set();
function markDncFromCall(callObject, dynamicVariables, callId) {
  try {
    const key = String(callId || '');
    if (key && _dncMarked.has(key)) return;
    if (key) _dncMarked.add(key);
    const dv = dynamicVariables || {};
    const phone = (callObject && callObject.to_number) || dv.phone || null;
    if (!phone) return;
    Promise.resolve(leadSource.markDnc(phone, 'voice_opt_out')).catch((e) =>
      console.error('[voice-dialer] markDnc failed:', e && e.message)
    );
    console.log('[voice-dialer] DNC opt-out — marked do-not-call');
  } catch (err) {
    console.error('[voice-dialer] markDncFromCall failed:', err && err.message);
  }
}

function lastUserUtterance(transcript) {
  if (!Array.isArray(transcript)) return '';
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    if (turn && turn.role === 'user' && typeof turn.content === 'string') return turn.content;
  }
  return '';
}

// Spoken hand-off cues. When the model's reply contains one of these, the caller
// has agreed to a warm transfer and we attach `transfer_number` to the WS reply.
// Matched as substrings against the lowercased reply, so they tolerate the
// surrounding sentence (e.g. "awesome, hold one moment while I bring them on").
const TRANSFER_INTENT_PHRASES = [
  'let me connect you', 'let me transfer you', 'bring them on',
  'transfer you now', 'connect you with', 'hold on while i',
  'let me get them on the line', 'one moment while i',
  'connecting you now', 'transferring you now',
];

// RD.21b: per-call guard for cold transfers. Once we attach `transfer_number`
// for a call we record it here (keyed by call_id). Any further response_required
// for that call is answered with an empty no-op so the voice agent stays silent during the
// SIP handoff — a new spoken turn during TTS playback would flip the turn and
// wipe the pending transfer (confirmed Retell timing race, May 2026). Entries are
// cleared on WS close.
const transferInitiated = new Map();

// One-shot guard for the "call_in_progress" leads card (keyed by call_id). The
// card is posted the MOMENT the voice agent emits a transfer-intent phrase (the RD.25
// cold-transfer moment) — NOT on a blanket 60s timer (the old behavior, which
// fired on every call regardless of outcome and far too early). detectTransferIntent
// can match on more than one turn, and buildRetellLlmResponse runs per turn, so
// this Set ensures the card can never double-post for a call. Entries are cleared
// on WS close alongside transferInitiated.
const callInProgressCardSent = new Set();

// Fire the transfer-intent alert through the notifier adapter (was a the notifier/the notifier
// "call_in_progress" adaptive-card POST to localhost:4000). Best-effort and
// one-shot per call: notifyTransferIntent itself dedupes by callId, and the
// callInProgressCardSent guard keeps the build path one-shot too. The GHL email
// enrich + the notifier card_type are dropped — the notifier payload is neutral JSON.
// NEVER throws and NEVER blocks the transfer path.
function postCallInProgressCard({ callId, dynamicVariables, metadata, queueId, callObject } = {}) {
  try {
    if (callId && callInProgressCardSent.has(String(callId))) return;
    if (callId) callInProgressCardSent.add(String(callId));
    const dv = dynamicVariables || {};
    const md = metadata || {};
    const assignedAgent = md.assigned_agent || '';
    const agentName = dv.agent_name || '';
    const phone = (callObject && callObject.to_number) || dv.phone || '';
    notifyTransferIntent({
      callId: callId || '',
      leadName: dv.lead_name || 'Unknown',
      phone,
      segment: dv.vertical || dv.product_interest || '',
      assignedAgent,
      agentName,
      queueId: queueId || '',
    });
  } catch (err) {
    // Notifier must NEVER break the transfer path.
    console.error('[voice-dialer] transfer-intent notify failed:', err && err.message);
  }
}

function detectTransferIntent(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return TRANSFER_INTENT_PHRASES.some((p) => lower.includes(p));
}

// WRONG-PERSON transfer guard (call audit 2026-07-08). The day's ONLY outbound
// bridge was a FALSE transfer to someone who explicitly denied being the lead
// ("which is not Christina," nonsense answers) yet bridged on bant_score 45. Before
// attaching transfer_number we scan the CALLER's own utterances for an EXPLICIT
// identity denial and, if found, block the bridge so a stranger is never handed a
// live agent. Narrow by design: only an explicit denial trips it, so a legitimate
// transfer is never blocked. Default ON; kill with WRONGPERSON_GUARD_LIVE=0.
const WRONGPERSON_GUARD_LIVE = process.env.WRONGPERSON_GUARD_LIVE !== '0';
// Identity-denial ONLY — must NOT match a normal objection like "I'm not
// interested / not sure / not looking" (those are the RIGHT person objecting; the
// rebuttal loop handles them). So no bare "I'm not …"; the specific "not <leadName>"
// denial is caught by the name check in detectWrongPerson below.
const WRONGPERSON_RE =
  /\bwrong (number|person)\b|you (have|got) the wrong|no ?body (named|by (the|that) name)|there'?s no ?one\b|(this is|it'?s) not (him|her)\b|(i'?m|i am) not (who|the (right )?(one|person)|him|her)\b/i;
function detectWrongPerson(transcript, leadName) {
  if (!Array.isArray(transcript)) return false;
  const userText = transcript
    .filter((t) => t && t.role === 'user' && typeof t.content === 'string')
    .map((t) => t.content)
    .join(' ');
  if (!userText) return false;
  if (WRONGPERSON_RE.test(userText)) return true;
  // Explicit "not <leadName>" — the caller names the lead and denies being them
  // (the "which is not Christina" case, which the generic regex above misses).
  const name = String(leadName || '').trim();
  if (name) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstName = name.split(/\s+/)[0];
    for (const n of [name, firstName]) {
      if (n && n.length >= 2 && new RegExp(`\\bnot\\s+${esc(n)}\\b`, 'i').test(userText)) return true;
    }
  }
  return false;
}

// Voice booking: phrases the voice agent says ONLY when locking in a scheduled callback
// (the script's BOOKING section) — deliberately distinct from the transfer
// phrases so the two intents never collide.
const BOOKING_INTENT_PHRASES = [
  'locked in for', 'lock you in', 'get you locked in',
  "you're all set", 'got you down for', "you're booked",
];
function loadKnowledgeFile(name) {
  try {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, name), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[retell-dialer] could not load knowledge/${name}: ${err.message} — enrichment will skip it`
    );
    return null;
  }
}

// Loaded once at startup (instant disk read). Both files are optional.
function loadKnowledge() {
  return {
    avatarBriefs: loadKnowledgeFile('avatar-briefs.json'),
    productBriefs: loadKnowledgeFile('product-briefs.json'),
  };
}

const KNOWLEDGE = loadKnowledge();

// Retell posts the live-call turn either flat (legacy/test shape) or nested
// under `call`. Support both so the queue_id (set in scheduler metadata) and the
// dynamic variables resolve regardless of payload version.
function extractCallContext(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const call = p.call && typeof p.call === 'object' ? p.call : {};
  const metadata = (p.metadata && typeof p.metadata === 'object' && p.metadata) ||
    (call.metadata && typeof call.metadata === 'object' && call.metadata) || {};
  const dynamicVariables =
    (p.dynamic_variables && typeof p.dynamic_variables === 'object' && p.dynamic_variables) ||
    (call.retell_llm_dynamic_variables &&
      typeof call.retell_llm_dynamic_variables === 'object' &&
      call.retell_llm_dynamic_variables) ||
    {};
  const rawQueueId = metadata.queue_id ?? metadata.queueId ?? null;
  const callId = p.call_id || call.call_id || null;
  return {
    queueId: rawQueueId != null ? String(rawQueueId) : null,
    callId: callId != null ? String(callId) : null,
    dynamicVariables,
    metadata,
  };
}

// Recent caller utterances, used for deadline-keyword detection (avatar nuance).
function recentTranscriptText(transcript) {
  if (!Array.isArray(transcript)) return '';
  const userTurns = transcript.filter(
    (t) => t && t.role === 'user' && typeof t.content === 'string'
  );
  return userTurns
    .slice(-6)
    .map((t) => t.content)
    .join(' ');
}

function containsAny(haystack, keywords) {
  if (!haystack || !Array.isArray(keywords)) return false;
  const h = String(haystack).toLowerCase();
  return keywords.some((k) => k && h.includes(String(k).toLowerCase()));
}

// Format an ISO timestamp as a human date in ET for the spoken prompt.
function formatCallDate(iso) {
  if (!iso) return 'a previous date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'a previous date';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIMEZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

// Resolve the avatar brief from a lead's source tags. Tags come from ghl_tags
// (e.g. "alpha-the vertical") and the source column (e.g. "data_backfill"); each is
// matched raw and with separators normalized to hyphens. A the vertical cliff-hanger
// (VI005) is promoted to the penalty-fearful brief (VI006) when deadline
// language appears in the tags or the recent transcript.
function resolveAvatar(avatarBriefs, { source, tags, haystack } = {}) {
  if (!avatarBriefs || !avatarBriefs.source_map || !avatarBriefs.avatars) return null;

  const candidates = [];
  if (Array.isArray(tags)) {
    for (const t of tags) candidates.push(String(t).toLowerCase().trim());
  }
  if (source) candidates.push(String(source).toLowerCase().trim());

  let key = null;
  for (const c of candidates) {
    const variant = c.replace(/[_\s]+/g, '-');
    if (avatarBriefs.source_map[c]) {
      key = avatarBriefs.source_map[c];
      break;
    }
    if (avatarBriefs.source_map[variant]) {
      key = avatarBriefs.source_map[variant];
      break;
    }
  }
  if (!key) return null;

  const ov = avatarBriefs.deadline_override;
  const deadlineHaystack = [Array.isArray(tags) ? tags.join(' ') : '', haystack || ''].join(' ');
  if (ov && key === ov.from && containsAny(deadlineHaystack, ov.keywords)) {
    key = ov.to;
  }
  return avatarBriefs.avatars[key] || null;
}

// Resolve the product brief from a lead's vertical/product_interest. Matches the
// canonical key (the vertical, the vertical) or any configured alias (the vertical, the vertical, ...).
function resolveProduct(productBriefs, vertical) {
  if (!productBriefs || !productBriefs.verticals || !vertical) return null;
  const v = String(vertical).toLowerCase().trim();
  if (!v) return null;
  for (const [key, def] of Object.entries(productBriefs.verticals)) {
    if (v === key.toLowerCase()) return def;
    const aliases = Array.isArray(def.aliases) ? def.aliases.map((a) => String(a).toLowerCase()) : [];
    if (aliases.includes(v)) return def;
  }
  return null;
}

// Compose the enrichment system-prompt sections. Compliance is ALWAYS appended,
// even when the lead lookup failed and only `dv` is available. Returns an array
// of plain-text blocks to join onto the base prompt.
function buildEnrichmentSections({ knowledge, leadContext, dv, transcriptText } = {}) {
  const sections = [];
  const lc = leadContext && typeof leadContext === 'object' ? leadContext : {};
  const dvObj = dv && typeof dv === 'object' ? dv : {};
  const k = knowledge || {};

  // 1. Lead history — only when we have a prior logged call.
  const prev = lc.previousCall;
  if (prev && typeof prev === 'object') {
    const parts = [`This person was called previously on ${formatCallDate(prev.created_at)}.`];
    if (prev.call_summary) parts.push(`Summary: ${prev.call_summary}.`);
    if (prev.bant_score !== null && prev.bant_score !== undefined) {
      parts.push(`BANT score was ${prev.bant_score}.`);
    }
    if (prev.sentiment) parts.push(`Sentiment was ${prev.sentiment}.`);
    parts.push('Pick up where that conversation left off naturally.');
    sections.push('LEAD HISTORY: ' + parts.join(' '));
  }

  // 1b. SMS-reply context — this call was triggered by an inbound text.
  const lcSource = String(lc.source || '').toLowerCase();
  if (lcSource === 'sms_reply' || lcSource === 'ghl_sms_reply') {
    sections.push(
      'WHY WE ARE CALLING: This person just replied to an SMS message, which is ' +
        'why we are calling. Acknowledge that naturally.'
    );
  }

  // 2. Avatar psychology — from source labels (needs the DB lookup for lead_labels).
  const tags = Array.isArray(lc.lead_labels) ? lc.lead_labels : [];
  const avatar = resolveAvatar(k.avatarBriefs, {
    source: lc.source,
    tags,
    haystack: transcriptText || '',
  });
  if (avatar && avatar.brief) sections.push('AVATAR INSIGHT: ' + avatar.brief);

  // 3. Product knowledge — segment can come from the DB or the dynamic vars,
  // so this still injects even when the lookup failed.
  const vertical =
    lc.segment || lc.product_interest || dvObj.vertical || dvObj.product_interest || '';
  const product = resolveProduct(k.productBriefs, vertical);
  if (product && product.brief) sections.push('PRODUCT KNOWLEDGE: ' + product.brief);

  // 4. Compliance reinforcement — ALWAYS.
  sections.push(COMPLIANCE_REMINDER);

  return sections;
}

// Look up lead context in Supabase under a hard timeout. Returns:
//   { ok: true, context }  — row found (context has history/avatar/vertical)
//   { ok: true, context: null } — no such queue row (stable; safe to cache)
//   { ok: false }          — error or timeout (do NOT cache; retry next turn)
// NEVER throws — a live call must never be blocked by this lookup.
async function fetchLeadContext(queueId) {
  if (!queueId) return { ok: true, context: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEAD_LOOKUP_TIMEOUT_MS);
  try {
    const queueP = supabase
      .from('retell_call_queue')
      .select('id, contact_name, segment, product_interest, source, priority_score, retry_count, lead_labels')
      .eq('id', queueId)
      .abortSignal(controller.signal)
      .maybeSingle();

    const logP = supabase
      .from('retell_call_log')
      .select('created_at, call_summary, bant_score, sentiment')
      .eq('queue_id', queueId)
      .order('created_at', { ascending: false })
      .limit(1)
      .abortSignal(controller.signal)
      .maybeSingle();

    const [queueRes, logRes] = await Promise.all([queueP, logP]);

    if (queueRes.error) {
      console.error('[retell-dialer] lead lookup (queue) failed', queueRes.error.message);
      return { ok: false };
    }
    const row = queueRes.data;
    if (!row) return { ok: true, context: null };

    const previousCall = !logRes.error && logRes.data ? logRes.data : null;

    return {
      ok: true,
      context: {
        contact_name: row.contact_name,
        segment: row.segment,
        product_interest: row.product_interest,
        source: row.source,
        priority_score: row.priority_score,
        retry_count: row.retry_count,
        lead_labels: row.lead_labels,
        previousCall,
      },
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error('[retell-dialer] lead lookup timed out after', LEAD_LOOKUP_TIMEOUT_MS, 'ms');
    } else {
      console.error('[retell-dialer] lead lookup error', err && err.message);
    }
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const leadContextCache = new Map(); // cacheKey -> { value, expires }

// Per-call cached wrapper around fetchLeadContext. Caches found rows and
// confirmed-absent rows (stable DB states); never caches errors/timeouts so a
// transient blip can recover on the next turn.
async function getLeadContext(cacheKey, queueId) {
  if (cacheKey) {
    const hit = leadContextCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;
  }

  const result = await fetchLeadContext(queueId);
  if (!result.ok) return null; // transient — don't cache, retry next turn

  const value = result.context;
  if (cacheKey) {
    if (leadContextCache.size >= LEAD_CONTEXT_CACHE_MAX) {
      const oldest = leadContextCache.keys().next().value;
      if (oldest !== undefined) leadContextCache.delete(oldest);
    }
    leadContextCache.set(cacheKey, { value, expires: Date.now() + LEAD_CONTEXT_TTL_MS });
  }
  return value;
}

// --- app --------------------------------------------------------------------

const app = express();
// Capture the raw request bytes alongside JSON parsing. Retell signs the raw body,
// so verifyRetellSignature() must hash req.rawBody — re-serialising req.body via
// JSON.stringify changes the bytes and every signature check would fail. The verify
// callback only records the buffer; JSON parsing is unchanged for all routes.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'retell-dialer', port: PORT });
});

// --- GHL webhook handlers ----------------------------------------------------
// The three legacy GHL endpoints now share one code path. Each handler is a pure
// async function that returns { status, body, action, reason } so the dispatcher
// can emit a uniform audit line and send the HTTP response. `action` is one of
// inserted | updated | skipped | rejected.

// TL.2: mask a phone for logging — last 4 digits only, never the full number.
// --- RD.8: POST /retell/remove-lead ------------------------------------------
// Pull a lead out of the dialer queue on demand (e.g. a GHL workflow detecting
// the lead booked elsewhere, or a human claiming them). Auth: ?token=<RETELL_
// REMOVE_LEAD_TOKEN>, the same query-param guard the webhook-server ingest
// endpoints use. Body: { contactId }.
//   • found + non-terminal → dialer_status='Removed', strip lead_queue → removed
//   • not found OR already terminal                              → skipped
async function handleRemoveLead(req, res) {
  // Auth — fail closed when the secret is not configured.
  if (!REMOVE_LEAD_TOKEN) {
    console.error('[retell-dialer] /retell/remove-lead hit but RETELL_REMOVE_LEAD_TOKEN is not set');
    return res.status(503).json({ ok: false, reason: 'not_configured' });
  }
  if (req.query.token !== REMOVE_LEAD_TOKEN) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }

  try {
    const body = req.body || {};
    const contactId = body.contactId != null ? String(body.contactId).trim() : '';
    if (!contactId) {
      return res.status(400).json({ ok: false, reason: 'missing_contact_id' });
    }

    const { data: rows, error: lookupErr } = await supabase
      .from('retell_call_queue')
      .select('id, dialer_status, external_lead_id')
      .eq('external_lead_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (lookupErr) {
      console.error('[retell-dialer] remove-lead lookup failed', lookupErr.message);
      return res.status(500).json({ ok: false, reason: 'lookup_failed' });
    }

    const existing = rows && rows.length > 0 ? rows[0] : null;

    // Not in the queue, or already retired → nothing to remove.
    if (!existing || TERMINAL_DIALER_STATUSES.includes(existing.dialer_status)) {
      console.log(
        `[retell-dialer] remove-lead skipped contact=${contactId} ` +
          `status=${existing ? existing.dialer_status : 'not_found'}`
      );
      return res.status(200).json({
        ok: true,
        action: 'skipped',
        reason: existing ? 'already_terminal' : 'not_found',
        queue_id: existing ? existing.id : null,
      });
    }

    const { error: updateErr } = await supabase
      .from('retell_call_queue')
      .update({ dialer_status: 'Removed', updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (updateErr) {
      console.error('[retell-dialer] remove-lead update failed', updateErr.message);
      return res.status(500).json({ ok: false, reason: 'update_failed' });
    }

    // Removed is terminal — push the outcome to the external CRM (no-op for the
    // default supabase leadSource; the GHL lead_queue tag-strip lived here before).
    try { await leadSource.writeback(existing, { dialer_status: 'Removed' }); } catch (_e) { /* best-effort */ }

    console.log(`[voice-dialer] remove-lead removed contact=${contactId} queue=${existing.id}`);
    return res.status(200).json({ ok: true, action: 'removed', queue_id: existing.id });
  } catch (err) {
    console.error('[retell-dialer] remove-lead handler error', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
}

app.post('/retell/remove-lead', handleRemoveLead);

// --- Retell post-call webhook ------------------------------------------------
// Resolves In_Progress rows after each call (without this the scheduler — which
// only dials Pending and blocks while any row is In_Progress — would deadlock
// after the first call). Originally Task 5; restored here onto the Task 13
// server and extended with the Task 15 tiered retry cadence + voicemail-per-day
// limit. Retry-eligible outcomes (voicemail under the limit, no-answer) return
// the row to 'Pending' because is_lead_callable() only re-dials Pending rows.

function getRetellEvent(payload) {
  return payload?.event ?? payload?.event_type ?? payload?.eventType ?? null;
}

function getRetellCall(payload) {
  if (payload?.call && typeof payload.call === 'object') return payload.call;
  if (payload?.data?.call && typeof payload.data.call === 'object') return payload.data.call;
  if (payload?.call_id || payload?.callId) return payload;
  return null;
}

function extractCallId(call) {
  return call?.call_id ?? call?.callId ?? null;
}

function extractQueueId(call) {
  return (
    call?.metadata?.queue_id ??
    call?.metadata?.queueId ??
    call?.retell_llm_dynamic_variables?.queue_id ??
    null
  );
}

// Prefer explicit duration_ms; otherwise derive from start/end epoch ms.
function extractDurationMs(call) {
  if (call?.duration_ms != null) return Number(call.duration_ms);
  if (call?.durationMs != null) return Number(call.durationMs);
  const start = call?.start_timestamp ?? call?.startTimestamp;
  const end = call?.end_timestamp ?? call?.endTimestamp;
  if (start != null && end != null) {
    const ms = Number(end) - Number(start);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  return null;
}

// $0.10/min, billed per whole call, rounded up to the next cent.
function computeCostCents(durationMs) {
  if (durationMs == null) return null;
  const minutes = Number(durationMs) / 1000 / 60;
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return Math.ceil(minutes * 10);
}

// Pull BANT/disposition/sentiment/summary out of the call_analysis block.
function extractCallAnalysis(call) {
  const ca = call?.call_analysis ?? call?.callAnalysis ?? {};
  const custom = ca.custom_analysis_data ?? ca.customAnalysisData ?? {};
  const pick = (...keys) => {
    for (const src of [custom, ca]) {
      if (!src || typeof src !== 'object') continue;
      for (const k of keys) {
        if (src[k] !== undefined && src[k] !== null && src[k] !== '') return src[k];
      }
    }
    return undefined;
  };
  const bantRaw = pick('bant_score', 'bantScore', 'bant');
  const bant = bantRaw != null ? Number(bantRaw) : NaN;
  const callbackRaw = pick('callback_time', 'callbackTime', 'callback_at', 'callback');
  return {
    bant_score: Number.isFinite(bant) ? Math.round(bant) : null,
    disposition: pick('disposition', 'call_disposition'),
    sentiment: pick('sentiment', 'user_sentiment', 'userSentiment'),
    call_summary: pick('call_summary', 'callSummary', 'summary') ?? null,
    callback_time: callbackRaw != null ? String(callbackRaw).trim() : null,
  };
}

// --- callback-time parsing (Task 21) -----------------------------------------
// Turn the Retell post-call `callback_time` extraction field (ISO 8601 when the
// model can format it, otherwise natural language) into a concrete UTC ISO
// instant. All relative phrases resolve in the LEAD's own timezone so "Monday at
// 5 PM" lands on their 5 PM, not ours. Never throws — an unparseable value
// returns null so the webhook degrades to the generic Callback flow.

const WEEKDAY_INDEX = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

// Local calendar Y/M/D that is `addDays` after `now` in the given timezone.
function localYmdPlus(timezone, now, addDays) {
  const p = tzParts(timezone, now);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  base.setUTCDate(base.getUTCDate() + addDays);
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

// Pull a clock time out of a natural-language phrase. Returns { hour, minute } in
// 24h, or null. A bare hour ("at 2") is ambiguous, so 1–7 is biased to PM
// (business calling hours) and 8–12 left as AM/noon.
function parseClockTime(text) {
  let m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/);
  if (m) {
    let hour = Number(m[1]) % 12;
    const minute = m[2] ? Number(m[2]) : 0;
    if (/p/.test(m[3])) hour += 12;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  m = text.match(/\b(\d{1,2}):(\d{2})\b/); // 24h "17:00" / "9:30"
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  m = text.match(/\bat\s+(\d{1,2})\b/); // bare "at 2"
  if (m) {
    let hour = Number(m[1]);
    if (hour < 0 || hour > 23) return null;
    if (hour >= 1 && hour <= 7) hour += 12;
    return { hour, minute: 0 };
  }
  return null;
}

// Next occurrence of weekday `targetIdx` at hour:minute in `timezone`, strictly
// in the future (rolls a week when today's slot has already passed).
function nextWeekdayAt(timezone, now, targetIdx, hour, minute) {
  const p = tzParts(timezone, now);
  const daysAhead = (targetIdx - p.weekday + 7) % 7;
  let { y, m, d } = localYmdPlus(timezone, now, daysAhead);
  let target = zonedWallClockToUtc(timezone, y, m, d, hour, minute);
  if (target.getTime() <= now.getTime()) {
    ({ y, m, d } = localYmdPlus(timezone, now, daysAhead + 7));
    target = zonedWallClockToUtc(timezone, y, m, d, hour, minute);
  }
  return target;
}

function parseCallbackTime(raw, timezone) {
  if (raw == null) return null;
  const tz = timezone || ET_TIMEZONE;
  const s = String(raw).trim();
  if (!s) return null;

  // 1. ISO 8601. A zoned timestamp (…Z or ±HH:MM) is absolute — use as-is. A
  // zoneless wall-clock ("2026-06-02T17:00:00") is interpreted in the LEAD's
  // timezone, so 17:00 means their 5 PM, not the server's.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const isoLocal = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (isoLocal) {
    const [, y, mo, dd, h, mi] = isoLocal;
    return zonedWallClockToUtc(tz, Number(y), Number(mo), Number(dd), Number(h), Number(mi)).toISOString();
  }

  const lower = s.toLowerCase();
  const now = new Date();

  // 2. "in a few hours" / "in N hours" / "in N minutes".
  if (/\bin a (?:few|couple)(?: of)? hours?\b/.test(lower)) {
    return new Date(now.getTime() + 3 * 3600 * 1000).toISOString();
  }
  const inHours = lower.match(/\bin (\d{1,2}) hours?\b/);
  if (inHours) return new Date(now.getTime() + Number(inHours[1]) * 3600 * 1000).toISOString();
  const inMin = lower.match(/\bin (\d{1,3}) min(?:ute)?s?\b/);
  if (inMin) return new Date(now.getTime() + Number(inMin[1]) * 60 * 1000).toISOString();

  // 3. "next week" -> next Monday 10 AM local.
  if (/\bnext week\b/.test(lower)) {
    return nextWeekdayAt(tz, now, 1, 10, 0).toISOString();
  }

  const clock = parseClockTime(lower);

  // 4. "tomorrow [at X]" (default 10 AM when no time given).
  if (/\btomorrow\b/.test(lower)) {
    const t = clock || { hour: 10, minute: 0 };
    const { y, m, d } = localYmdPlus(tz, now, 1);
    return zonedWallClockToUtc(tz, y, m, d, t.hour, t.minute).toISOString();
  }

  // 5. weekday name -> next occurrence (default 10 AM when no time given).
  for (const [name, idx] of Object.entries(WEEKDAY_INDEX)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) {
      const t = clock || { hour: 10, minute: 0 };
      return nextWeekdayAt(tz, now, idx, t.hour, t.minute).toISOString();
    }
  }

  // 6. bare clock time ("at 5 pm") -> today if still ahead, else tomorrow.
  if (clock) {
    const today = localYmdPlus(tz, now, 0);
    let target = zonedWallClockToUtc(tz, today.y, today.m, today.d, clock.hour, clock.minute);
    if (target.getTime() <= now.getTime()) {
      const tom = localYmdPlus(tz, now, 1);
      target = zonedWallClockToUtc(tz, tom.y, tom.m, tom.d, clock.hour, clock.minute);
    }
    return target.toISOString();
  }

  console.warn('[retell-dialer] could not parse callback time:', JSON.stringify(raw));
  return null;
}

// RD.24: Voicemail / No_Answer added so the post-call analyzer can mark
// unattended calls as retry-eligible instead of falsely terminal Not_Qualified.
// The matching disposition-vocabulary list lives in the Retell post-call
// analysis prompt (Retell agent config), which describes each value:
//   - Transferred: Successfully connected to a licensed agent
//   - Not_Qualified: Live conversation, person not interested or not a fit
//   - Voicemail: Reached voicemail / answering machine, left or attempted message
//   - No_Answer: No pickup, disconnected quickly, or brief unresponsive audio
//   - Callback: Person requested a specific callback time
//   - DNC: Person requested do-not-call / removal
const VALID_DISPOSITIONS = ['Won', 'DNC', 'Callback', 'Not_Qualified', 'No_Decision', 'Transferred', 'Voicemail', 'No_Answer'];

// Coerce a free-text disposition into a constraint-allowed value, or null.
function normalizeDisposition(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  const map = {
    won: 'Won', sale: 'Won', sold: 'Won', closed_won: 'Won', transferred: 'Transferred', enrolled: 'Won',
    dnc: 'DNC', do_not_call: 'DNC', opt_out: 'DNC', opted_out: 'DNC', remove: 'DNC',
    callback: 'Callback', call_back: 'Callback', callback_scheduled: 'Callback', follow_up: 'Callback',
    not_qualified: 'Not_Qualified', unqualified: 'Not_Qualified', disqualified: 'Not_Qualified', not_interested: 'Not_Qualified',
    no_decision: 'No_Decision', undecided: 'No_Decision',
    voicemail: 'Voicemail', voice_mail: 'Voicemail', answering_machine: 'Voicemail', vm: 'Voicemail', left_voicemail: 'Voicemail',
    no_answer: 'No_Answer', noanswer: 'No_Answer', no_pickup: 'No_Answer', unanswered: 'No_Answer', no_response: 'No_Answer',
  };
  if (map[s]) return map[s];
  return VALID_DISPOSITIONS.find((v) => v.toLowerCase() === s) || null;
}

// Heuristic: did this call reach an AI CALL-SCREENER (Google Pixel Call Screen /
// carrier "tell me your name and reason" assistants) rather than a human?
// Spam-flagged numbers trigger these constantly, and the voice agent historically engaged
// them as people and "transferred" into nothing. The screener's transcribed
// turns are unmistakable. Pure; used only to tag transfer_outcome so the metrics
// (and the no-bridge re-queue) can distinguish a screener from a live human who
// hung up. (Call audit 2026-06-26.)
// Extended 2026-07-07 (live go-live audit + research): added Google Call Assist
// ("what you're calling about" / "call assist"), iOS Call Screening ("state your
// name and reason for calling"), Samsung Bixby Text Call, and generic
// "being screened / who's calling and why" signatures. Phrasing is community-
// reported and can drift, so SCREENER_EXTRA_PATTERNS (comma-separated, env) lets
// us extend from real the voice agent call data without a deploy.
const SCREENER_RE =
  /record your name(,)?\s*(and reason)?|see if (this person|they)('| i)?s?\s*(is\s*)?available|(please\s*)?stay on the line|please hold while (i|we)|you'?ve reached [a-z'.]+'?s? (voicemail|phone)|screening (your|this) call|call assist|screening service|what (you'?re|you are) (calling|are calling) about|state your name and( the)? reason|reason for (your )?call(ing)?|\bbixby\b|text call|automated voice|purpose of your call|galaxy ai|being screened|who'?s calling and why/i;
const SCREENER_EXTRA = String(process.env.SCREENER_EXTRA_PATTERNS || '')
  .split(',').map((p) => p.trim()).filter(Boolean);
function transcriptLooksLikeScreener(transcript) {
  if (!transcript || typeof transcript !== 'string') return false;
  if (SCREENER_RE.test(transcript)) return true;
  const lower = transcript.toLowerCase();
  return SCREENER_EXTRA.some((p) => lower.includes(p.toLowerCase()));
}

// IN-CALL screener handling (research 2026-07-07). Retell gives custom-LLM agents
// NO native screener/AMD signal, so we detect from the caller's transcript and
// handle it WITHOUT running the opener/pitch: one concise truthful line, wait for
// a human; if the screener persists, leave a branded callback and end. Truthful
// name+agency+reason only — never trick the screener (FTC/TCPA/CMS). Default ON;
// kill with SCREENER_DETECT_LIVE=0.
const SCREENER_DETECT_LIVE = process.env.SCREENER_DETECT_LIVE !== '0';
// After the concise line, a screener utterance is either TERMINAL (the person is
// unavailable / it's a voicemail → leave callback + end) or a HOLD/connecting
// signal ("please hold while I connect you," "stay on the line," "one moment" →
// a human is INCOMING, so WAIT — do not hang up). Live audit 2026-07-07 showed the
// original always-end logic hung up right as the human was being connected.
const SCREENER_TERMINAL_RE =
  /not available|isn'?t available|un?available|can'?t take (your )?call|cannot take (your )?call|leave (a|your) message|mailbox|voicemail|not accepting|no longer available|good ?bye|have a (nice|great) day|try (your )?call again|full and cannot|press \w+ to/i;
const SCREENER_HOLD_ACK = process.env.SCREENER_HOLD_ACK || 'Sure, thank you.';
const SCREENER_MAX_HOLDS = Number(process.env.SCREENER_MAX_HOLDS || 3);
const SCREENER_LINE =
  process.env.SCREENER_LINE ||
  `Hi, it's ${agentDisplayName()} with ${config.company.name || '{{company}}'}, following up on your inquiry for you.`;
const SCREENER_CALLBACK =
  process.env.SCREENER_CALLBACK ||
  `This is ${agentDisplayName()} with ${config.company.name || '{{company}}'} about your inquiry.${config.transfer.primary ? ` You can reach us back at ${config.transfer.primary}.` : ''} Thanks so much!`;
// One-shot per call: tracks that we've already given the concise screener line
// (so the next screener turn escalates to callback+end). Cleared on WS close.
const screenerHandled = new Map();

// IN-CALL VOICEMAIL / IVR detection (call audit 2026-07-08). Carrier ANSWERING-
// MACHINE greetings leak PAST the screener guard, so the voice agent pitched full openers to
// 8 voicemail systems in one day (13–77s wasted each). Retell gives custom-LLM
// agents no native AMD signal, so — like the screener path — we detect the machine
// greeting from the caller's transcript and, on an EARLY turn only, leave ONE
// branded callback and end. The early-turn gate + machine-specific phrasing keep
// this from firing on a real human who conversationally says "leave a message".
// Default ON; kill with VM_DETECT_LIVE=0.
const VM_DETECT_LIVE = process.env.VM_DETECT_LIVE !== '0';
// Real leaked 2026-07-08 greetings the RE covers: "Please leave your message for
// <name>", "Mailbox is full. To send an SMS notification, press five", "To continue
// your call in English, please press one now", "you've reached", "is not available".
const VOICEMAIL_GREETING_RE =
  /mailbox (is )?full|(please )?leave (a|your) (message|name)|to (send|leave) (an?|a) (sms|text|message)|press (one|1|two|2|five|5|pound)( now)?|to continue your call in (english|spanish)|you'?ve reached|is not available|not accepting (calls|messages)|record your (message|name)( after)?|at the (tone|beep)|voicemail box|no longer in service/i;
// Env-extendable from real the voice agent call data without a deploy (comma-separated),
// mirroring SCREENER_EXTRA_PATTERNS.
const VOICEMAIL_EXTRA = String(process.env.VOICEMAIL_EXTRA_PATTERNS || '')
  .split(',').map((p) => p.trim()).filter(Boolean);
function detectVoicemailGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  if (VOICEMAIL_GREETING_RE.test(text)) return true;
  const lower = text.toLowerCase();
  return VOICEMAIL_EXTRA.some((p) => lower.includes(p.toLowerCase()));
}
const VOICEMAIL_CALLBACK =
  process.env.VOICEMAIL_CALLBACK ||
  `This is ${agentDisplayName()} with ${config.company.name || '{{company}}'} about your inquiry.${config.transfer.primary ? ` Reach us back at ${config.transfer.primary}.` : ''} Thanks!`;
// One-shot per call: the branded voicemail callback is left at most once.
// Cleared on WS close alongside screenerHandled.
const vmHandled = new Set();

// The retell_call_queue.disposition CHECK allows only:
//   Transferred, Callback, DNC, Not_Qualified, Completed, Voicemail, No_Answer, Hung_Up.
// The analyzer vocabulary (VALID_DISPOSITIONS / normalizeDisposition) additionally
// uses 'Won' and 'No_Decision' as INTERNAL signals that drive dialer_status —
// but writing either to the column violates the constraint and rolls
// back the ENTIRE call_analyzed update (disposition, cost, recording, status all
// lost). Translate at the DB boundary only, mirroring the dialer_status logic:
// Won → Transferred (if it bridged) else Completed; No_Decision → Not_Qualified.
// Pure. (Inspector f402e603 P1.)
function toDbDisposition(disposition, transferredToAgent) {
  if (disposition === 'Won') return transferredToAgent ? 'Transferred' : 'Completed';
  if (disposition === 'No_Decision') return 'Not_Qualified';
  return disposition;
}

// Coerce a sentiment value into the CHECK-allowed set.
function normalizeSentiment(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s.startsWith('pos')) return 'Positive';
  if (s.startsWith('neg')) return 'Negative';
  if (s.startsWith('neu')) return 'Neutral';
  return null;
}

// Voicemail detection: explicit Retell disconnection reasons OR the analysis
// in_voicemail flag (voicemail-detection feature).
function isVoicemail(call) {
  const reason = String(call?.disconnection_reason ?? '').toLowerCase();
  if (reason === 'voicemail_reached' || reason === 'voicemail') return true;
  const ca = call?.call_analysis ?? call?.callAnalysis ?? {};
  return ca.in_voicemail === true || ca.inVoicemail === true;
}

// Unanswered (no live person, no voicemail) — retry on the tier cadence.
function isNoAnswer(call) {
  const reason = String(call?.disconnection_reason ?? '').toLowerCase();
  return [
    'dial_no_answer', 'no_answer', 'dial_busy', 'dial_failed',
    'no_valid_payment', 'machine_detected', 'dial_no_pickup',
  ].includes(reason);
}

// Find the queue row this call belongs to: prefer metadata.queue_id, then the
// retell_call_id stamped on the row by the dialing worker.
async function findQueueRecord({ queueId, callId, fromNumber }) {
  if (queueId) {
    const { data, error } = await supabase
      .from('retell_call_queue').select('*').eq('id', queueId).maybeSingle();
    if (error) console.warn('[retell-dialer] queue lookup by id failed', error.message);
    else if (data) return data;
  }
  if (callId) {
    const { data, error } = await supabase
      .from('retell_call_queue').select('*').eq('provider_call_id', callId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) console.warn('[retell-dialer] queue lookup by call_id failed', error.message);
    else if (data) return data;
  }
  // Inbound calls carry neither our metadata.queue_id nor a row-stamped
  // retell_call_id (that id belongs to the prior OUTBOUND dial), so the call log
  // was left unlinked (queue_id=null). Fall back to matching the caller's phone
  // (last-10, format-agnostic) and pick the same row the live call chose
  // (sub-65/the vertical-on-conflict) so linkage and on-call vertical agree.
  if (fromNumber) {
    const last10 = String(fromNumber).replace(/\D+/g, '').slice(-10);
    if (last10.length === 10) {
      const { data, error } = await supabase
        .from('retell_call_queue').select('*')
        .ilike('phone_e164', `%${last10}`)
        .order('lead_created_at', { ascending: false }).limit(10);
      if (error) console.warn('[retell-dialer] queue lookup by phone failed', error.message);
      else {
        const chosen = chooseInboundLead(data);
        if (chosen) return chosen;
      }
    }
  }
  return null;
}

// call_ended: voicemail-per-day limit + no-answer retry. Human disconnects are
// deferred to call_analyzed (the authoritative final-disposition event).
async function handleCallEnded(call, queue) {
  const callId = extractCallId(call);
  const nowIso = new Date().toISOString();
  const now = new Date();
  const durationMs = extractDurationMs(call);
  const recordingUrl = call?.recording_url ?? null;

  if (!queue) {
    console.warn('[retell-dialer] call_ended: no queue record', { callId, queueId: extractQueueId(call) });
    return { branch: 'queue_not_found' };
  }
  const tz = queue.lead_timezone || 'America/New_York';

  const withCost = (update) => {
    if (recordingUrl) update.recording_url = recordingUrl;
    if (durationMs != null) {
      update.duration_seconds = Math.round(durationMs / 1000);
      update.cost_cents = computeCostCents(durationMs);
    }
    return update;
  };

  if (isVoicemail(call)) {
    // Task 15 step 5: count the voicemail; cap at MAX_VOICEMAILS_LIFETIME, and
    // otherwise hold off until the next business morning (max 1 VM/day).
    const newVm = (queue.vm_count ?? 0) + 1;
    const reachedMax = newVm >= MAX_VOICEMAILS_LIFETIME;
    const update = withCost({
      vm_count: newVm,
      provider_call_id: callId || queue.provider_call_id,
      updated_at: nowIso,
    });
    if (reachedMax) {
      update.dialer_status = 'Max_VM_Reached';
    } else {
      update.dialer_status = 'Pending'; // re-dialable (is_lead_callable needs Pending)
      // Direction A: the next-business-morning slot can fall inside the tier
      // cool-down (e.g. an evening VM → ~13h to 9am vs a 24h cool-down), which
      // would read as due but be rejected by is_lead_callable. Clamp to the
      // cool-down floor so next_attempt_at stays authoritative.
      update.next_attempt_at = clampToCooldownFloor(
        nextBusinessDay9amInTz(now, tz),
        queue.cool_down_hours ?? tierConfig(getTier(queue, now)).cool_down_hours,
        now,
      );
    }
    const { error } = await supabase.from('retell_call_queue').update(update).eq('id', queue.id);
    if (error) console.error('[voice-dialer] call_ended voicemail update failed', error.message);
    // Terminal outcome (Max_VM_Reached) → push to the external CRM (no-op for the
    // default supabase leadSource; the GHL lead_queue tag-strip lived here before).
    if (TERMINAL_DIALER_STATUSES.includes(update.dialer_status)) {
      try { await leadSource.writeback(queue, { dialer_status: update.dialer_status }); } catch (_e) { /* best-effort */ }
    }
    return { branch: 'voicemail', vm_count: newVm, dialer_status: update.dialer_status };
  }

  if (isNoAnswer(call)) {
    const tier = getTier(queue, now);
    const update = withCost({
      dialer_status: 'Pending',
      provider_call_id: callId || queue.provider_call_id,
      next_attempt_at: getNextAttemptTime(queue, tier, now),
      updated_at: nowIso,
    });
    const { error } = await supabase.from('retell_call_queue').update(update).eq('id', queue.id);
    if (error) console.error('[retell-dialer] call_ended no-answer update failed', error.message);
    return { branch: 'no_answer', tier, dialer_status: 'Pending' };
  }

  // Human disconnect / other — stamp the call id and wait for call_analyzed.
  const { error } = await supabase
    .from('retell_call_queue')
    .update(withCost({ provider_call_id: callId || queue.provider_call_id, updated_at: nowIso }))
    .eq('id', queue.id);
  if (error) console.error('[retell-dialer] call_ended stamp failed', error.message);
  return { branch: 'await_analysis', reason: String(call?.disconnection_reason ?? '') };
}

// call_analyzed: final disposition. Maps disposition -> dialer_status (with a
// retry-on-cadence fallback for inconclusive connects) and writes the analysis
// onto the queue + call-log rows. The GHL feedback-writeback half was removed;
// leadSource.writeback carries any external-CRM push.
async function handleCallAnalyzed(call, queue) {
  const callId = extractCallId(call);
  const now = new Date();
  const analysis = extractCallAnalysis(call);
  let disposition = normalizeDisposition(analysis.disposition);
  const sentiment = normalizeSentiment(analysis.sentiment);
  const bant_score = analysis.bant_score;

  // Task 21: a confirmed callback time turns this row into a priority appointment.
  // Resolve it in the lead's timezone; a parseable time wins over the generic
  // Callback heuristic below (and applies even if the model didn't tag the
  // disposition Callback). An unparseable value falls through to that heuristic.
  const callbackTimeRaw = analysis.callback_time || null;
  let callbackScheduledAt = null;
  if (callbackTimeRaw) {
    callbackScheduledAt = parseCallbackTime(callbackTimeRaw, queue?.lead_timezone || ET_TIMEZONE);
    console.log('[retell-dialer] callback requested:', callbackTimeRaw, '->', callbackScheduledAt);
  }
  const call_summary = analysis.call_summary;
  const recording_url = call?.recording_url ?? queue?.recording_url ?? null;
  const durationMs = extractDurationMs(call);
  const duration_seconds = durationMs != null ? Math.round(durationMs / 1000) : (queue?.duration_seconds ?? null);
  const cost_cents = durationMs != null ? computeCostCents(durationMs) : (queue?.cost_cents ?? null);
  // R.6: a 'Transferred' disposition with a call_transfer disconnect is a live
  // handoff to a human agent. Treat 'Won' (legacy enrolled-on-call) the same way,
  // and fall back to the Retell-stamped flag for any other transfer signal.
  const disconnectionReason = String(call?.disconnection_reason ?? '').toLowerCase();
  const isLiveTransfer = disposition === 'Transferred' && disconnectionReason === 'call_transfer';
  const transferred_to_agent =
    disposition === 'Won' || isLiveTransfer ? true : Boolean(call?.transferred_to_agent);

  // RD.26 transfer instrumentation. Retell does NOT emit `transfer_outcome` for
  // Custom-LLM cold transfers (the field is always undefined), so the column was
  // historically always null and a FAILED bridge was invisible — the dialer
  // looked like it had "zero transfers" with no way to see whether the voice agent never
  // offered the hand-off vs. offered it and the agency line never picked up.
  // Derive a real outcome from the signals we DO have: disposition='Transferred'
  // means the voice agent emitted a hand-off phrase and we attached transfer_number; the
  // bridge actually completed only when Retell tears the call down with
  // disconnection_reason='call_transfer' (isLiveTransfer). Anything else is an
  // attempted transfer whose bridge did not complete — tag it with the reason so
  // the metrics report can distinguish "agents didn't answer" from a tech fault.
  // A 'Transferred' disposition where the voice agent was actually talking to a call-
  // SCREENER (not a human) is the dominant failure mode (call audit 2026-06-26:
  // 14 of 18 real transfer attempts). Tag those distinctly so the metrics report
  // separates "agent didn't answer" from "never reached a human".
  const hitScreener =
    !isLiveTransfer && transcriptLooksLikeScreener(call?.transcript ?? queue?.transcript);
  let derivedTransferOutcome = call?.transfer_outcome ?? null;
  if (derivedTransferOutcome == null && disposition === 'Transferred') {
    derivedTransferOutcome = isLiveTransfer
      ? 'bridged'
      : `attempted_no_bridge:${hitScreener ? 'screener' : disconnectionReason || 'unknown'}`;
  }

  // P2 phantom-transfer guard — runs AFTER transfer_outcome is derived so the
  // screener marker (transfer_outcome='attempted_no_bridge:screener') survives for
  // the metrics report. A 'Transferred' disposition with no bridge on a screener
  // transcript is a post-call-analyzer MISLABEL (screener holds, never a real
  // hand-off), so remap the DISPOSITION to 'No_Answer' to stop inflating the
  // transfer count — while the transfer_outcome above still records it as a
  // screener attempt. A genuine bridge (transferred_to_agent===true) is untouched.
  if (disposition === 'Transferred' && transferred_to_agent === false && hitScreener === true) {
    console.log(
      "[retell-dialer] P2 phantom-transfer guard: disposition 'Transferred' -> 'No_Answer' (screener hold; transfer_outcome kept)",
      { callId }
    );
    disposition = 'No_Answer';
  }

  // A confirmed callback time wins regardless of disposition — disposition gets
  // forced to 'Callback' below so getTier tiers a missed one to Tier 3 cadence.
  const isScheduledCallback = Boolean(callbackScheduledAt);
  const effectiveDisposition = isScheduledCallback ? 'Callback' : disposition;

  // RD.24: when the analyzer flags an unattended call (voicemail / no-answer)
  // that Retell's signals missed in call_ended, keep it retry-eligible on a 4h
  // cadence for up to MAX_ANALYZED_RETRIES attempts, then stop. Mirrors the
  // call_ended voicemail/no-answer branches but driven by the LLM disposition.
  const MAX_ANALYZED_RETRIES = 3;
  let retry_count; // undefined => leave unchanged

  let dialer_status;
  let next_attempt_at; // undefined => leave unchanged
  if (isScheduledCallback) {
    // Top-priority appointment: the scheduler's callback fast-path honors this at
    // the requested time, even if a normal call is mid-dial.
    dialer_status = 'Callback_Scheduled';
    next_attempt_at = callbackScheduledAt;
  } else if (disposition === 'DNC') {
    dialer_status = 'DNC';
  } else if (disposition === 'Won') {
    dialer_status = transferred_to_agent ? 'Transferred' : 'Completed';
  } else if (disposition === 'Transferred') {
    if (transferred_to_agent) {
      // R.3: confirmed live bridge to a human agent — terminal, never re-dial.
      dialer_status = 'Transferred';
    } else {
      // the voice agent emitted a hand-off but the bridge NEVER completed — it was talking
      // to a call-screener, or the agency line didn't pick up. NO human was
      // reached, so terminalizing as 'Transferred' (the old behavior) silently
      // retired a reachable lead and inflated the transfer count. Re-queue on the
      // failed-connect cadence (bounded), exactly like a voicemail/no-answer, so a
      // real human still gets another shot. (Call audit 2026-06-26.)
      const priorRetries = queue?.retry_count ?? 0;
      if (priorRetries >= MAX_ANALYZED_RETRIES) {
        dialer_status = 'Completed'; // exhausted retries — stop dialing
      } else {
        dialer_status = 'Pending';
        next_attempt_at = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
        retry_count = priorRetries + 1;
      }
    }
  } else if (disposition === 'Callback') {
    // Tier 4: keep dialable (Pending) + disposition=Callback so getTier tiers it
    // 4 and the scheduler places the single callback attempt. ~2 days out is a
    // heuristic when the analysis carries no explicit callback time.
    dialer_status = 'Pending';
    next_attempt_at = new Date(now.getTime() + 2 * 24 * 3600 * 1000).toISOString();
  } else if (disposition === 'Voicemail' || disposition === 'No_Answer') {
    const priorRetries = queue?.retry_count ?? 0;
    if (priorRetries >= MAX_ANALYZED_RETRIES) {
      dialer_status = 'Completed'; // exhausted retries — stop dialing
    } else {
      dialer_status = 'Pending'; // re-dialable (is_lead_callable needs Pending)
      next_attempt_at = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString();
      retry_count = priorRetries + 1;
    }
  } else if (disposition === 'Not_Qualified' || disposition === 'No_Decision') {
    dialer_status = 'Completed'; // no retry
  } else if (sentiment === 'Negative') {
    dialer_status = 'Completed'; // inconclusive + negative → stop
  } else if (queue) {
    // Connected but inconclusive → retry on the tier cadence.
    dialer_status = 'Pending';
    next_attempt_at = getNextAttemptTime(queue, getTier(queue, now), now);
  } else {
    dialer_status = 'Completed';
  }

  if (queue) {
    const update = {
      bant_score,
      disposition: toDbDisposition(effectiveDisposition, transferred_to_agent),
      sentiment,
      call_summary,
      recording_url,
      cost_cents,
      duration_seconds,
      dialer_status,
      provider_call_id: callId || queue.provider_call_id,
      updated_at: now.toISOString(),
    };
    if (next_attempt_at !== undefined) update.next_attempt_at = next_attempt_at;
    if (retry_count !== undefined) update.retry_count = retry_count;
    if (isScheduledCallback) {
      update.callback_scheduled_at = callbackScheduledAt;
      update.callback_confirmed = true;
      update.priority_score = 100; // callbacks get top priority
    }
    const { error } = await supabase.from('retell_call_queue').update(update).eq('id', queue.id);
    if (error) console.error('[retell-dialer] call_analyzed queue update failed', error.message);
  } else {
    console.warn('[retell-dialer] call_analyzed: no queue record', { callId, queueId: extractQueueId(call) });
  }

  // Log the call. queue_id is nullable; to_number / retell_call_id are NOT NULL.
  const to_number = call?.to_number ?? queue?.phone_e164 ?? null;
  let logId = null;
  if (callId && to_number) {
    const logRow = {
      queue_id: queue ? queue.id : null,
      provider_call_id: callId,
      call_direction: call?.direction ?? call?.call_direction ?? 'outbound',
      from_number: call?.from_number ?? queue?.from_number ?? null,
      to_number,
      duration_seconds,
      cost_cents,
      disconnection_reason: call?.disconnection_reason ?? null,
      transcript: call?.transcript ?? null,
      bant_score,
      disposition: effectiveDisposition,
      sentiment,
      call_summary,
      recording_url,
      transferred_to_agent,
      transfer_outcome: derivedTransferOutcome,
      callback_requested_at: callbackScheduledAt,
      callback_time_raw: callbackTimeRaw,
    };
    // P4 idempotency guard. Retell retries the terminal call webhook, which
    // previously inserted a duplicate retell_call_log row per retry (observed:
    // 3 identical rows for one call). retell_call_id has NO DB unique
    // constraint (verified 2026-07-08), so upsert(onConflict) is not available
    // — guard in code: if a row for this retell_call_id already exists, UPDATE
    // it; otherwise INSERT. Idempotent per retell_call_id. An existence-check
    // error fails open to INSERT (never drop the log; worst case is the prior
    // duplicate behavior).
    const { data: existingLog, error: existErr } = await supabase
      .from('retell_call_log')
      .select('id')
      .eq('provider_call_id', callId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existErr) {
      console.error('[retell-dialer] call_analyzed log existence check failed', existErr.message);
    }
    if (existingLog && existingLog.id) {
      const { error } = await supabase
        .from('retell_call_log')
        .update(logRow)
        .eq('id', existingLog.id);
      if (error) console.error('[retell-dialer] call_analyzed log update failed', error.message);
      else {
        logId = existingLog.id;
        console.log(
          `[retell-dialer] P4 idempotency: updated existing retell_call_log id=${existingLog.id} for ${callId} (webhook retry)`
        );
      }
    } else {
      const { data: loggedRow, error } = await supabase
        .from('retell_call_log')
        .insert(logRow)
        .select('id')
        .single();
      if (error) console.error('[retell-dialer] call_analyzed log insert failed', error.message);
      else logId = loggedRow ? loggedRow.id : null;
    }
  }

  // External-CRM writeback (was the GHL PHI-safe feedback: notes + tags + custom
  // fields). Now a single neutral hook through the leadSource adapter — a no-op
  // for the default supabase system-of-record, and the seam where a CRM adapter
  // pushes disposition/sentiment/summary back. Best-effort: never breaks the
  // post-call webhook.
  if (queue) {
    try {
      await leadSource.writeback(queue, {
        dialer_status,
        disposition: effectiveDisposition,
        sentiment,
        bant_score,
        call_summary,
        callback_scheduled_at: callbackScheduledAt,
        call_date_iso: now.toISOString(),
      });
    } catch (err) {
      console.error('[voice-dialer] leadSource.writeback failed:', err && err.message);
    }
  }

  return { dialer_status, disposition: effectiveDisposition, sentiment, bant_score, callback_scheduled_at: callbackScheduledAt };
}

// Verify a Retell webhook signature. Reimplements Retell's published algorithm
// (formerly retell-sdk lib/webhook_auth.js, removed in the v5 rewrite):
//   - header format: `v=<unix_ms_timestamp>,d=<hex_digest>`
//   - digest = HMAC-SHA256(rawBody + timestamp), keyed by the API key, hex-encoded
//   - reject if the timestamp is older/newer than the 5-minute freshness window
// `rawBody` MUST be the raw request bytes (req.rawBody), not JSON.stringify(req.body).
const RETELL_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

function verifyRetellSignature(rawBody, apiKey, signature) {
  if (typeof rawBody !== 'string' || !apiKey || typeof signature !== 'string') {
    return false;
  }
  const match = /v=(\d+),d=(.*)/.exec(signature);
  if (!match) return false;
  const timestamp = Number(match[1]);
  const digest = match[2];
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() - timestamp) > RETELL_SIGNATURE_TOLERANCE_MS) return false;
  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(rawBody + timestamp)
    .digest('hex');
  // Constant-time comparison; timingSafeEqual requires equal-length buffers.
  const expectedBuf = Buffer.from(expected, 'utf8');
  const digestBuf = Buffer.from(digest, 'utf8');
  if (expectedBuf.length !== digestBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, digestBuf);
}

// Retell post-call webhook. Receives ALL Retell events; acts on call_ended and
// call_analyzed. Signature is verified against RETELL_API_KEY before any work.
app.post('/retell-webhook', async (req, res) => {
  if (!RETELL_API_KEY) {
    console.error('[retell-dialer] /retell-webhook hit but RETELL_API_KEY is not set');
    return res.status(500).json({ ok: false, reason: 'signature_verification_unavailable' });
  }
  const signature = req.headers['x-retell-signature'];
  let validSignature = false;
  try {
    // Verify the HMAC over the RAW request bytes (req.rawBody), never the
    // re-serialised body — Retell signs the exact bytes it sent.
    validSignature = verifyRetellSignature(req.rawBody, RETELL_API_KEY, signature);
  } catch (e) {
    console.warn('[retell-dialer] signature verification threw', e.message);
    validSignature = false;
  }
  if (!validSignature) {
    return res.status(401).json({ ok: false, reason: 'invalid_signature' });
  }

  const payload = req.body || {};
  const event = getRetellEvent(payload);
  const call = getRetellCall(payload);

  try {
    if (!call) {
      return res.status(200).json({ ok: true, event, note: 'no_call_object' });
    }
    const callId = extractCallId(call);
    const queueId = extractQueueId(call);
    const queue = await findQueueRecord({ queueId, callId, fromNumber: call.from_number });

    if (event === 'call_ended') {
      const result = await handleCallEnded(call, queue);
      return res.status(200).json({ ok: true, event, ...result });
    }
    if (event === 'call_analyzed') {
      const result = await handleCallAnalyzed(call, queue);
      return res.status(200).json({ ok: true, event, ...result });
    }
    // call_started / call_registered / unknown — acknowledge without acting.
    return res.status(200).json({ ok: true, event: event ?? 'unknown', note: 'ignored' });
  } catch (err) {
    console.error('[retell-dialer] /retell-webhook handler error', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// --- /retell-llm turn handler ------------------------------------------------

// Build a Retell response for a turn that requires the agent to speak
// (response_required / reminder_required). Enriches the BANT system prompt with
// lead history, avatar psychology, product knowledge, and a compliance reminder,
// then proxies the turn to Claude (via the LLM).
//
// `turn` is the per-turn WebSocket event (response_id + transcript). `callObject`
// is the `call` object cached from the call_details event (dynamic_variables +
// metadata), which per-turn events do not repeat — they are merged so prompt
// enrichment sees both.
//
// Latency-sensitive: the lead lookup is timeout-capped and cached per call, the
// upstream call has a hard timeout, and this ALWAYS resolves to a valid Retell
// response (never throws) so any failure degrades gracefully instead of dropping
// the live call.
async function buildRetellLlmResponse(turn, callObject, callbackPrefix = '', greetingAlreadySent = false, streamSink = null) {
    var _t = turn && typeof turn === "object" ? turn : {}; var _tr = Array.isArray(_t.transcript) ? _t.transcript : []; if (_tr.length === 0 && FIRST_MESSAGE_GREETING && !greetingAlreadySent) { console.log("[retell-dialer] first turn — instant greeting"); return { response_id: _t.response_id || 0, content: FIRST_MESSAGE_GREETING, content_complete: true, end_call: false }; }
  const t = turn && typeof turn === 'object' ? turn : {};
  const responseId = t.response_id ?? 0;

  // Merge the cached call object (dynamic_variables + metadata) under `call` so
  // extractCallContext resolves queue_id / dynamic vars on every turn, not just
  // the first. A `call` key already on the turn wins for any overlapping field.
  const merged =
    callObject && typeof callObject === 'object'
      ? { ...t, call: { ...callObject, ...(t.call && typeof t.call === 'object' ? t.call : {}) } }
      : t;

  // Transcript lives on the per-turn event; fall back to the call object's copy.
  const transcript = Array.isArray(t.transcript)
    ? t.transcript
    : callObject && Array.isArray(callObject.transcript)
    ? callObject.transcript
    : [];

  try {
    const { queueId, callId, dynamicVariables, metadata } = extractCallContext(merged);

    // Enrichment is best-effort and must NEVER block or break the call. On any
    // failure we still inject the compliance reminder and proceed.
    let enrichmentSections;
    // BANT one-liner for the warm-transfer whisper, captured from the same lead
    // lookup the enrichment uses. Best-effort: stays '' if the lookup is empty
    // or fails, and buildWhisperMessage supplies a safe default in that case.
    let bantSummary = '';
    try {
      const transcriptText = recentTranscriptText(transcript);
      const cacheKey = callId || queueId || null;
      const leadContext = queueId ? await getLeadContext(cacheKey, queueId) : null;
      const prev = leadContext && leadContext.previousCall;
      if (prev) {
        const segs = [];
        if (prev.bant_score != null) segs.push(`score ${prev.bant_score}`);
        if (prev.call_summary) segs.push(String(prev.call_summary).trim());
        bantSummary = segs.join(' — ');
      }
      enrichmentSections = buildEnrichmentSections({
        knowledge: KNOWLEDGE,
        leadContext,
        dv: dynamicVariables,
        transcriptText,
      });
    } catch (enrichErr) {
      console.error(
        '[retell-dialer] enrichment failed, using static prompt + compliance',
        enrichErr && enrichErr.message
      );
      enrichmentSections = [COMPLIANCE_REMINDER];
    }

    // An inbound callback (detected at call_details) rewrites the call's opening
    // posture, so its prefix leads the system prompt ahead of the BANT base + enrichment.
    var verticalScript = loadVerticalScript((dynamicVariables || {}).vertical || (dynamicVariables || {}).product_interest || "");
    // Inbound: load the inbound call flow (the caller phoned US). Goes right after
    // the base persona/compliance prompt so its opener + transfer-first flow
    // overrides the outbound "following up" framing while keeping all the base
    // compliance rules (TPMO, no-PHI, DNC) in force.
    var inboundScript = isInboundCall(callObject) ? loadInboundScript() : "";
    if (inboundScript) {
      console.log(`[retell-dialer] voice INBOUND call — inbound-script.txt loaded (call_id=${callId || 'unknown'})`);
    }
    const systemContent =
      (callbackPrefix || '') +
      [(SYSTEM_PROMPT_TEMPLATE ? SYSTEM_PROMPT_TEMPLATE.replace(/{{lead_name}}/g,(dynamicVariables||{}).lead_name||'there').replace(/{{agent_name}}/g,(dynamicVariables||{}).agent_name||agentDisplayName()).replace(/{{product_interest}}/g,(dynamicVariables||{}).product_interest||(config.company.segmentLabel||'coverage')).replace(/{{vertical}}/g,(dynamicVariables||{}).vertical||(config.company.segmentLabel||'')) : buildSystemPrompt(dynamicVariables)), inboundScript, verticalScript, ...enrichmentSections].join('\n\n');
    const messages = [
      { role: 'system', content: systemContent },
      ...mapTranscriptToMessages(transcript),
    ];

    // TCPA: an opt-out must be honored immediately. This is a local transcript
    // scan, so it does NOT depend on the model being reachable — evaluate it up
    // front so an opt-out is still honored when the LLM is down.
    const callerOptedOut = containsDncSignal(lastUserUtterance(transcript));

    const _llmStart = Date.now();
    // Stream only when a sink is supplied AND the flag is on. When streaming, the
    // reply is sent to Retell as deltas (content_complete:false) AS IT GENERATES,
    // so the returned final frame carries empty content (the words are already on
    // the wire). callLLMStream still accumulates the full text for the
    // transfer / opt-out logic below.
    const streaming = RETELL_VOICE_STREAMING && typeof streamSink === 'function';
    let _firstDeltaMs = null;
    let _sentAny = false;
    // RD.26 UNDER STREAMING: Retell executes a transfer only after the content of
    // that response is FULLY SPOKEN. Non-streaming protected the transfer sentence
    // with no_interruption_allowed on the single frame — but streamed deltas carried
    // no such flag, so a caller barge-in during the spoken line interrupted it and
    // Retell silently dropped the pending transfer (live repro call_375be1b4, dead
    // air after "hold one moment"). Fix: detect the transfer phrase INCREMENTALLY in
    // the accumulating stream ("let me connect you…" appears early) and stamp
    // no_interruption_allowed on every delta from that point on, so the rest of the
    // transfer sentence — including the closing trigger line — is barge-in-proof.
    let _acc = '';
    let _protect = false;
    const result = streaming
      ? await callLLMStream(messages, (delta) => {
          if (_firstDeltaMs === null) _firstDeltaMs = Date.now() - _llmStart;
          _sentAny = true;
          _acc += delta;
          if (!_protect && detectTransferIntent(_acc)) _protect = true;
          streamSink(delta, { noInterrupt: _protect });
        })
      : await callLLM(messages);
    // Per-turn voice latency. Logs model + total ms + (streaming) time-to-first-byte
    // + reply length so we can compare streaming vs non-streaming. Never throws.
    console.log(
      `[retell-dialer] voice-turn model=${RETELL_VOICE_MODEL} stream=${streaming} ms=${Date.now() - _llmStart}` +
        (streaming && _firstDeltaMs !== null ? ` ttfb=${_firstDeltaMs}` : '') +
        ` ok=${result.ok}` +
        (result.ok ? ` chars=${result.content.length}` : ` reason=${result.reason}`)
    );

    if (!result.ok) {
      // Model unreachable. If the caller opted out we MUST still end the call;
      // otherwise the fallback keeps the call alive without surfacing the error.
      // When streaming already put words on the wire, close the response with an
      // empty content_complete frame (don't append the fallback after a partial
      // reply) — but still honor an opt-out with the DNC ack + end_call.
      if (callerOptedOut) markDncFromCall(callObject, dynamicVariables, callId);
      if (streaming && _sentAny) {
        return {
          response_id: responseId,
          content: callerOptedOut ? ` ${RETELL_DNC_ACK}` : '',
          content_complete: true,
          end_call: callerOptedOut,
          response_type: 'response',
        };
      }
      return {
        response_id: responseId,
        content: callerOptedOut ? RETELL_DNC_ACK : RETELL_FALLBACK,
        content_complete: true,
        end_call: callerOptedOut,
        response_type: 'response',
      };
    }

    // Honor TCPA opt-outs immediately: end the call when the caller asks to stop
    // or the model acknowledges a stop request. DNC primitive: also record the
    // number on the do-not-call list via the leadSource adapter (one-shot).
    const end_call = callerOptedOut || containsDncSignal(result.content);
    if (end_call) markDncFromCall(callObject, dynamicVariables, callId);

    // When streaming, the words are already on the wire as deltas — the final
    // frame just closes the response (content_complete) and carries any
    // end_call / transfer_number flags. When not streaming, it carries the full text.
    const responseMsg = {
      response_id: responseId,
      content: streaming ? '' : result.content,
      content_complete: true,
      end_call,
      response_type: 'response',
    };

    // Transfer (RD.22): simple cold transfer to the agency main line.
    // Reverts the RD.5 warm-transfer machinery (triggerWarmTransfer / per-agent
    // Warm transfer is NOT supported for Retell Custom-LLM agents. When transfer
    // intent is detected we attach the documented `transfer_number` field (which
    // Retell processes) and let Retell initiate the SIP transfer to the configured
    // transfer number (config.transfer.primary). No per-agent routing, no warm attempt.
    if (!end_call && detectTransferIntent(result.content)) {
      // WRONG-PERSON guard (audit 2026-07-08): if the CALLER explicitly denied
      // being the lead, never bridge them to a live agent. Checked BEFORE the
      // transfer fields are attached; on a hit we simply do not set transfer_number
      // (nor arm the in-flight guard / card), so the already-built responseMsg
      // proceeds and the voice agent closes gracefully. Only an explicit identity denial
      // trips this, so a legitimate transfer is never blocked.
      if (
        WRONGPERSON_GUARD_LIVE &&
        detectWrongPerson(transcript, (dynamicVariables || {}).lead_name || '')
      ) {
        console.log(
          `[retell-dialer] WRONG-PERSON — transfer blocked (call_id=${callId || 'unknown'})`
        );
      } else if (callId && transferInitiated.has(String(callId))) {
        // RD.25: a transfer is already in flight for this call — this is a
        // duplicate transfer signal from a racing LLM build. Transfer is
        // ONE-SHOT per call: do NOT attach transfer fields, so the send-site
        // post-transfer guard drops this frame instead of letting a second
        // (possibly stale-response_id) transfer frame chase the first.
        console.log('[retell-dialer] duplicate transfer signal ignored (transfer already in flight)');
      } else {
      // RD.26 — THE TRANSFER FIX. Retell's custom-LLM docs: the call transfers
      // ONLY "after content associated with this id is fully spoken." So we MUST
      // forbid interruption — otherwise any caller barge-in (or a turn flip during
      // the spoken line) leaves the content unfinished and the transfer NEVER
      // executes. That was the 0-successful-transfers bug (RD.22 had reverted
      // no_interruption_allowed, so the reply was interruptible and the pending
      // transfer kept getting wiped — card fired, call never bridged). We KEEP the
      // model's own transfer sentence (the scripts keep it to one short line that
      // can carry the multi-carrier disclosure) and make it uninterruptible so it
      // finishes and the transfer fires. (docs.retellai.com/api-references/llm-websocket)
      responseMsg.content_complete = true;
      responseMsg.no_interruption_allowed = true;
      responseMsg.end_call = false;
      responseMsg.transfer_number = COLD_TRANSFER_NUMBER;
      // RD.27: do NOT set show_transferee_as_caller. The default cold transfer is
      // SIP REFER, and per Retell's 2026-01-23 deprecation note caller-ID override
      // (show_transferee_as_caller) only applies to cold_transfer_mode='sip_invite'.
      // On our imported/custom SIP number a REFER carrying that flag can be
      // silently rejected by the carrier — the prime suspect for the transfer
      // firing (COLD TRANSFER logged) but never bridging. transfer_number is a
      // REAL custom-LLM response field (verified in RetellAI/retell-custom-llm-node-
      // demo types.ts: ResponseResponse.transfer_number), so the mechanism is
      // correct; if it still doesn't bridge after this, the imported SIP trunk
      // needs SIP REFER + PSTN transfer enabled (provider-side config).
      // RD.21b: record the in-flight transfer so the WS handler suppresses every
      // subsequent turn for this call until the connection closes.
      if (callId) transferInitiated.set(String(callId), Date.now());
      console.log('[retell-dialer] COLD TRANSFER to agency main line', COLD_TRANSFER_NUMBER);
      // Post the the notifier "call_in_progress" leads card at the transfer moment.
      // This replaces the old flat 60s timer (which fired on every call,
      // regardless of outcome, far too early). Fully-populated context is in
      // scope here: queueId/callId/dynamicVariables/metadata came from
      // extractCallContext(merged) above, and callObject is this function's arg.
      // Best-effort + one-shot (callInProgressCardSent) — never throws, never
      // blocks, and is purely additive to the transfer_number frame.
      postCallInProgressCard({ callId, dynamicVariables, metadata, queueId, callObject });
      }
    }

    // (Voice appointment-booking was removed with the SMS/booking half — this is
    // a voice-only dialer. A lead who wants a scheduled callback is handled by the
    // post-call disposition/callback flow, not an in-call booking side effect.)

    return responseMsg;
  } catch (err) {
    console.error('[retell-dialer] retell-llm handler error', err);
    return {
      response_id: responseId,
      content: RETELL_FALLBACK,
      content_complete: true,
      end_call: false,
      response_type: 'response',
    };
  }
}

// --- /retell-llm WebSocket (Retell Custom LLM) -------------------------------
// Retell connects to wss://api.the companyinsuranceadvisors.com/retell/retell-llm
// (nginx strips the /retell/ prefix and forwards the upgrade to this server).
// Protocol: https://docs.retellai.com/api-references/llm-websocket
//   - On connect we send a `config` event asking Retell to deliver call_details.
//   - Retell then streams events keyed by `interaction_type`:
//       config            → Retell's own config echo (no action).
//       call_details      → full call object (dynamic_variables + metadata); cache it.
//       update_only       → transcript sync only; the agent must NOT speak. Log + ignore.
//       response_required → the agent must speak: enrich, call the model, reply.
//       reminder_required → gentle nudge when the caller is silent; handled identically.
//       ping_pong         → keepalive; echo the timestamp.
//   - Every spoken reply is { response_id, content, content_complete, end_call,
//     response_type: "response" }.
//   - Disconnects are logged as call end.

// Send JSON to a Retell socket, swallowing errors so a dead socket never throws
// into the message handler / live call path.
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch (err) {
    console.error('[retell-dialer] retell-llm WS send failed', err && err.message);
  }
}

// RD.6 — build the voice agent's personalized opening line for the proactive
// "speaks first" greeting. Pulls lead_name out of the cached call object's
// dynamic_variables (extractCallContext is null/shape-safe). Falls back to
// "there" when the name is missing so the greeting always reads naturally.
function buildFirstGreeting(callObject) {
  let dv = {};
  try {
    const ctx = extractCallContext(
      callObject && typeof callObject === 'object' ? { call: callObject } : {}
    );
    dv = ctx.dynamicVariables || {};
  } catch {
    dv = {};
  }
  const leadName = (dv.lead_name && String(dv.lead_name).trim()) || 'there';
  // Segment-neutral opener. The original hardcoded the vertical/the vertical the voice agent/the company
  // scripts; the starter builds a generic personalized intro from config +
  // RETELL_FIRST_GREETING_TEMPLATE ({{name}}/{{agent}}/{{company}} placeholders),
  // so any business identity lives in config/env, not the code. Put a
  // segment-specific opener in knowledge/vertical-script.txt instead.
  const company = config.company.name || '{{company}}';
  const agent = agentDisplayName();
  const tmpl = process.env.RETELL_FIRST_GREETING_TEMPLATE ||
    "Hi {{name}}, it's {{agent}} with {{company}} — I'm following up on your inquiry. How can I help you today?";
  return tmpl
    .replace(/{{\s*name\s*}}/g, leadName)
    .replace(/{{\s*agent\s*}}/g, agent)
    .replace(/{{\s*company\s*}}/g, company);
}

// Pull the trailing call_id segment out of a /retell-llm[/<call_id>] path.
function callIdFromPath(reqUrl) {
  try {
    const pathname = new URL(reqUrl, 'http://localhost').pathname;
    const segs = pathname.split('/').filter(Boolean); // e.g. ['retell-llm','abc123']
    return segs.length > 1 ? segs[segs.length - 1] : null;
  } catch {
    return null;
  }
}

// Attach the Retell Custom-LLM WebSocket to an existing HTTP server. Sharing the
// server means nginx's existing port-4002 proxy (with Upgrade headers) already
// routes the wss handshake — no extra listener/port.
//
// We use `noServer` + a manual upgrade handler instead of ws's exact-match
// `path` option because Retell appends the call_id as a trailing path segment
// (…/retell-llm/<call_id>); an exact `/retell-llm` match would 400 every real
// call. We accept the `/retell-llm` prefix and reject everything else.
function attachRetellLlmSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/retell-llm' || pathname.startsWith('/retell-llm/')) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const startedAt = Date.now();
    // Retell appends the call_id as a trailing path segment in production
    // (…/retell-llm/<call_id>); we also learn it from the call_details event.
    let callId = callIdFromPath(req && req.url);
    let callObject = null; // cached `call` (dynamic_variables + metadata) from call_details
    // Inbound-callback prompt prefix, resolved once from call_details and reused
    // for every turn. Empty string for outbound dialer calls (the common case).
    let callbackPrefix = '';
    // RD.6 — one-shot guard so the voice agent's proactive opening greeting is pushed at
    // most once per WS connection (and never re-fired by the response_required
    // first-turn fallback in buildRetellLlmResponse).
    let greetingSent = false;
    // RD.10 — one-shot guard for the deferred full introduction. After the short
    // "Hello!" goes out on call_details, the full personalized intro is pushed on
    // the FIRST response_required turn (i.e. once the lead has replied), then the
    // model takes over for every subsequent turn.
    let fullIntroSent = false;

    // Early the notifier awareness ("the voice agent on a call" leads card) is now posted from the
    // transfer-intent moment inside buildRetellLlmResponse via postCallInProgressCard
    // (one-shot per call, guarded by the module-level callInProgressCardSent Set).
    // The old connection-scoped 60s setTimeout (earlyTeamsNotifySent / earlyTeamsTimer)
    // was removed: it fired on every call regardless of outcome and far too early.

    console.log(`[retell-dialer] retell-llm WS connected (call_id=${callId || 'pending'})`);

    // Declare the optional features we want. call_details delivers the
    // dynamic_variables + metadata enrichment depends on.
    safeSend(ws, {
      response_type: 'config',
      config: { auto_reconnect: true, call_details: true },
    });

    ws.on('message', async (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch (err) {
        console.error('[retell-dialer] retell-llm WS: bad JSON frame, ignoring', err && err.message);
        return;
      }

      const type = event.interaction_type;

      // Keepalive — echo the timestamp, no model work.
      if (type === 'ping_pong') {
        safeSend(ws, { response_type: 'ping_pong', timestamp: event.timestamp });
        return;
      }

      // Full call object: cache dynamic_variables + metadata for subsequent turns.
      if (type === 'call_details') {
        if (event.call && typeof event.call === 'object') {
          callObject = event.call;
          callId = callObject.call_id || callId;
        }
        console.log(`[retell-dialer] retell-llm WS call_details (call_id=${callId || 'unknown'})`);
        // Detect an inbound callback once per call and cache its prompt prefix.
        // Best-effort: detectCallback swallows its own errors, but guard here too
        // so a detection failure can never break the live call.
        try {
          const callbackResult = await detectCallback(callObject);
          callbackPrefix = buildCallbackPromptPrefix(callbackResult);
          // Propagate the matched lead's CORRECTED vertical + identity + queue_id
          // into this call's dynamic_variables so the live prompt (vertical script,
          // CMS rules, enrichment) and call-log linkage use the lead's REAL vertical
          // — overriding any stale the vertical framing Retell replays from a prior
          // outbound. detectCallback already applied the sub-65 / the vertical-on-conflict
          // rule (operator 2026-06-19). Without this, an inbound the vertical lead was run as
          // the vertical (queue_id unlinked, wrong CMS-restricted script).
          const ctx = callbackResult && callbackResult.context;
          if (ctx && callObject && typeof callObject === 'object') {
            const dv =
              callObject.dynamic_variables && typeof callObject.dynamic_variables === 'object'
                ? callObject.dynamic_variables
                : {};
            callObject.dynamic_variables = {
              ...dv,
              ...(ctx.vertical ? { vertical: ctx.vertical } : {}),
              ...(ctx.product_interest ? { product_interest: ctx.product_interest } : {}),
              ...(ctx.contact_name ? { lead_name: ctx.contact_name } : {}),
              ...(ctx.assigned_agent ? { agent_name: ctx.assigned_agent } : {}),
            };
            if (ctx.queue_id) {
              const md =
                callObject.metadata && typeof callObject.metadata === 'object' ? callObject.metadata : {};
              if (!md.queue_id) callObject.metadata = { ...md, queue_id: ctx.queue_id };
            }
            console.log(
              `[retell-dialer] inbound matched queue_id=${ctx.queue_id || 'n/a'} vertical=${ctx.vertical || 'n/a'} (corrected; overrode replayed dynamic vars)`
            );
          }
        } catch (cbErr) {
          console.error('[retell-dialer] callback detection failed', cbErr && cbErr.message);
          callbackPrefix = '';
        }
        // RD.6 + RD.10 — the voice agent speaks first, in two parts. A Custom LLM WebSocket
        // agent has no begin_message / first_sentence / start_speaker (those are
        // retell-llm-only fields), so the agent opens the call ONLY if the server
        // proactively pushes a response event. We do that here, the moment
        // call_details delivers the dynamic variables, and do NOT wait for a
        // response_required event. RD.10: this proactive opener now says only a
        // short, natural "Hello!" — the full personalized introduction is deferred
        // to the first response_required turn (after the lead replies). Skipped for
        // inbound callbacks: the lead initiated the call and speaks first, so the
        // normal model-driven flow handles that opening instead.
        // Inbound: the voice agent is ANSWERING the phone, so she always greets (even a
        // matched callback) with the inbound answer. Outbound: unchanged — greet
        // with the short "Hello!" only when this isn't a matched callback.
        const inbound = isInboundCall(callObject);
        if (!greetingSent && (inbound || !callbackPrefix)) {
          greetingSent = true;
          safeSend(ws, {
            response_id: 0,
            content: inbound ? INBOUND_GREETING : SHORT_GREETING,
            content_complete: true,
            end_call: false,
            response_type: 'response',
          });
          console.log(
            `[retell-dialer] proactive ${inbound ? 'INBOUND' : 'short'} greeting sent ` +
              `(call_id=${callId || 'unknown'}, inbound=${inbound}, matched_callback=${!!callbackPrefix})`
          );
        }
        return;
      }

      // Transcript sync only — the agent must not speak.
      if (type === 'update_only') {
        return;
      }

      // The agent must speak: response_required (normal) or reminder_required (nudge).
      if (type === 'response_required' || type === 'reminder_required') {
        // RD.25: once a cold transfer has been initiated for this call, suppress
        // ALL further agent frames. The RD.20–23 known-good contract is that
        // `transfer_number` rides the natural LLM response and NOTHING follows
        // it — answering a post-transfer response_required with ANY response
        // frame (even RD.21b's empty no-op with no_interruption_allowed) hands
        // Retell a newer agent action for the call and wipes the pending SIP
        // handoff. So: drop the event silently — send nothing. Stays in effect
        // until the WS connection closes.
        if (callId && transferInitiated.has(String(callId))) {
          console.log(
            `[retell-dialer] post-transfer ${type} suppressed (call_id=${callId})`
          );
          return;
        }

        // VOICEMAIL / IVR: intercept BEFORE the opener/pitch (and before the
        // screener guard). Carrier answering-machine greetings leak past the
        // screener detector, so the voice agent was pitching full openers to voicemail
        // systems (2026-07-08 audit: 8 in one day). On an EARLY turn (<=3 user
        // turns) and only when this call is NOT already being handled as a screener,
        // an answering-machine greeting → leave ONE branded callback + end. One-shot
        // per call (vmHandled). The early-turn gate + machine-specific phrasing keep
        // this from firing on a real human who says "leave a message".
        if (type === 'response_required' && VM_DETECT_LIVE) {
          const uTurns = Array.isArray(event.transcript)
            ? event.transcript.filter((t) => t && t.role === 'user')
            : [];
          const lastU = uTurns.length ? String(uTurns[uTurns.length - 1].content || '') : '';
          const key = String(callId || '');
          if (
            !vmHandled.has(key) &&
            !screenerHandled.has(key) &&
            // Defer to the screener handler when the greeting ALSO reads as a
            // screener (e.g. "record your name and reason … I'll see if they're
            // available") — that path waits for a human; only a pure answering
            // machine is handled here.
            !transcriptLooksLikeScreener(lastU) &&
            uTurns.length <= 3 &&
            detectVoicemailGreeting(lastU)
          ) {
            vmHandled.add(key);
            safeSend(ws, {
              response_id: event.response_id ?? 0,
              content: VOICEMAIL_CALLBACK,
              content_complete: true,
              no_interruption_allowed: true,
              end_call: true,
              response_type: 'response',
            });
            console.log(`[retell-dialer] VOICEMAIL detected — left callback + end (call_id=${key})`);
            return;
          }
        }

        // SCREENER: intercept BEFORE the opener/pitch. If the caller's utterance is
        // an AI call-screener (Google Call Assist / iOS / Bixby / carrier), do NOT
        // run the voice agent's opener at the robot (the live #1 leak — it gets spam-flagged
        // and hung up). First screener turn → ONE concise truthful line, wait for a
        // human. If the screener keeps talking → branded callback + end_call. If a
        // human joins (utterance no longer screener-like), fall through to normal.
        if (type === 'response_required' && SCREENER_DETECT_LIVE) {
          const uTurns = Array.isArray(event.transcript)
            ? event.transcript.filter((t) => t && t.role === 'user')
            : [];
          const lastU = uTurns.length ? String(uTurns[uTurns.length - 1].content || '') : '';
          const isScreener = transcriptLooksLikeScreener(lastU);
          const key = String(callId || '');
          if (screenerHandled.has(key)) {
            if (isScreener) {
              // Still the screener after our concise line. TERMINAL (person
              // unavailable / voicemail) → leave callback + end. Otherwise it's a
              // HOLD/connecting signal ("please hold while I connect you," "stay on
              // the line") = a human is INCOMING → WAIT (brief ack, don't hang up).
              if (SCREENER_TERMINAL_RE.test(lastU)) {
                safeSend(ws, {
                  response_id: event.response_id ?? 0,
                  content: SCREENER_CALLBACK,
                  content_complete: true,
                  no_interruption_allowed: true,
                  end_call: true,
                  response_type: 'response',
                });
                console.log(`[retell-dialer] SCREENER terminal — branded callback + end_call (call_id=${key})`);
                return;
              }
              const holds = Number(screenerHandled.get(key)) || 0;
              if (holds < SCREENER_MAX_HOLDS) {
                // Human being connected — acknowledge briefly and keep waiting.
                screenerHandled.set(key, holds + 1);
                safeSend(ws, {
                  response_id: event.response_id ?? 0,
                  content: SCREENER_HOLD_ACK,
                  content_complete: true,
                  no_interruption_allowed: true,
                  end_call: false,
                  response_type: 'response',
                });
                console.log(`[retell-dialer] SCREENER hold #${holds + 1} — waiting for human (call_id=${key})`);
                return;
              }
              // Held too long with no human → leave callback + end.
              safeSend(ws, {
                response_id: event.response_id ?? 0,
                content: SCREENER_CALLBACK,
                content_complete: true,
                no_interruption_allowed: true,
                end_call: true,
                response_type: 'response',
              });
              console.log(`[retell-dialer] SCREENER hold cap reached — callback + end_call (call_id=${key})`);
              return;
            }
            // Not a screener utterance anymore → a human joined; fall through to normal flow.
          } else if (isScreener && uTurns.length <= 3) {
            // First screener turn (early only, to avoid false positives on a
            // curious human mid-conversation) → one concise truthful line, wait.
            screenerHandled.set(key, 0);
            safeSend(ws, {
              response_id: event.response_id ?? 0,
              content: SCREENER_LINE,
              content_complete: true,
              no_interruption_allowed: true,
              end_call: false,
              response_type: 'response',
            });
            console.log(`[retell-dialer] SCREENER detected — concise line sent, awaiting human (call_id=${key})`);
            return;
          }
        }

        // (Removed) The 60s early-the notifier-alert timer used to be armed here on the
        // first response_required turn. The "call_in_progress" card is now posted
        // from the transfer-intent moment in buildRetellLlmResponse — see
        // postCallInProgressCard — so it fires only when (and only when) the voice agent
        // actually hands off, never on a blanket timer.

        // RD.10 — part two of the two-part greeting. The short "Hello!" already
        // went out on call_details; now that the lead has replied (this is the
        // first response_required turn), deliver the full personalized intro and
        // hand the rest of the call to the model. Only fires when the short
        // greeting was actually sent (skips inbound callbacks, which never get the
        // proactive opener and let the model open instead).
        if (
          type === 'response_required' &&
          greetingSent &&
          !fullIntroSent &&
          !callbackPrefix
        ) {
          fullIntroSent = true;
          safeSend(ws, {
            response_id: event.response_id ?? 0,
            content: buildFirstGreeting(callObject),
            content_complete: true,
            end_call: false,
            response_type: 'response',
          });
          console.log(
            `[retell-dialer] full intro sent on first reply (call_id=${callId || 'unknown'})`
          );
          return;
        }

        // Voice streaming: when enabled, forward each LLM delta to Retell as an
        // incremental (content_complete:false) frame so TTS starts on the first
        // sentence. buildRetellLlmResponse returns the closing/transfer frame.
        // opts.noInterrupt (RD.26-streaming): once the accumulating reply reads as a
        // transfer, every remaining delta is stamped no_interruption_allowed so a
        // caller barge-in can't cut the spoken transfer line and void the hand-off.
        const streamSink = RETELL_VOICE_STREAMING
          ? (delta, opts) => {
              const frame = {
                response_id: event.response_id ?? 0,
                content: delta,
                content_complete: false,
                response_type: 'response',
              };
              if (opts && opts.noInterrupt) frame.no_interruption_allowed = true;
              safeSend(ws, frame);
            }
          : null;
        const response = await buildRetellLlmResponse(event, callObject, callbackPrefix, greetingSent, streamSink);
        // RD.25: close the build-window race. The arrival-time guard above can't
        // catch a turn whose LLM build was already in flight when a concurrent
        // turn signaled the transfer — this frame would land AFTER the
        // transfer-carrying frame with a newer response_id and wipe the pending
        // handoff. Drop any post-transfer frame that does not itself carry the
        // transfer (the initiating frame passes; everything later is suppressed).
        // TCPA exemption: an end_call frame is a DNC opt-out acknowledgment and
        // must ALWAYS go through — honoring the opt-out outranks the transfer.
        if (
          callId &&
          transferInitiated.has(String(callId)) &&
          !response.transfer_number &&
          !response.end_call
        ) {
          console.log(
            `[retell-dialer] post-transfer LLM frame dropped (call_id=${callId})`
          );
          return;
        }
        safeSend(ws, response);
        if (response.end_call) {
          console.log(
            `[retell-dialer] retell-llm WS ending call on DNC opt-out (call_id=${callId || 'unknown'})`
          );
        }
        return;
      }

      // Forward-compatible: log and ignore anything we don't recognize.
      console.log(`[retell-dialer] retell-llm WS: ignoring interaction_type="${type}"`);
    });

    ws.on('close', (code) => {
      // RD.21b: drop the per-call transfer guard so the Map can't leak entries.
      if (callId) transferInitiated.delete(String(callId));
      if (callId) screenerHandled.delete(String(callId));
      if (callId) vmHandled.delete(String(callId));
      if (callId) _dncMarked.delete(String(callId));
      // Drop the per-call card guard so the Set can't leak entries.
      if (callId) callInProgressCardSent.delete(String(callId));
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(
        `[retell-dialer] retell-llm WS closed (call_id=${callId || 'unknown'}, code=${code}, ${secs}s)`
      );
    });

    ws.on('error', (err) => {
      console.error('[retell-dialer] retell-llm WS error', err && err.message);
    });
  });

  return wss;
}

// Shared HTTP server: Express HTTP routes + the /retell-llm WebSocket upgrade.
const httpServer = http.createServer(app);
attachRetellLlmSocket(httpServer);

if (require.main === module) {
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[voice-dialer] listening on 127.0.0.1:${PORT} (HTTP + /retell-llm WebSocket)`);
    console.log(`[voice-dialer] leadSource=${config.leadSource} compliance=${compliance.enabled ? 'ENABLED' : 'disabled'} notifier=${config.notifier.webhookUrl ? 'set' : 'unset'}`);
  });
}

module.exports = {
  app,
  httpServer,
  attachRetellLlmSocket,
  buildRetellLlmResponse,
  buildFirstGreeting,
  buildSystemPrompt,
  mapTranscriptToMessages,
  containsDncSignal,
  lastUserUtterance,
  detectTransferIntent,
  detectWrongPerson,
  detectVoicemailGreeting,
  transcriptLooksLikeScreener,
  SCREENER_TERMINAL_RE,
  loadKnowledge,
  loadVerticalScript,
  loadInboundScript,
  isInboundCall,
  extractCallContext,
  recentTranscriptText,
  resolveAvatar,
  resolveProduct,
  buildEnrichmentSections,
  formatCallDate,
  COMPLIANCE_REMINDER,
  parseCallbackTime,
  normalizeDisposition,
  normalizeSentiment,
  toDbDisposition,
  isVoicemail,
  isNoAnswer,
  extractCallAnalysis,
  findQueueRecord,
  handleCallEnded,
  handleCallAnalyzed,
  handleRemoveLead,
  verifyRetellSignature,
  TERMINAL_DIALER_STATUSES,
};
