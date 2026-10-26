import { Harness, compactSummary } from './harness.mjs';

const text = (description, maxLength = 16000) => ({ type: 'string', minLength: 1, maxLength, description });
const integer = (min, max, description) => ({ type: 'integer', minimum: min, maximum: max, description });
const sessionId = text('Exact ordinary Harness session ID.', 200);
const tool = (name, description, properties, required, readOnly = false) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true } });

export const TOOLS = [
  tool('dsh_status', 'Check connectivity to the local DeepSeek Harness. Does not send a model prompt.', {}, [], true),
  tool('dsh_list_sessions', 'List compact session metadata. No transcripts are returned.', {
    query: text('Filter session ID, title or cwd.', 500), limit: integer(1, 100, 'Maximum sessions; default 20.'),
    running: { type: 'boolean', description: 'Filter by running state.' },
  }, [], true),
  tool('dsh_run_prompt', 'Create a visible Harness session and submit one task. Returns immediately after acceptance; use wait/read for results. Harness tools may modify files according to its own permissions.', {
    prompt: text('Bounded task, allowed workspace and acceptance criteria.'), cwd: text('Absolute workspace directory.', 2000),
    title: text('Visible session title.', 200), agentPreset: text('Optional Harness preset; omitted keeps the user default.', 100),
  }, ['prompt']),
  tool('dsh_continue_session', 'Send one prompt to an existing session. Use queue by default; steer explicitly interrupts the current direction. Does not wait for task completion.', {
    sessionId, prompt: text('Follow-up task or steering instruction.'), mode: { type: 'string', enum: ['queue', 'steer'] },
  }, ['sessionId', 'prompt']),
  tool('dsh_read_session', 'Read a bounded transcript window with status and historical decision-event markers. Only user/assistant text is returned. Resolve active approvals in the Harness UI.', {
    sessionId, limit: integer(1, 100, 'Message window size; default 20.'),
    maxChars: integer(1, 8000, 'Per-message text ceiling; default 4000.'), beforeSeq: integer(0, Number.MAX_SAFE_INTEGER, 'Use nextBeforeSeq to page older history.'),
  }, ['sessionId'], true),
  tool('dsh_wait_session', 'Wait for a session to become idle and return its latest messages. Settled means the turn ended, not that the task succeeded. Timeouts and client cancellation never stop the Harness task.', {
    sessionId, timeoutMs: integer(0, 45000, 'Wait budget; default 30000. Host API requests can add up to 20 seconds.'),
  }, ['sessionId'], true),
  tool('dsh_cancel_session', 'Explicitly stop a Harness session turn. This does not undo changes already made by Harness tools.', { sessionId }, ['sessionId']),
  tool('dsh_rename_session', 'Change the visible title of one Harness session.', { sessionId, title: text('New title.', 200) }, ['sessionId', 'title']),
];

export function validateArguments(name, args) {
  const spec = TOOLS.find(t => t.name === name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) if (!Object.hasOwn(spec.inputSchema.properties, key)) throw new Error(`Unknown argument: ${key}`);
  for (const key of spec.inputSchema.required) if (!Object.hasOwn(args, key)) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = spec.inputSchema.properties[key];
    if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength)) throw new Error(`Invalid string argument: ${key}`);
    if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) throw new Error(`Invalid integer argument: ${key}`);
    if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid boolean argument: ${key}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid value for ${key}`);
  }
  if (args.cwd) {
    // Windows drive paths, UNC paths and POSIX absolute paths. The Harness
    // validates existence and enforces its workspace policy.
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(args.cwd)) throw new Error('cwd must be an absolute path.');
  }
}

export function createTools(harness = new Harness()) {
  return async (name, args = {}, signal = new AbortController().signal) => {
    validateArguments(name, args);
    switch (name) {
      case 'dsh_status': {
        const items = await harness.list(signal);
        return { connected: true, url: harness.base, sessions: items.length, running: items.filter(i => i.running).length,
          bridgeVersion: '1.0.0', authentication: 'launcher exchange; cookie in memory only' };
      }
      case 'dsh_list_sessions': {
        let items = (await harness.list(signal)).map(compactSummary);
        if (args.query) { const q = args.query.toLowerCase(); items = items.filter(i => [i.sessionId, i.title, i.cwd].some(v => v?.toLowerCase().includes(q))); }
        if (args.running !== undefined) items = items.filter(i => i.running === args.running);
        items.sort((a, b) => b.updatedAt - a.updatedAt);
        return { total: items.length, items: items.slice(0, args.limit ?? 20), truncated: items.length > (args.limit ?? 20) };
      }
      case 'dsh_run_prompt': return harness.run(args, signal);
      case 'dsh_continue_session':
        await harness.summary(args.sessionId, signal);
        return harness.send(args.sessionId, args.prompt, args.mode ?? 'queue', signal);
      case 'dsh_read_session': return harness.read(args.sessionId, args, signal);
      case 'dsh_wait_session': return harness.wait(args, signal);
      case 'dsh_cancel_session':
        await harness.summary(args.sessionId, signal);
        return { sessionId: args.sessionId, ...await harness.rpc('session/cancel', { sessionId: args.sessionId }, signal) };
      case 'dsh_rename_session':
        await harness.summary(args.sessionId, signal);
        return { sessionId: args.sessionId, ...await harness.rpc('session/rename', args, signal) };
    }
  };
}
