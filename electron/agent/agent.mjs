import fs from 'node:fs';
import crypto from 'node:crypto';
import { streamChat, complete, listModels, genId, FALLBACK_MODELS } from './providers.mjs';
import { getToolDefs, executeTool, requiresApproval, revertRun, hasCheckpoint, getCheckpointBefore, TOOL_DEFS } from './tools.mjs';
import { buildSystemPrompt, expandUserMessage } from './prompts.mjs';
import { getSettings, setSettings, getApiKey, normalizeKey, checkKeyFormat } from '../settings.mjs';

const runs = new Map(); // runId -> { controller, sender, approvals }

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function readFileSafe(p) {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > 2 * 1024 * 1024) return null;
    for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Removes UI-only messages and makes sure every tool call has a matching tool result
 * (providers reject histories with dangling tool calls, e.g. after the user pressed Stop).
 */
export function sanitizeHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') out.push(m);
    else if (m.role === 'assistant') {
      if (!m.content && !m.toolCalls?.length) continue;
      out.push(m);
      if (m.toolCalls?.length) {
        const results = new Map();
        let j = i + 1;
        while (j < messages.length && messages[j].role !== 'user' && messages[j].role !== 'assistant') {
          if (messages[j].role === 'tool') results.set(messages[j].toolCallId, messages[j]);
          j++;
        }
        for (const tc of m.toolCalls) {
          out.push(
            results.get(tc.id) || {
              role: 'tool',
              toolCallId: tc.id,
              name: tc.name,
              content: 'Error: this tool call was cancelled by the user before it ran.',
              isError: true,
            },
          );
        }
        i = j - 1;
      }
    }
    // 'tool' messages are emitted together with their assistant message above; others are UI-only.
  }
  return out;
}

function waitForApproval(run, toolCallId) {
  return new Promise((resolve, reject) => {
    if (run.controller.signal.aborted) return reject(abortError());
    run.approvals.set(toolCallId, resolve);
    run.controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

async function runToolCall(run, call, { mode, emit, root, runId }) {
  const started = Date.now();
  const base = { id: genId('tool'), role: 'tool', toolCallId: call.id, name: call.name, args: call.args, createdAt: started };
  if (call.parseError) {
    return { ...base, isError: true, content: `Error: ${call.parseError}. Retry the call with valid JSON arguments.`, ui: { kind: 'error', message: call.parseError } };
  }
  const def = TOOL_DEFS.find((t) => t.name === call.name);
  if (mode === 'ask' && def && !def.readOnly) {
    return {
      ...base,
      isError: true,
      content: 'Error: this tool is not available in Ask mode. Describe the change instead, or ask the user to switch to Agent mode.',
      ui: { kind: 'error', message: 'Not available in Ask mode' },
    };
  }
  const settings = getSettings();
  if (def && requiresApproval(call.name, settings)) {
    emit('approval_request', { toolCallId: call.id });
    const decision = await waitForApproval(run, call.id);
    if (decision === 'reject') {
      return {
        ...base,
        isError: true,
        rejected: true,
        content: 'The user chose not to run this. Do not retry it; continue without it or ask the user how to proceed.',
        ui: { kind: 'rejected' },
      };
    }
    if (decision === 'always') {
      setSettings({ autoRun: 'auto' });
      emit('settings_changed', { settings: getSettings() });
    }
  }
  emit('tool_start', { toolCallId: call.id });
  const result = await executeTool(call.name, call.args, {
    root,
    runId,
    settings,
    signal: run.controller.signal,
    onOutput: (text) => emit('tool_output', { toolCallId: call.id, text }),
    onFileChanged: (p, content) => emit('file_changed', { path: p, content }),
  });
  return { ...base, content: result.output, isError: !!result.isError, ui: result.ui, durationMs: Date.now() - started };
}

async function runAgent(sender, payload) {
  const { runId, messages, mode = 'agent', model: sel, context, root } = payload;
  const controller = new AbortController();
  const run = { controller, sender, approvals: new Map() };
  runs.set(runId, run);
  const emit = (type, data = {}) => {
    if (!sender.isDestroyed()) sender.send('agent:event', { runId, type, ...data });
  };

  try {
    const settings = getSettings();
    const provider = sel?.provider || settings.chatModel.provider;
    const model = sel?.model || settings.chatModel.model;
    const apiKey = getApiKey(provider);
    if (!apiKey) {
      emit('error', {
        message: `No ${provider === 'google' ? 'Google' : 'Groq'} API key configured. Open Settings (Ctrl+,) → Models and paste your key.`,
        code: 'no_key',
      });
      return;
    }

    const history = messages.map((m) => ({ ...m }));
    const last = history[history.length - 1];
    if (last?.role === 'user' && last.llmContent == null) {
      last.llmContent = expandUserMessage(last.content, last.context, root, readFileSafe);
      emit('user_expanded', { messageId: last.id, llmContent: last.llmContent });
    }

    const tools = getToolDefs(mode);
    const system = buildSystemPrompt({ root, mode, settings, context });
    const maxSteps = Math.max(1, Number(settings.maxSteps) || 50);
    let retries = 0;
    let step = 0;

    while (step < maxSteps) {
      step++;
      const messageId = genId('msg');
      emit('assistant_start', { messageId, provider, model });
      let content = '';
      let thinking = '';
      const toolCalls = [];
      let meta = null;
      let usage = null;
      let finishReason = null;
      const t0 = Date.now();
      let thinkingEnd = null;
      try {
        const stream = streamChat({
          provider,
          model,
          apiKey,
          system,
          messages: sanitizeHistory(history),
          tools,
          signal: controller.signal,
          onRetry: (r) => emit('status', { messageId, text: `Retrying (attempt ${r.attempt})… ${r.reason}` }),
        });
        for await (const ev of stream) {
          if (ev.type === 'text') {
            if (thinking && !thinkingEnd) thinkingEnd = Date.now();
            content += ev.text;
            emit('text', { messageId, text: ev.text });
          } else if (ev.type === 'thinking') {
            thinking += ev.text;
            emit('thinking', { messageId, text: ev.text });
          } else if (ev.type === 'tool_call') {
            if (thinking && !thinkingEnd) thinkingEnd = Date.now();
            toolCalls.push(ev.call);
            emit('tool_call', { messageId, call: ev.call });
          } else if (ev.type === 'end') {
            meta = ev.meta;
            usage = ev.usage;
            finishReason = ev.finishReason;
          }
        }
      } catch (e) {
        if (e?.name === 'AbortError' || controller.signal.aborted) {
          if (content || thinking) {
            const partial = { id: messageId, role: 'assistant', content, thinking: thinking || undefined, provider, model, aborted: true, createdAt: Date.now() };
            history.push(partial);
            emit('assistant_end', { message: partial });
          } else emit('assistant_discard', { messageId });
          throw abortError();
        }
        if ((e?.code === 'tool_use_failed' || e?.status === 500) && retries < 2) {
          retries++;
          emit('assistant_discard', { messageId });
          continue;
        }
        emit('assistant_discard', { messageId });
        throw e;
      }

      if (/MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL/.test(finishReason || '') && !toolCalls.length && retries < 2) {
        retries++;
        emit('assistant_discard', { messageId });
        continue;
      }

      const assistant = {
        id: messageId,
        role: 'assistant',
        content,
        thinking: thinking || undefined,
        thinkingMs: thinking ? (thinkingEnd || Date.now()) - t0 : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        meta,
        provider,
        model,
        usage,
        finishReason,
        createdAt: Date.now(),
      };
      history.push(assistant);
      emit('assistant_end', { message: assistant });

      if (!toolCalls.length) {
        if (finishReason === 'MAX_TOKENS' || finishReason === 'length') {
          emit('notice', { text: 'The response was cut off because it reached the model’s output limit. Say "continue" to resume.' });
        } else if (!content.trim() && finishReason && !/^stop$/i.test(finishReason)) {
          emit('notice', { text: `The model stopped without a reply (reason: ${finishReason}).` });
        }
        break;
      }

      for (const call of toolCalls) {
        if (controller.signal.aborted) throw abortError();
        const toolMsg = await runToolCall(run, call, { mode, emit, root, runId });
        history.push(toolMsg);
        emit('tool_result', { message: toolMsg });
      }
      if (step >= maxSteps) {
        emit('notice', { text: `Paused after ${maxSteps} steps (you can raise the limit in Settings). Send "continue" to keep going.` });
      }
    }
    emit('done', { hasCheckpoint: hasCheckpoint(runId) });
  } catch (e) {
    if (e?.name === 'AbortError' || controller.signal.aborted) emit('done', { stopped: true, hasCheckpoint: hasCheckpoint(runId) });
    else {
      console.error('agent error', e);
      emit('error', { message: e?.message || String(e), hasCheckpoint: hasCheckpoint(runId) });
    }
  } finally {
    runs.delete(runId);
  }
}

// ---------------------------------------------------------------------------------------
// Inline edit (Ctrl+K) and Tab autocomplete
// ---------------------------------------------------------------------------------------

function stripFences(text) {
  let t = text.replace(/^\s*\n/, '');
  const m = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (m) t = m[1];
  return t;
}

async function inlineEdit({ instruction, code, language, path: filePath, before, after, model }) {
  const settings = getSettings();
  const sel = model || settings.inlineModel || settings.chatModel;
  const apiKey = getApiKey(sel.provider);
  if (!apiKey) throw new Error(`No ${sel.provider === 'google' ? 'Google' : 'Groq'} API key configured (Settings → Models).`);
  const system =
    'You are an expert programmer performing an inline edit inside a code editor. Rewrite the code in <selection> according to the instruction. ' +
    'Output ONLY the code that should replace the selection: no explanations, no markdown fences, no surrounding code. ' +
    'Preserve the indentation of the original code. If the selection is empty, output only the code to insert at the cursor.';
  const prompt = `File: ${filePath || 'untitled'} (${language || 'plaintext'})

<code_before_selection>
${(before || '').slice(-6000)}
</code_before_selection>
<selection>
${code || ''}
</selection>
<code_after_selection>
${(after || '').slice(0, 3000)}
</code_after_selection>

Instruction: ${instruction}

Return only the replacement for <selection>.`;
  const text = await complete({ provider: sel.provider, model: sel.model, apiKey, system, prompt, maxTokens: 8192, fast: true });
  return stripFences(text);
}

const autocompleteControllers = new Map();

async function autocomplete(senderId, { prefix, suffix, language, path: filePath }) {
  autocompleteControllers.get(senderId)?.abort();
  const ac = new AbortController();
  autocompleteControllers.set(senderId, ac);
  const settings = getSettings();
  if (!settings.autocompleteEnabled) return '';
  let sel = settings.autocompleteModel;
  let apiKey = getApiKey(sel.provider);
  if (!apiKey) {
    // Fall back to whichever provider has a key.
    const other = sel.provider === 'groq' ? 'google' : 'groq';
    const otherKey = getApiKey(other);
    if (!otherKey) return '';
    sel = other === 'google' ? { provider: 'google', model: 'gemini-2.5-flash-lite' } : { provider: 'groq', model: 'openai/gpt-oss-20b' };
    apiKey = otherKey;
  }
  const system =
    'You are a code completion engine inside an editor. The user\'s code is given with a <CURSOR> marker. ' +
    'Reply with ONLY the exact text to insert at <CURSOR> — no explanations, no markdown fences, and never repeat code that already exists before or after the cursor. ' +
    'Prefer completing the current line or the current small block (at most 8 lines). If nothing sensible can be inserted, reply with an empty string.';
  const pre = (prefix || '').slice(-5000);
  const suf = (suffix || '').slice(0, 1500);
  const prompt = `File: ${filePath || 'untitled'} (${language || 'plaintext'})\n\n${pre}<CURSOR>${suf}`;
  try {
    let text = await complete({
      provider: sel.provider,
      model: sel.model,
      apiKey,
      system,
      prompt,
      maxTokens: 1024,
      temperature: 0.2,
      signal: ac.signal,
      fast: true,
    });
    text = stripFences(text).replace(/<CURSOR>/g, '');
    // Remove accidental repetition of the current line's prefix.
    const lineStart = pre.slice(pre.lastIndexOf('\n') + 1);
    if (lineStart.trim() && text.startsWith(lineStart)) text = text.slice(lineStart.length);
    // Remove overlap with the code right after the cursor.
    const sufLine = suf.split('\n')[0];
    if (sufLine && text.endsWith(sufLine)) text = text.slice(0, -sufLine.length);
    return text.replace(/\s+$/, (m) => (m.includes('\n') ? '' : m));
  } catch (e) {
    if (e?.name === 'AbortError') return '';
    throw e;
  } finally {
    if (autocompleteControllers.get(senderId) === ac) autocompleteControllers.delete(senderId);
  }
}

// ---------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------

const modelCache = new Map();

async function getModels(provider, { refresh } = {}) {
  const key = getApiKey(provider);
  if (!key) return { models: FALLBACK_MODELS[provider], error: null, live: false };
  const cacheKey = provider + ':' + crypto.createHash('sha1').update(key).digest('hex');
  const cached = modelCache.get(cacheKey);
  if (cached && !refresh && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  try {
    const models = await listModels(provider, key);
    const value = { models: models.length ? models : FALLBACK_MODELS[provider], error: null, live: true };
    modelCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (e) {
    return { models: FALLBACK_MODELS[provider], error: e.message, live: false };
  }
}

// ---------------------------------------------------------------------------------------

export function registerAgentIpc(ipcMain) {
  ipcMain.handle('agent:start', (e, payload) => {
    runAgent(e.sender, payload);
    return { ok: true };
  });
  ipcMain.handle('agent:stop', (_e, runId) => {
    runs.get(runId)?.controller.abort();
  });
  ipcMain.handle('agent:approve', (_e, runId, toolCallId, decision) => {
    const run = runs.get(runId);
    const resolve = run?.approvals.get(toolCallId);
    if (resolve) {
      run.approvals.delete(toolCallId);
      resolve(decision);
    }
  });
  ipcMain.handle('agent:revert', (_e, runId, onlyPath) => revertRun(runId, onlyPath));
  ipcMain.handle('agent:checkpoint', (_e, runId, p) => getCheckpointBefore(runId, p));
  ipcMain.handle('ai:models', (_e, provider, opts) => getModels(provider, opts));
  ipcMain.handle('ai:testKey', async (_e, provider, rawKey) => {
    const key = rawKey ? normalizeKey(rawKey) : getApiKey(provider);
    if (!key) return { ok: false, error: 'No key entered.' };
    const warning = checkKeyFormat(provider, key);
    try {
      const models = await listModels(provider, key);
      return { ok: true, count: models.length, warning };
    } catch (err) {
      return { ok: false, error: err.message, warning };
    }
  });
  ipcMain.handle('ai:inlineEdit', (_e, req) => inlineEdit(req));
  ipcMain.handle('ai:autocomplete', (e, req) => autocomplete(e.sender.id, req));
  ipcMain.handle('ai:hasKeys', () => ({ google: !!getApiKey('google'), groq: !!getApiKey('groq') }));
}

export function disposeAgentRuns() {
  for (const r of runs.values()) r.controller.abort();
  runs.clear();
}
