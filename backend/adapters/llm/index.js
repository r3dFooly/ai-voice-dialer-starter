'use strict';
// LLM adapter — OpenAI-compatible /v1/chat/completions client. Works with
// OpenAI, a LiteLLM proxy, or any OpenAI-compatible gateway (point LLM_BASE_URL
// at it). For Anthropic, front it with such a gateway.
//
// Two entry points, both with the same graceful-failure contract used by the
// voice turn loop (never throw; return {ok:false, reason} so the caller can fall
// back to a safe canned line rather than sit in dead air):
//   callLLM(messages)            -> { ok, content } | { ok:false, reason }
//   callLLMStream(messages, onD) -> streams deltas to onDelta, returns { ok, content }
const { config } = require('../../config');

async function callLLM(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const resp = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        max_tokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`[llm] responded ${resp.status}`, String(detail).slice(0, 300));
      return { ok: false, reason: resp.status >= 500 ? 'upstream_5xx' : 'upstream_error' };
    }
    const json = await resp.json();
    const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'no_content' };
    return { ok: true, content: content.trim() };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    console.error('[llm] fetch failed', err && err.message);
    return { ok: false, reason: 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Streaming variant for the latency-sensitive voice path. Emits each SSE delta to
// onDelta(text) as it arrives and resolves with the full accumulated content.
// Uses an IDLE watchdog (reset on every chunk) rather than a fixed timer, so a
// stream that connects and then stalls mid-read is aborted well under the voice
// provider's websocket idle limit — never leaving the caller in dead air.
// onDelta must never throw (the caller should wrap it defensively).
async function callLLMStream(messages, onDelta) {
  const controller = new AbortController();
  let watchdog = null;
  const arm = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), config.llm.timeoutMs); };
  arm();
  let full = '';
  try {
    const resp = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        max_tokens: config.llm.maxTokens,
        temperature: config.llm.temperature,
        stream: true,
      }),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const detail = resp.ok ? 'no response body' : await resp.text().catch(() => '');
      console.error(`[llm stream] responded ${resp.status}`, String(detail).slice(0, 300));
      return { ok: false, reason: resp.status >= 500 ? 'upstream_5xx' : 'upstream_error', content: full };
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of resp.body) {
      arm(); // bytes arrived — reset idle watchdog
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (typeof delta === 'string' && delta) {
            full += delta;
            try { onDelta(delta); } catch (_) { /* onDelta must not break the stream */ }
          }
        } catch (_) { /* ignore keepalive / partial frames */ }
      }
    }
    if (!full.trim()) return { ok: false, reason: 'no_content', content: '' };
    return { ok: true, content: full.trim() };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, reason: 'timeout', content: full };
    console.error('[llm stream] fetch failed', err && err.message);
    return { ok: false, reason: 'fetch_failed', content: full };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

module.exports = { callLLM, callLLMStream };
