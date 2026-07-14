// Inbound callback detection for the /retell-llm WebSocket.
//
// When the voice provider connects for a live call, the call_details event tells
// us whether it is outbound (the dialer placed it, carries metadata.queue_id) or
// inbound (the lead called us back). An inbound call whose caller matches a row we
// previously queued is a HOT lead — they returned the call, so intent is proven.
// We bump that row to top priority and hand the WS handler a prompt prefix that
// switches the agent from cold-open BANT to a warm, short-qualify-then-transfer flow.

const { config, agentDisplayName } = require("./config");

// Lazy leadSource resolution so the module stays import-safe (e.g. unit-testing the
// pure helpers) without SUPABASE_* env — the default adapter builds its client
// eagerly. The live process always has env when detectCallback actually runs.
let _leadSource = null;
function leadSource() {
  if (!_leadSource) _leadSource = require("./adapters/leadSource").getLeadSource();
  return _leadSource;
}

// Pick the best queue row for an inbound caller who may match several rows (people
// submit multiple inquiries on the same number). Voice-only + CRM-neutral: no
// segment arbitration — the FRESHEST row wins. `rows` MUST be ordered freshest-
// first (lead_created_at desc) by the caller. Pure (no I/O) so it is unit-tested.
function chooseInboundLead(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (list.length === 0) return null;
  return { ...list[0] };
}

/**
 * Detect if an inbound call is a callback from a lead we previously dialed.
 * Returns { isCallback: boolean, context: object|null }
 */
async function detectCallback(callDetails) {
  const callType = callDetails?.call_type || callDetails?.direction || "outbound";
  const callerPhone = callDetails?.from_number || null;
  const hasQueueId = !!callDetails?.metadata?.queue_id;

  // If outbound with a queue_id, this is a normal outbound call — not a callback
  if (callType === "outbound" && hasQueueId) {
    return { isCallback: false, context: null };
  }

  // If inbound, or outbound without queue_id but has a caller phone — check if callback
  if ((callType === "inbound" || !hasQueueId) && callerPhone) {
    try {
      // Normalized (last-10-digit) match so +1XXXXXXXXXX / 1XXXXXXXXXX / any
      // formatting variant resolves (exact .eq missed real callers). Order by
      // lead_created_at (consumer intent) — NOT updated_at, which our OWN dialing
      // bumps and would mis-select which of several rows wins.
      const digits = String(callerPhone).replace(/\D+/g, "");
      const last10 = digits.slice(-10);
      if (last10.length < 10) {
        return { isCallback: true, context: null };
      }
      const { data: rows, error } = await leadSource().client
        .from("retell_call_queue")
        .select("id, contact_name, segment, product_interest, assigned_agent, phone_e164, lead_context, lead_created_at")
        .ilike("phone_e164", `%${last10}`)
        .order("lead_created_at", { ascending: false })
        .limit(10);

      const chosen = error ? null : chooseInboundLead(rows);
      if (error || !chosen) {
        if (error) console.error("[callback-detector] lookup error:", error.message);
        else console.log("[callback-detector] inbound from unknown caller (last4):", last10.slice(-4));
        return {
          isCallback: true,
          context: null // Unknown caller
        };
      }

      // They called back → hot lead. Bump the CHOSEN row to top priority.
      await leadSource().updateQueueRow(chosen.id, {
        priority_score: 100,
        dialer_status: "In_Progress",
        updated_at: new Date().toISOString()
      });

      console.log(
        `[callback-detector] INBOUND CALLBACK matched queue_id=${chosen.id} segment=${chosen.segment}`
      );

      return {
        isCallback: true,
        context: {
          contact_name: chosen.contact_name,
          // The live prompt reads ctx.vertical as its segment dynamic-variable;
          // source it from the CRM-neutral `segment` column.
          vertical: chosen.segment,
          product_interest: chosen.product_interest,
          assigned_agent: chosen.assigned_agent,
          queue_id: chosen.id
        }
      };
    } catch (err) {
      console.error("[callback-detector] Lookup error:", err.message);
      return { isCallback: false, context: null };
    }
  }

  return { isCallback: false, context: null };
}

/**
 * Build the callback-aware prompt prefix to prepend to the system prompt.
 */
function buildCallbackPromptPrefix(callbackResult) {
  if (!callbackResult.isCallback) return "";

  const agent = agentDisplayName();
  const company = config.company.name || "our office";

  if (callbackResult.context) {
    const ctx = callbackResult.context;
    const topic = ctx.vertical || ctx.product_interest || "your inquiry";
    return `IMPORTANT: This is an INBOUND CALLBACK. The caller is ${ctx.contact_name}. They are calling back after you tried to reach them about ${topic}. Greet them warmly: "Hi ${ctx.contact_name}! Thanks so much for calling back — I tried to reach you earlier. Do you have a couple minutes?" They called back so intent is proven. Do light qualification only (Need + Timeline), then offer transfer to ${ctx.assigned_agent || "a licensed advisor"} immediately. Skip Budget and Authority questions.\n\n`;
  }

  return `IMPORTANT: This is an INBOUND CALL from an unknown caller. Greet them warmly: "Thanks for calling ${company}, this is ${agent}. How can I help you today?" Determine what they need and if appropriate, offer to connect them with a licensed advisor.\n\n`;
}

module.exports = { detectCallback, buildCallbackPromptPrefix, chooseInboundLead };
