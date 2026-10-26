import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Harness must use an HTTP loopback address.');
  }
  return url;
}

export function redact(value) {
  return String(value).replace(/([?&]token=)[^\s&"']+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Harness returned an empty response.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) throw new Error('Harness response exceeds the 16 MiB limit; request fewer messages.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class Harness {
  constructor(options = {}) {
    this.base = localUrl(options.base ?? process.env.DSH_CONTROL_URL ?? 'http://127.0.0.1:3081').origin;
    this.home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const port = new URL(this.base).port || '80';
    this.readyFile = options.readyFile ?? process.env.DSH_CONTROL_READY_FILE ?? join(this.home, 'launcher', `dsh-web-${port}.ready`);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.cookie = '';
    this.authPromise = null;
  }

  async authenticate(signal) {
    // One exchange for concurrent calls. The short timeout also bounds callers waiting on it.
    if (this.authPromise) return this.authPromise;
    const job = (async () => {
      let text;
      try { text = (await readFile(this.readyFile, 'utf8')).trim(); }
      catch { throw new Error('Cannot read the Harness launcher ready file. Start Harness with your usual launcher, or set DSH_CONTROL_READY_FILE.'); }
      const launch = localUrl(text);
      if (launch.origin !== this.base || launch.pathname !== '/' || !launch.searchParams.get('token')) {
        throw new Error('Launcher ready file does not match the configured Harness address.');
      }
      const response = await this.fetch(launch, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
      if (![200, 302, 303, 307, 308].includes(response.status) || !cookie) {
        throw new Error('Harness launch authentication failed. Restart Harness using your usual launcher to refresh its ready file.');
      }
      // Kept only in this process; never written into MCP configuration or stdout.
      this.cookie = cookie;
    })();
    this.authPromise = job;
    try { await job; } finally { if (this.authPromise === job) this.authPromise = null; }
  }

  async rpc(method, request, signal = new AbortController().signal) {
    signal.throwIfAborted();
    if (!this.cookie) await this.authenticate(signal);
    const rpcId = randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method,
      payload: { args: { [method === 'session/list' ? '_request' : 'request']: request } } });
    const send = () => this.fetch(`${this.base}/api/${method}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: this.cookie }, body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    let response;
    try {
      response = await send();
      // Retry only an explicit authentication rejection. Network failures or other
      // responses never replay mutations whose acceptance might be ambiguous.
      if (response.status === 401) {
        await response.body?.cancel();
        this.cookie = '';
        await this.authenticate(signal);
        response = await send();
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('Harness connection failed or timed out. Check that it is running. A write may have been accepted: inspect the session before resending.', { cause: error });
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Harness HTTP ${response.status} for ${method}.`); }
    const envelope = await boundedJson(response);
    if (envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') throw new Error('Unrecognized Harness RPC response; the Web API may have changed.');
    if (!envelope.result.ok) throw new Error(`Harness ${envelope.result.error?.code ?? 'error'}: ${redact(envelope.result.error?.message ?? 'request failed')}`);
    return envelope.result.value;
  }

  async list(signal) {
    const result = await this.rpc('session/list', {}, signal);
    if (!Array.isArray(result.items)) throw new Error('Unrecognized Harness session list.');
    return result.items;
  }

  async summary(sessionId, signal) {
    const item = (await this.list(signal)).find(item => item.sessionId === sessionId);
    if (!item) throw new Error('Session is absent from the active Harness list. Check its ID and whether it is archived.');
    if (item.origin === 'subagent') throw new Error('Subagent sessions must be controlled through their parent; this bridge supports ordinary sessions.');
    return item;
  }

  async read(sessionId, options = {}, signal) {
    const item = await this.summary(sessionId, signal);
    const throughSeq = item.projections?.asOfSeq;
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new Error('Harness did not provide a readable session cursor.');
    const result = await this.rpc('session/page', {
      address: { kind: 'session', sessionId }, throughSeq,
      maxMessages: options.limit ?? 20,
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
    }, signal);
    return projectPage(item, result, options);
  }

  async run(args, signal) {
    // A caller-owned UUID makes an uncertain create distinguishable from a
    // duplicate. It is returned even when rename or the first prompt fails.
    const sessionId = randomUUID();
    try {
      await this.rpc('session/create', { sessionId, ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.agentPreset ? { agentPreset: args.agentPreset } : {}) }, signal);
    } catch (error) {
      throw new Error(`Create request for session ${sessionId}: ${redact(error.message)} Inspect this ID before retrying.`);
    }
    try {
      if (args.title) await this.rpc('session/rename', { sessionId, title: args.title }, signal);
      return await this.send(sessionId, args.prompt, 'queue', signal);
    } catch (error) {
      throw new Error(`Session ${sessionId} was created, but the next operation failed: ${redact(error.message)} Inspect this session before retrying.`);
    }
  }

  async send(sessionId, prompt, mode, signal) {
    const requestId = randomUUID();
    try {
      const result = await this.rpc('session/prompt', { sessionId, requestId, mode,
        content: [{ type: 'text', text: prompt }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, signal);
      return { sessionId, requestId, ...result, status: 'submitted', note: 'Submitted is not completed. Use dsh_wait_session or dsh_read_session.' };
    } catch (error) {
      throw new Error(`Prompt request ${requestId} for session ${sessionId}: ${redact(error.message)}`);
    }
  }

  async wait(args, signal) {
    const deadline = Date.now() + (args.timeoutMs ?? 30000);
    while (true) {
      signal?.throwIfAborted();
      const result = await this.read(args.sessionId, { limit: 20, maxChars: 4000 }, signal);
      // Inbox matters: running=false may be observed between submission and
      // turn admission. Do not treat a queued prompt as a completed task.
      const pendingQueue = result.queue.nextTurn + result.queue.nextStep;
      if (!result.running && pendingQueue === 0) return { ...result, waitStatus: result.lastTurn ? 'settled' : 'idle' };
      if (Date.now() >= deadline) return { ...result, waitStatus: 'timedOut', note: 'The Harness turn is still active or queued; timing out did not cancel it.' };
      await delay(Math.min(1000, deadline - Date.now()), undefined, { signal });
    }
  }
}

export function compactSummary(item) {
  const p = item.projections?.values ?? {};
  return { sessionId: item.sessionId, title: p.title ?? '', cwd: item.cwd, running: item.running,
    blank: item.blank, updatedAt: item.updatedAt, agentPreset: p.agentPreset,
    permissionPreset: p.permissions?.currentValue, model: p.modelSelection?.next ?? p.modelSelection?.lastUsed,
    cursor: item.projections?.asOfSeq };
}

export function projectPage(item, page, options = {}) {
  if (!Array.isArray(page.records)) throw new Error('Unrecognized Harness transcript response.');
  const maxChars = options.maxChars ?? 4000;
  const messages = []; const events = []; let lastTurn;
  for (const record of page.records) {
    const event = record.event;
    if (!event) continue;
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      if (event.type === 'user/message' && event.data?.source?.kind !== 'user') continue;
      const message = event.type === 'user/message' ? event.data : event.data?.message;
      // Explicit text blocks only: no reasoning, internal prompts or tool output.
      const text = Array.isArray(message?.content) ? message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : '';
      if (text) messages.push({ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant',
        text: text.slice(0, maxChars), truncated: text.length > maxChars });
    }
    if (event.type === 'turn/end') lastTurn = { seq: event.seq, reason: event.data?.reason ?? event.data?.endReason };
    // Approval event details can include shell arguments. Return type/seq only;
    // the user resolves approval and question cards in the Harness UI.
    if (/^(approval\/|user-questions\/|question\/)/.test(event.type)) events.push({ seq: event.seq, type: event.type });
  }
  const seqs = page.records.map(r => r.event?.seq).filter(Number.isSafeInteger);
  return { ...compactSummary(item), messages, lastTurn,
    queue: { nextTurn: item.projections?.values?.inbox?.['next-turn']?.length ?? 0,
      nextStep: item.projections?.values?.inbox?.['next-step']?.length ?? 0 },
    decisionEvents: events, hasMore: page.hasMore === true,
    ...(page.hasMore && seqs.length ? { nextBeforeSeq: Math.min(...seqs) } : {}),
    note: 'Messages contain user and assistant text only. Decision events are historical; inspect active approval/question cards in the Harness UI.' };
}
