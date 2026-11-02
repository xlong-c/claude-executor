import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve, TOOL } from './mcp-server.mjs';
import { runTask, validateTask } from './run-task.mjs';

const root = process.env.CLAUDE_EXECUTOR_TEST_ROOT || path.join(tmpdir(), 'claude-executor-tests');
const UUID = '12345678-1234-4234-8234-123456789abc';
async function fixture() {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'mcp-'));
  return { dir, input: { cwd: dir, task: 'Fix value.txt only. Preserve tests and other files.', outDir: path.join(dir, 'artifacts') } };
}
function fakeReport(options) {
  return { status: 'completed', sessionId: UUID, actualModel: 'test-model', finalMessage: 'done',
    artifacts: { result: path.join(options.outDir, 'result.json') } };
}

test('one pending MCP call emits zero progress messages and exactly one terminal response', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  let resolve;
  let started;
  const start = new Promise(done => { started = done; });
  const pending = new Promise(done => { resolve = done; });
  const server = serve({ input, output, execute: async () => { started(); return pending; } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claude_execute', arguments: {} } }) + '\n');
  await start;
  await new Promise(done => setTimeout(done, 30));
  assert.equal(text.trim().split('\n').length, 1); // initialize only, no tool response or progress
  resolve({ status: 'completed', finalMessage: 'fixed' });
  await new Promise(done => setImmediate(done));
  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 2);
  assert.equal(messages.filter(message => message.id === 2).length, 1);
  assert.equal(messages[1].result.isError, false);
  assert(!messages.some(message => message.method));
  server.close(); input.destroy(); output.destroy();
});

test('failing acceptance command resumes the same worker inside one runTask call', async () => {
  const f = await fixture();
  let calls = 0;
  const report = await runTask({ ...f.input, checks: [{ command: process.execPath,
    args: ['-e', "if(require('node:fs').readFileSync('value.txt','utf8')!=='fixed') {console.error('expected fixed value');process.exit(1)}"] }] },
  { execute: async options => {
    calls++;
    if (calls === 2) {
      assert.equal(options.resume, UUID);
      const brief = await readFile(options.brief, 'utf8');
      assert(brief.includes('expected fixed value'));
      assert(brief.includes('do not weaken tests'));
      assert(brief.includes(f.input.task));
    }
    await writeFile(path.join(f.dir, 'value.txt'), calls === 1 ? 'broken' : 'fixed');
    return fakeReport(options);
  } });
  assert.equal(report.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(report.rounds[0].checks[0].status, 'failed');
  assert.equal(report.rounds[1].checks[0].status, 'passed');
  assert.equal(JSON.parse(await readFile(report.resultPath, 'utf8')).rounds.length, 2);
});

test('automatic retry budget ends with checks_failed rather than a success claim', async () => {
  const f = await fixture(); let calls = 0;
  const report = await runTask({ ...f.input, maxAutoFixes: 1,
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(7)'] }] },
  { execute: async options => { calls++; return fakeReport(options); } });
  assert.equal(calls, 2);
  assert.equal(report.status, 'checks_failed');
  assert.equal(report.rounds[1].checks[0].exitCode, 7);
});

test('MCP cancellation reaches only its active execution AbortSignal', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  let started;
  const start = new Promise(done => { started = done; });
  const server = serve({ input, output, execute: async (_args, { signal }) => {
    started();
    await new Promise(done => signal.addEventListener('abort', done, { once: true }));
    return { status: 'cancelled' };
  } });
  input.write(JSON.stringify({ id: 4, method: 'tools/call', params: { name: 'claude_execute', arguments: {} } }) + '\n');
  await start;
  input.write(JSON.stringify({ method: 'notifications/cancelled', params: { requestId: 4 } }) + '\n');
  await new Promise(done => setImmediate(done));
  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(messages[0].result.content[0].text).status, 'cancelled');
  assert.equal(messages[0].result.isError, true);
  server.close(); input.destroy(); output.destroy();
});

test('a hung acceptance command returns control at the total deadline', async () => {
  const f = await fixture();
  const report = await runTask({ ...f.input, timeoutSeconds: 2,
    checks: [{ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }] },
  { execute: async options => fakeReport(options) });
  assert.equal(report.status, 'timed_out');
  assert.notEqual(report.rounds[0].checks[0].status, 'passed');
});

test('unknown fields, shell shims, unsafe read-only combinations and excessive budgets fail closed', () => {
  const base = { cwd: path.resolve('.'), task: 'Read only' };
  assert.throws(() => validateTask({ ...base, shell: true }));
  assert.throws(() => validateTask({ ...base, timeoutSeconds: 3660 }));
  assert.throws(() => validateTask({ ...base, readOnly: true, checks: [{ command: 'node', args: ['-v'] }] }));
  assert.throws(() => validateTask({ ...base, checks: [{ command: 'flutter.bat', args: ['test'] }] }));
});

test('MCP and task defaults use the maximum turn budget', () => {
  const base = { cwd: path.resolve('.'), task: 'Bounded implementation task' };
  assert.equal(TOOL.inputSchema.properties.maxTurns.default, 1000);
  assert.equal(validateTask(base).maxTurns, 1000);
});
