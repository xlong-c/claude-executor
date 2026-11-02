import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delegate, parseArgs } from './delegate.mjs';

const root = process.env.CLAUDE_EXECUTOR_TEST_ROOT || path.join(tmpdir(), 'claude-executor-tests');
const SESSION = '12345678-1234-4234-8234-123456789abc';
async function fixture(source, brief = 'Only edit the named file. 中文任务 $() `literal` "quoted"') {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'run-'));
  const cwd = path.join(dir, 'workspace with spaces 中文');
  await mkdir(cwd);
  const briefPath = path.join(dir, 'brief.md');
  const cli = path.join(dir, 'fake-claude.mjs');
  await writeFile(briefPath, brief, 'utf8');
  await writeFile(cli, source, 'utf8');
  return { dir, cwd, brief, briefPath, cli,
    options: { cwd, brief: briefPath, outDir: path.join(dir, 'artifacts') },
    runtime: { cliCommand: process.execPath, cliPrefixArgs: [cli] } };
}
const readInput = `let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;`;
const success = `console.log(JSON.stringify({ type:'result', subtype:'success', is_error:false,
  result:'done', session_id:'${SESSION}', permission_denials:[] }));`;

test('stdin preserves Unicode/metacharacters; bounded tools and logs are real subprocess results', async () => {
  const f = await fixture(`import {writeFile} from 'node:fs/promises'; ${readInput}
    await writeFile('received.json', JSON.stringify({prompt,args:process.argv.slice(2),cwd:process.cwd()}));
    console.log(JSON.stringify({type:'system',subtype:'init',model:'routed-test-model',session_id:'${SESSION}'}));
    process.stderr.write('diagnostic only'); ${success}`);
  const report = await delegate(f.options, f.runtime);
  assert.equal(report.status, 'completed');
  assert.equal(report.sessionId, SESSION);
  assert.equal(report.actualModel, 'routed-test-model');
  assert.equal(report.requestedModel, null);
  const received = JSON.parse(await readFile(path.join(f.cwd, 'received.json'), 'utf8'));
  assert.equal(received.prompt, f.brief);
  assert(!received.args.some(arg => arg.includes(f.brief)));
  assert.equal(received.args[received.args.indexOf('--max-turns') + 1], '1000');
  assert.equal(received.args[received.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
  assert(received.args.includes('--safe-mode'));
  assert.equal(received.args[received.args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(await readFile(report.artifacts.request, 'utf8'), f.brief);
  assert.equal(await readFile(report.artifacts.stderr, 'utf8'), 'diagnostic only');
  assert.equal(JSON.parse(await readFile(report.artifacts.result, 'utf8')).status, 'completed');
});

test('resume UUID, scoped shell grant and model reach child exactly', async () => {
  const f = await fixture(`${readInput}
    console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(process.argv.slice(2))}));`);
  const report = await delegate({ ...f.options, resume: SESSION, model: 'test-model',
    allowTools: ['PowerShell(cargo test)'] }, f.runtime);
  assert.equal(report.status, 'completed');
  const args = JSON.parse(report.finalMessage);
  assert.equal(args[args.indexOf('--resume') + 1], SESSION);
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  assert(args[args.indexOf('--tools') + 1].endsWith(',PowerShell'));
  assert(args[args.indexOf('--allowedTools') + 1].includes('PowerShell(cargo test)'));
});

test('permission denial is not success even with exit zero and terminal success', async () => {
  const f = await fixture(`${readInput}
    console.log(JSON.stringify({type:'result',subtype:'success',result:'blocked',
      permission_denials:[{tool_name:'Write',tool_input:{file_path:'blocked.txt'}}]}));`);
  const report = await delegate(f.options, f.runtime);
  assert.equal(report.status, 'needs_attention');
  assert.equal(report.processExitCode, 0);
  assert.equal(report.permissionDenials.length, 1);
});

test('zero exit without terminal result and invalid JSON are rejected', async () => {
  for (const source of [`${readInput} console.log(JSON.stringify({type:'system'}));`,
    `${readInput} console.log('not JSON'); ${success}`]) {
    const f = await fixture(source);
    const report = await delegate(f.options, f.runtime);
    assert.equal(report.status, 'failed');
    assert(report.error);
  }
});

test('nonzero exit and terminal API error stay failed', async () => {
  for (const source of [`${readInput} ${success} process.exitCode=7;`,
    `${readInput} console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,errors:['auth unavailable']}));`]) {
    const f = await fixture(source);
    const report = await delegate(f.options, f.runtime);
    assert.equal(report.status, 'failed');
    assert(report.error);
  }
});

test('spawn failure is preserved as a failed report', async () => {
  const f = await fixture('');
  const report = await delegate(f.options, { cliCommand: path.join(f.dir, 'missing-executable') });
  assert.equal(report.status, 'failed');
  assert.match(report.error, /ENOENT/);
  assert.equal(JSON.parse(await readFile(report.artifacts.result, 'utf8')).status, 'failed');
});

test('deadline terminates its own worker and grandchild and writes timed_out', async () => {
  const f = await fixture(`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
    const grandchild=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    writeFileSync('pids.json',JSON.stringify([process.pid,grandchild.pid]));
    setInterval(()=>{},1000);`);
  const report = await delegate({ ...f.options, timeoutSeconds: 2 }, f.runtime);
  assert.equal(report.status, 'timed_out');
  const pids = JSON.parse(await readFile(path.join(f.cwd, 'pids.json'), 'utf8'));
  // Allow the OS to finish reaping terminated descendants.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
});

test('read-only strips edits and shells; unsafe argument combinations fail before launch', async () => {
  const f = await fixture(`${readInput}
    console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(process.argv.slice(2))}));`);
  const report = await delegate({ ...f.options, readOnly: true }, f.runtime);
  const args = JSON.parse(report.finalMessage);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.throws(() => parseArgs(['--cwd', f.cwd, '--brief', f.briefPath, '--read-only', '--allow-tool', 'PowerShell(*)']));
  assert.throws(() => parseArgs(['--cwd', f.cwd, '--brief', f.briefPath, '--resume', 'latest']));
  assert.throws(() => parseArgs(['--cwd', f.cwd, '--brief', f.briefPath, '--claude-path', 'C:\\x.cmd']));
  assert.throws(() => parseArgs(['--cwd', f.cwd, '--brief', f.briefPath, '--timeout-seconds', 'NaN']));
});

test('existing artifact directory cannot be overwritten', async () => {
  const f = await fixture(`${readInput} ${success}`);
  await mkdir(f.options.outDir);
  const marker = path.join(f.options.outDir, 'result.json');
  await writeFile(marker, 'keep me');
  await assert.rejects(delegate(f.options, f.runtime), /EEXIST/);
  assert.equal(await readFile(marker, 'utf8'), 'keep me');
});

test('manual CLI defaults to the maximum turn budget', async () => {
  const f = await fixture(`${readInput} ${success}`);
  assert.equal(parseArgs(['--cwd', f.cwd, '--brief', f.briefPath]).maxTurns, 1000);
});
