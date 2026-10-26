import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Harness, localUrl, projectPage } from '../scripts/lib/harness.mjs';
import { validateArguments, createTools } from '../scripts/lib/tools.mjs';

test('only loopback HTTP endpoints are allowed', () => {
  for (const url of ['http://127.0.0.1:3081', 'http://localhost:1', 'http://[::1]:3081']) assert.ok(localUrl(url));
  for (const url of ['https://example.com', 'http://192.168.1.2', 'http://127.0.0.1.evil.test', 'http://user:secret@localhost']) assert.throws(() => localUrl(url));
});

test('arguments reject unknown fields, inherited properties, invalid types and relative cwd', () => {
  assert.throws(() => validateArguments('dsh_run_prompt', { prompt: 'x', cwd: 'relative' }));
  assert.throws(() => validateArguments('dsh_run_prompt', JSON.parse('{"prompt":"x","__proto__":{}}')));
  assert.throws(() => validateArguments('dsh_run_prompt', Object.create({ prompt: 'x' })));
  assert.throws(() => validateArguments('dsh_wait_session', { sessionId: 'x', timeoutMs: 50000 }));
  assert.throws(() => validateArguments('dsh_read_session', { sessionId: 'x', limit: 1.2 }));
  validateArguments('dsh_run_prompt', { prompt: 'x', cwd: 'C:\\Work' });
});

test('transcript bounds text, omits reasoning and tool output, exposes paging and queue counts', () => {
  const summary = { sessionId: 'x', running: true, projections: { asOfSeq: 10, values: { inbox: { 'next-turn': [{ privateText: 'must not leak' }] } } } };
  const result = projectPage(summary, { hasMore: true, records: [
    { event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello world' }] } } },
    { event: { seq: 1, type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected prompt' }] } } },
    { event: { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'answer' }] } } } },
    { event: { seq: 3, type: 'tool/result', data: { secret: 'tool output' } } },
    { event: { seq: 4, type: 'approval/asked', data: { command: 'sensitive command' } } },
  ] }, { maxChars: 5 });
  assert.equal(result.messages[0].text, 'hello');
  assert.equal(result.messages[0].truncated, true);
  assert.equal(result.messages[1].text, 'answe');
  assert.equal(result.nextBeforeSeq, 1);
  assert.equal(result.queue.nextTurn, 1);
  for (const privateValue of ['hidden', 'must not leak', 'tool output', 'sensitive command', 'injected prompt']) assert.ok(!JSON.stringify(result).includes(privateValue));
});

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'local-dsh-control-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const readyFile = join(dir, 'ready');
  await writeFile(readyFile, `${base}/?token=fixture-secret`);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { base, readyFile };
}

test('authentication refreshes once after 401; RPC uses slash endpoint and _request field', async t => {
  let exchanges = 0, calls = 0;
  const config = await fixture(t, async (req, res) => {
    if (req.url.startsWith('/?token=')) { exchanges++; res.writeHead(303, { 'set-cookie': `dsh=session${exchanges}; HttpOnly`, location: '/' }); res.end(); return; }
    assert.equal(req.url, '/api/session/list');
    calls++;
    if (calls === 1) { res.writeHead(401); res.end(); return; }
    assert.equal(req.headers.cookie, 'dsh=session2');
    let body = ''; for await (const chunk of req) body += chunk;
    const envelope = JSON.parse(body);
    assert.deepEqual(envelope.payload, { args: { _request: {} } });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } }));
  });
  const harness = new Harness(config);
  assert.deepEqual(await harness.list(), []);
  assert.equal(exchanges, 2); assert.equal(calls, 2);
});

test('ready file cannot send its token to a different port or host', async t => {
  const config = await fixture(t, (_req, res) => res.end());
  await writeFile(config.readyFile, 'http://127.0.0.1:1/?token=secret');
  await assert.rejects(new Harness(config).list(), /does not match/);
});

test('network failure never retries a possibly accepted mutation', async () => {
  let calls = 0;
  const harness = new Harness({ fetch: async () => { calls++; throw new Error('reset'); } });
  harness.cookie = 'fixture';
  await assert.rejects(harness.rpc('session/prompt', {}), /may have been accepted/);
  assert.equal(calls, 1);
});

test('waiting times out without cancelling, and does not mark queued work complete', async () => {
  const harness = new Harness();
  harness.read = async () => ({ sessionId: 'x', running: false, queue: { nextTurn: 1, nextStep: 0 }, messages: [] });
  harness.rpc = () => { throw new Error('wait must never mutate'); };
  assert.equal((await harness.wait({ sessionId: 'x', timeoutMs: 0 })).waitStatus, 'timedOut');
  harness.read = async () => ({ running: false, queue: { nextTurn: 0, nextStep: 0 }, lastTurn: { reason: 'error' } });
  const result = await harness.wait({ sessionId: 'x' });
  assert.equal(result.waitStatus, 'settled');
  assert.equal(result.lastTurn.reason, 'error');
});

test('failed post-create operation reports the created session ID', async () => {
  const harness = new Harness(); let sessionId;
  harness.rpc = async (method, request) => {
    if (method === 'session/create') { sessionId = request.sessionId; return { sessionId }; }
    throw new Error('rename failed');
  };
  await assert.rejects(harness.run({ prompt: 'x', title: 'x' }), error => error.message.includes(sessionId) && error.message.includes('was created'));
});


test('CLI describes actions and accepts BOM JSON without shell argument interpolation', async t => {
  const script = fileURLToPath(new URL('../scripts/dsh.mjs', import.meta.url));
  const describe = spawnSync(process.execPath, [script, '--describe', 'dsh_run_prompt'], { encoding: 'utf8', windowsHide: true });
  assert.equal(describe.status, 0, describe.stderr);
  assert.ok(JSON.parse(describe.stdout).required.includes('prompt'));
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'input with spaces.json');
  await writeFile(input, '\uFEFF' + JSON.stringify({ sessionId: 'fixture' }));
  const invalid = spawnSync(process.execPath, [script, 'dsh_continue_session', '--input', input], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Missing argument: prompt/);
  assert.ok(!invalid.stderr.includes('Unexpected token'));
});
