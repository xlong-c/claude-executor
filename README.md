# Claude Executor

`claude-executor` is a Codex skill and local stdio MCP server that delegates a bounded implementation task to the installed Claude Code CLI. Codex keeps ownership of planning, review, and the final decision; Claude performs the scoped file edits and optional mechanical checks.

The executor is deliberately local. It does not add an HTTP listener, npm runtime dependency, scheduler, or network fetcher. It uses Claude Code's native authentication and starts the native `claude` executable directly.

## Requirements

- Node.js 18 or newer
- Claude Code with `--safe-mode` and `--permission-prompts` support
- A working Claude Code authentication on the local machine

The implementation has been exercised with Claude Code 2.1.296 and Node.js 22. The Windows path uses `claude.exe`; POSIX systems use `claude`.

## Contents

- `SKILL.md`: Codex skill instructions and operating boundaries
- `agents/openai.yaml`: Codex skill metadata and MCP dependency declaration
- `scripts/mcp-server.mjs`: stdio MCP server exposing `claude_execute`
- `scripts/run-task.mjs`: one-call execution with bounded acceptance checks and automatic rework
- `scripts/delegate.mjs`: standalone CLI and Claude subprocess wrapper
- `scripts/*.test.mjs`: deterministic subprocess and MCP behavior tests

## Install as a Codex skill

Clone or copy this directory into the Codex skills directory as `claude-executor`:

```text
<CODEX_HOME>/skills/claude-executor/
```

Restart or reload the Codex MCP configuration after installation so the `claude_executor` server is available. The current skill expects the MCP tool named `claude_execute`; it does not silently fall back to a polling workflow.

## Run the tests

No package installation is needed:

```bash
npm test
```

The equivalent direct command is:

```bash
node --test scripts/delegate.test.mjs scripts/mcp.test.mjs
```

## Standalone CLI

The CLI accepts a UTF-8 task brief and writes an exclusive artifact directory containing the execution result and stream log:

```bash
node scripts/delegate.mjs \
  --cwd /absolute/path/to/project \
  --brief /absolute/path/to/brief.md \
  --model opus
```

On Windows PowerShell:

```powershell
node .\scripts\delegate.mjs `
  --cwd 'C:\path\to\project' `
  --brief 'C:\path\to\brief.md' `
  --model opus
```

Use `--read-only` for a planning-only run. Shell checks, writes, commits, pushes, MCP tools, and agent delegation are blocked by the wrapper. If checks are granted, pass each one as an explicit native executable and argument list; shell command strings are not interpreted.

## MCP configuration

The MCP server is a stdio process. A host configuration can point at the checked-out script:

```json
{
  "mcpServers": {
    "claude_executor": {
      "command": "node",
      "args": ["/absolute/path/to/claude-executor/scripts/mcp-server.mjs"]
    }
  }
}
```

Call `claude_execute` once for an implementation or rework batch and keep that request pending until it returns. Supply an absolute `cwd`, a self-contained `task`, and explicit acceptance `checks` when needed. The server serializes executions and rejects a duplicate active call.

## Safety and scope

The wrapper passes `--safe-mode`, disables slash commands, uses an empty strict MCP configuration, and denies commits, pushes, listeners, clipboard changes, and delegation. Acceptance commands are started without a shell and are bounded by the total timeout. Diagnostics are treated as data and are not executed as instructions.

This project is an orchestration wrapper, not a replacement for semantic review. A successful execution or passing mechanical check does not by itself certify the implementation.

## License

Apache License 2.0. See [LICENSE](LICENSE).
