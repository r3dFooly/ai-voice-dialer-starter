'use strict';
// Generic outbound notifier. Sends transfer / hot-lead alerts as a single
// configurable webhook POST (NOTIFY_WEBHOOK_URL). Fire-and-forget, never throws,
// never blocks the call path. Point it at a Slack/Discord/Teams incoming webhook
// or your own endpoint — the payload is neutral JSON.
const { config } = require('../../config');

const _sentOnce = new Set();

function notify(event, payload = {}) {
  const url = config.notifier.webhookUrl;
  if (!url) return; // notifier disabled when unset
  const body = JSON.stringify({ event, ...payload });
  (async () => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      console.log(`[notifier] ${event} -> ${r.status}`);
    } catch (e) {
      console.error(`[notifier] ${event} failed:`, e && e.message);
    }
  })();
}

// Warm-transfer / hot-lead alert. One-shot per call so a retried transfer-intent
// turn does not spam the endpoint.
function notifyTransferIntent({ callId, leadName, phone, segment, assignedAgent, agentName, queueId } = {}) {
  if (callId) {
    if (_sentOnce.has(String(callId))) return;
    _sentOnce.add(String(callId));
  }
  notify('transfer_intent', {
    lead_name: leadName || 'Unknown',
    phone: phone || '',
    segment: segment || '',
    assigned_agent: assignedAgent || '',
    agent_name: agentName || '',
    queue_id: queueId || '',
    call_id: callId || '',
  });
}

module.exports = { notify, notifyTransferIntent };
