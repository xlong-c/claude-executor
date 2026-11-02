import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { runTask } from './run-task.mjs';

export const TOOL = {
  name: 'claude_execute',
  description: 'Delegate to Claude Code and WAIT SILENTLY until it finishes. Optionally run explicit acceptance commands and resume Claude to fix failing tests inside this ONE pending call. No progress polling or intermediate notifications. Return once for Codex review; never claim this replaces semantic review. Total timeout <=3600 seconds.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['cwd', 'task'],
    properties: {
      cwd: { type: 'string', description: 'Absolute project directory' },
      task: { type: 'string', description: 'Self-contained brief with scope, repo instructions and acceptance criteria' },
      outDir: { type: 'string', description: 'New absolute artifact directory; must not exist' },
      resume: { type: 'string', description: 'Recorded Claude session UUID for rework' },
      model: { type: 'string' }, readOnly: { type: 'boolean', default: false },
      allowTools: { type: 'array', items: { type: 'string' }, description: 'Optional scoped Bash(...) / PowerShell(...) grants' },
      maxTurns: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600, default: 1800 },
      maxAutoFixes: { type: 'integer', minimum: 0, maximum: 5, description: 'Test-driven retries before Codex wakes; default 2 with checks, otherwise 0' },
      checks: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['command', 'args'],
        properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 } } } },
    },
  },
};

export function serve({ input = process.stdin, output = process.stdout, execute = runTask } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let active;
  const send = message => output.write(JSON.stringify(message) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const handle = async request => {
    const { id, method, params = {} } = request;
    if (method === 'notifications/cancelled') {
      if (active?.id === params.requestId) active.controller.abort();
      return;
    }
    if (id === undefined) return;
    if (method === 'initialize') return reply(id, {
      protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion)
        ? params.protocolVersion : '2024-11-05',
      serverInfo: { name: 'claude-executor', version: '1.1.0' }, capabilities: { tools: {} },
      instructions: 'Use claude_execute once per implementation/rework batch. Keep its request pending; never poll status or emit progress while Claude runs. Mechanical checks/retries stay inside the tool. Review returned diff and evidence, then resume the recorded session if needed. Execution can last up to 3600 seconds; host tool_timeout_sec must exceed this by 60 seconds.',
    });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: [TOOL] });
    if (method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (params.name !== TOOL.name) return error(id, -32602, 'Unknown tool');
    if (active) return reply(id, { isError: true, content: [{ type: 'text', text: 'An execution is already pending. Do not duplicate it.' }] });
    const controller = new AbortController();
    active = { id, controller };
    try {
      const report = await execute(params.arguments, { signal: controller.signal });
      reply(id, { isError: report.status !== 'completed', content: [{ type: 'text', text: JSON.stringify(report) }] });
    } catch (failure) { reply(id, { isError: true, content: [{ type: 'text', text: failure.message }] }); }
    finally { active = undefined; }
  };
  lines.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { error(null, -32700, 'Invalid JSON'); return; }
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      error(request?.id ?? null, -32600, 'Invalid request'); return;
    }
    void handle(request).catch(failure => { if (request.id !== undefined) error(request.id, -32603, failure.message); });
  });
  // Disconnect means this invocation is no longer owned by a live client.
  lines.on('close', () => active?.controller.abort());
  return { close: () => { active?.controller.abort(); lines.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) serve();
