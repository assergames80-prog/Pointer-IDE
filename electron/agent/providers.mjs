// LLM provider adapters: Google Gemini (native REST API) and Groq (OpenAI-compatible API).
//
// Google API keys: Google AI Studio now issues "Auth keys" that start with `AQ.` instead of
// the legacy `AIza...` "Standard keys". Auth keys only work when sent in the
// `x-goog-api-key` HTTP header; sending them as a `?key=` query parameter returns 404.
// Every Gemini request below therefore uses the header and never puts the key in the URL.

import crypto from 'node:crypto';

const GEMINI_BASE = (process.env.POINTER_GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const GROQ_BASE = (process.env.POINTER_GROQ_BASE || 'https://api.groq.com').replace(/\/$/, '');

export const PROVIDERS = {
  google: { id: 'google', name: 'Google Gemini' },
  groq: { id: 'groq', name: 'Groq' },
};

export const FALLBACK_MODELS = {
  google: [
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  ],
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
  ],
};

export class ProviderError extends Error {
  constructor(message, { status, provider, code, retryable, retryAfter, raw } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.code = code;
    this.retryable = !!retryable;
    this.retryAfter = retryAfter;
    this.raw = raw;
  }
}

export function genId(prefix = 'call') {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function parseRetryDelay(err) {
  // Google: error.details[].retryDelay = "23s"
  for (const d of err?.details || []) {
    if (d.retryDelay) {
      const s = parseFloat(String(d.retryDelay));
      if (!Number.isNaN(s)) return s * 1000;
    }
  }
  return undefined;
}

async function toProviderError(res, provider) {
  let text = '';
  try {
    text = await res.text();
  } catch {}
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const err = Array.isArray(body) ? body[0]?.error : body?.error;
  let message = err?.message || text || `HTTP ${res.status}`;
  const status = res.status;
  const code = err?.code && typeof err.code === 'string' ? err.code : err?.status;
  let retryAfter = parseRetryDelay(err);
  const ra = res.headers.get('retry-after');
  if (!retryAfter && ra && !Number.isNaN(parseFloat(ra))) retryAfter = parseFloat(ra) * 1000;

  if (provider === 'google') {
    if (/API key not valid|API_KEY_INVALID/i.test(message) || (status === 400 && /api key/i.test(message))) {
      message = `Google rejected the API key. Check it in Settings → Models. (New AI Studio keys start with "AQ." — paste the whole key including the dot.) Details: ${message}`;
    } else if (status === 401 || status === 403) {
      message = `Google denied access (${status}). Make sure the key is allowed to use the Gemini API (Generative Language API). Details: ${message}`;
    } else if (status === 404) {
      message = `Gemini returned 404: ${message}. The model name may be unavailable for your key — pick another model.`;
    }
  } else if (provider === 'groq') {
    if (status === 401) message = `Groq rejected the API key. Check it in Settings → Models. Details: ${message}`;
    else if (status === 404 || code === 'model_not_found' || code === 'model_decommissioned') {
      message = `Groq: ${message} — pick another model in the model menu.`;
    }
  }
  if (status === 429) message = `Rate limited by ${PROVIDERS[provider].name}: ${err?.message || message}`;
  return new ProviderError(message, {
    status,
    provider,
    code,
    retryable: status === 429 || status === 500 || status === 502 || status === 503 || status === 504,
    retryAfter,
    raw: err,
  });
}

/** fetch with retries for rate limits / overloaded servers. */
async function request(provider, url, init, { signal, onRetry, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw abortError();
      if (attempt < retries) {
        attempt++;
        onRetry?.({ attempt, reason: `Network error: ${err.message}`, delay: 1000 * attempt });
        await sleep(1000 * attempt, signal);
        continue;
      }
      throw new ProviderError(`Could not reach ${PROVIDERS[provider].name}: ${err.message}`, { provider, retryable: true });
    }
    if (res.ok) return res;
    const perr = await toProviderError(res, provider);
    if (perr.retryable && attempt < retries) {
      attempt++;
      const delay = Math.min(perr.retryAfter ?? 1500 * 2 ** (attempt - 1), 30000);
      onRetry?.({ attempt, reason: perr.message, delay });
      await sleep(delay, signal);
      continue;
    }
    throw perr;
  }
}

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const drain = function* (final) {
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buf);
      if (!m) break;
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
    if (final && buf.trim()) {
      const data = buf
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      buf = '';
      if (data) yield data;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    buf += decoder.decode();
    yield* drain(true);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ---------------------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------------------

function cleanModelId(model) {
  return String(model || '').replace(/^models\//, '');
}

function geminiMajor(model) {
  const m = /gemini-(\d+)/.exec(model);
  return m ? Number(m[1]) : 0;
}

function geminiThinks(model) {
  return /gemini-(2\.5|[3-9])/.test(model) || /gemini-(flash|pro)(-lite)?-latest/.test(model);
}

/** Converts the provider-neutral history into Gemini `contents`. */
function toGeminiContents(messages, model) {
  const contents = [];
  const idMap = new Map();
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.llmContent ?? m.content ?? '';
      push('user', [{ text: text || ' ' }]);
    } else if (m.role === 'assistant') {
      const canReuse = m.meta?.provider === 'google' && m.meta?.model === model && Array.isArray(m.meta.parts) && m.meta.parts.length;
      if (canReuse) {
        // Send the parts back exactly as received so thought signatures stay valid.
        for (const tc of m.toolCalls || []) idMap.set(tc.id, tc.providerId);
        push('model', m.meta.parts);
      } else {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        (m.toolCalls || []).forEach((tc, i) => {
          idMap.set(tc.id, tc.id);
          const p = { functionCall: { id: tc.id, name: tc.name, args: tc.args || {} } };
          // Calls not produced by this exact Gemini model have no signature; Gemini 3 requires one.
          if (i === 0 && geminiMajor(model) >= 3) p.thoughtSignature = 'skip_thought_signature_validator';
          parts.push(p);
        });
        push('model', parts);
      }
    } else if (m.role === 'tool') {
      const fr = {
        name: m.name,
        response: m.isError ? { error: m.content || 'error' } : { output: m.content ?? '' },
      };
      const id = idMap.get(m.toolCallId);
      if (id) fr.id = id;
      push('user', [{ functionResponse: fr }]);
    }
  }
  return contents;
}

/** Gemini's `parameters` uses the OpenAPI-style Schema proto, whose type enum is uppercase. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else if (k === 'additionalProperties' || k === '$schema') continue;
    else out[k] = v;
  }
  return out;
}

function geminiTools(tools) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })),
    },
  ];
}

function normUsageGemini(u) {
  if (!u) return null;
  return {
    input: u.promptTokenCount || 0,
    output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    cached: u.cachedContentTokenCount || 0,
  };
}

async function* streamGemini({ model, apiKey, system, messages, tools, signal, onRetry, maxOutputTokens }) {
  model = cleanModelId(model);
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let withThinking = geminiThinks(model);
  const makeBody = () => {
    const generationConfig = {};
    if (withThinking) generationConfig.thinkingConfig = { includeThoughts: true };
    if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
    return JSON.stringify({
      contents: toGeminiContents(messages, model),
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      tools: geminiTools(tools),
      toolConfig: tools?.length ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
      generationConfig,
    });
  };
  const init = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: makeBody(),
  });
  let res;
  try {
    res = await request('google', url, init(), { signal, onRetry });
  } catch (err) {
    if (withThinking && err.status === 400 && /thinking/i.test(err.message)) {
      withThinking = false;
      res = await request('google', url, init(), { signal, onRetry });
    } else throw err;
  }

  const parts = [];
  let usage = null;
  let finishReason = null;
  for await (const data of sseEvents(res)) {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new ProviderError(chunk.error.message || 'Gemini stream error', {
        provider: 'google',
        status: chunk.error.code,
        retryable: chunk.error.code === 503 || chunk.error.code === 500,
      });
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) {
      throw new ProviderError(`Gemini blocked the prompt (${chunk.promptFeedback.blockReason}).`, { provider: 'google' });
    }
    const cand = chunk.candidates?.[0];
    if (!cand) continue;
    if (cand.finishReason) finishReason = cand.finishReason;
    for (const p of cand.content?.parts || []) {
      if (p.functionCall) {
        parts.push(p);
        yield {
          type: 'tool_call',
          call: {
            id: p.functionCall.id || genId(),
            providerId: p.functionCall.id,
            name: p.functionCall.name,
            args: p.functionCall.args || {},
          },
        };
      } else if (typeof p.text === 'string') {
        const last = parts[parts.length - 1];
        if (
          last &&
          typeof last.text === 'string' &&
          !last.functionCall &&
          !last.thoughtSignature &&
          !p.thoughtSignature &&
          !!last.thought === !!p.thought
        ) {
          last.text += p.text;
        } else {
          parts.push({ ...p });
        }
        if (p.text) yield { type: p.thought ? 'thinking' : 'text', text: p.text };
      } else {
        parts.push(p);
      }
    }
  }
  yield { type: 'end', meta: { provider: 'google', model, parts }, usage: normUsageGemini(usage), finishReason };
}

async function completeGemini({ model, apiKey, system, prompt, maxTokens = 2048, temperature, signal, fast }) {
  model = cleanModelId(model);
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let thinkingConfig;
  if (fast && geminiThinks(model)) {
    if (geminiMajor(model) >= 3) thinkingConfig = { thinkingLevel: /flash/.test(model) ? 'minimal' : 'low' };
    else if (/flash/.test(model)) thinkingConfig = { thinkingBudget: 0 };
    else thinkingConfig = { thinkingBudget: 128 };
  }
  const send = async (tc) => {
    const generationConfig = { maxOutputTokens: maxTokens };
    if (temperature !== undefined) generationConfig.temperature = temperature;
    if (tc) generationConfig.thinkingConfig = tc;
    return request(
      'google',
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          generationConfig,
        }),
      },
      { signal, retries: 1 },
    );
  };
  let res;
  try {
    res = await send(thinkingConfig);
  } catch (err) {
    if (thinkingConfig && err.status === 400) res = await send(undefined);
    else throw err;
  }
  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
}

async function listGeminiModels(apiKey, signal) {
  const res = await request(
    'google',
    `${GEMINI_BASE}/v1beta/models?pageSize=1000`,
    { headers: { 'x-goog-api-key': apiKey } },
    { signal, retries: 1 },
  );
  const json = await res.json();
  const skip = /embedding|imagen|image|tts|audio|live|native|robotics|computer-use|aqa|veo|learnlm|gemma/i;
  const models = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({
      id: cleanModelId(m.name),
      label: m.displayName || cleanModelId(m.name),
      contextWindow: m.inputTokenLimit,
      thinking: !!m.thinking,
    }))
    .filter((m) => m.id.startsWith('gemini') && !skip.test(m.id));
  const ver = (id) => {
    const v = /gemini-(\d+(?:\.\d+)?)/.exec(id);
    return v ? parseFloat(v[1]) : 0;
  };
  const tier = (id) => (/pro/.test(id) ? 0 : /flash-lite/.test(id) ? 2 : /flash/.test(id) ? 1 : 3);
  models.sort((a, b) => ver(b.id) - ver(a.id) || tier(a.id) - tier(b.id) || a.id.localeCompare(b.id));
  return models;
}

// ---------------------------------------------------------------------------------------
// Groq (OpenAI-compatible)
// ---------------------------------------------------------------------------------------

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.llmContent ?? m.content ?? '' });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
        if (!m.content) msg.content = null;
      }
      if (!msg.content && !msg.tool_calls) continue;
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content || '(empty)' });
    }
  }
  return out;
}

function groqModelParams(model, { fast } = {}) {
  const p = {};
  if (/gpt-oss/.test(model)) {
    p.reasoning_effort = fast ? 'low' : 'medium';
    if (fast) p.include_reasoning = false;
  } else if (/qwen|deepseek-r1|reasoning/i.test(model)) {
    p.reasoning_format = fast ? 'hidden' : 'parsed';
  }
  return p;
}

/** Splits `<think>...</think>` blocks (raw reasoning) out of streamed content. */
function createThinkSplitter() {
  let inThink = false;
  let pending = '';
  const fn = (chunk) => {
    const out = [];
    pending += chunk;
    for (;;) {
      if (!inThink) {
        const i = pending.indexOf('<think>');
        if (i === -1) {
          // Hold back a possible partial "<think>" tag at the end of the chunk.
          const lt = pending.lastIndexOf('<');
          const safe = lt !== -1 && '<think>'.startsWith(pending.slice(lt)) ? lt : pending.length;
          if (safe > 0) out.push({ type: 'text', text: pending.slice(0, safe) });
          pending = pending.slice(safe);
          break;
        }
        if (i > 0) out.push({ type: 'text', text: pending.slice(0, i) });
        pending = pending.slice(i + 7);
        inThink = true;
      } else {
        const i = pending.indexOf('</think>');
        if (i === -1) {
          const lt = pending.lastIndexOf('<');
          const safe = lt !== -1 && '</think>'.startsWith(pending.slice(lt)) ? lt : pending.length;
          if (safe > 0) out.push({ type: 'thinking', text: pending.slice(0, safe) });
          pending = pending.slice(safe);
          break;
        }
        if (i > 0) out.push({ type: 'thinking', text: pending.slice(0, i) });
        pending = pending.slice(i + 8);
        inThink = false;
      }
    }
    return out;
  };
  fn.flush = () => {
    const rest = pending;
    pending = '';
    return rest ? [{ type: inThink ? 'thinking' : 'text', text: rest }] : [];
  };
  return fn;
}

async function* streamGroq({ model, apiKey, system, messages, tools, signal, onRetry, maxOutputTokens }) {
  const body = {
    model,
    messages: toOpenAIMessages(system, messages),
    stream: true,
    ...groqModelParams(model),
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (maxOutputTokens) body.max_completion_tokens = maxOutputTokens;

  const res = await request(
    'groq',
    `${GROQ_BASE}/openai/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    { signal, onRetry },
  );

  const calls = new Map();
  let content = '';
  let usage = null;
  let finishReason = null;
  const split = createThinkSplitter();
  for await (const data of sseEvents(res)) {
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new ProviderError(chunk.error.message || 'Groq stream error', {
        provider: 'groq',
        code: chunk.error.code,
        retryable: chunk.error.code === 'tool_use_failed',
        raw: chunk.error,
      });
    }
    const u = chunk.x_groq?.usage || chunk.usage;
    if (u) usage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: u.prompt_tokens_details?.cached_tokens || 0 };
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (d.reasoning) yield { type: 'thinking', text: d.reasoning };
    if (d.content) {
      for (const piece of split(d.content)) {
        if (piece.type === 'text') content += piece.text;
        yield piece;
      }
    }
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) || { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(idx, cur);
    }
  }
  for (const piece of split.flush()) {
    if (piece.type === 'text') content += piece.text;
    yield piece;
  }
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    let args = {};
    let parseError = null;
    if (c.args && c.args.trim()) {
      try {
        args = JSON.parse(c.args);
      } catch (e) {
        parseError = `Invalid JSON arguments: ${e.message}`;
      }
    }
    yield { type: 'tool_call', call: { id: c.id || genId(), name: c.name, args, parseError } };
  }
  yield { type: 'end', meta: { provider: 'groq', model }, usage, finishReason };
}

async function completeGroq({ model, apiKey, system, prompt, maxTokens = 2048, temperature, signal, fast, stop }) {
  const body = {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    max_completion_tokens: maxTokens,
    ...groqModelParams(model, { fast }),
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (stop) body.stop = stop;
  const res = await request(
    'groq',
    `${GROQ_BASE}/openai/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    { signal, retries: 1 },
  );
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
}

async function listGroqModels(apiKey, signal) {
  const res = await request(
    'groq',
    `${GROQ_BASE}/openai/v1/models`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { signal, retries: 1 },
  );
  const json = await res.json();
  const skip = /whisper|tts|orpheus|playai|guard|safeguard|compound|distil/i;
  const models = (json.data || [])
    .filter((m) => m.active !== false && !skip.test(m.id))
    .map((m) => ({ id: m.id, label: prettyGroqName(m.id), contextWindow: m.context_window }));
  const rank = (id) => (/gpt-oss-120b/.test(id) ? 0 : /gpt-oss/.test(id) ? 1 : 2);
  models.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return models;
}

function prettyGroqName(id) {
  const base = id.split('/').pop();
  if (/^gpt-oss-(\d+b)$/i.test(base)) return `GPT-OSS ${base.split('-').pop().toUpperCase()}`;
  return base;
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

export function streamChat(opts) {
  if (opts.provider === 'google') return streamGemini(opts);
  if (opts.provider === 'groq') return streamGroq(opts);
  throw new Error(`Unknown provider: ${opts.provider}`);
}

export function complete(opts) {
  if (opts.provider === 'google') return completeGemini(opts);
  if (opts.provider === 'groq') return completeGroq(opts);
  throw new Error(`Unknown provider: ${opts.provider}`);
}

export async function listModels(provider, apiKey, signal) {
  if (provider === 'google') return listGeminiModels(apiKey, signal);
  if (provider === 'groq') return listGroqModels(apiKey, signal);
  return [];
}
