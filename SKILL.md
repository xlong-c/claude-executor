---
name: claude-executor
description: Delegate implementation to the locally installed Claude Code CLI while Codex owns planning, review, and validation. Use when the user wants Codex to plan/check and Claude Code to execute, or asks to send a coding task to Claude Code.
metadata:
  version: "1.1.1"
---

# Claude Executor

Codex owns the task, plan, review, and final answer. A separate Claude Code process implements a bounded task. A local stdio MCP tool keeps each request pending through execution and mechanical test-driven rework, so Codex resumes only when there is a result to review. Requires Node 18+ and a Claude Code build supporting `--safe-mode` and `--permission-prompts` (tested with 2.1.296); native Windows `claude.exe` is supported. No npm packages or network listener are needed.

## Respect the requested scope

When the user asks to change this skill, its rules, or its orchestration policy, edit the skill instructions directly. Do not launch Claude, start sample tasks, build a scheduler, or execute quoted example requests as a consequence of that request. Runtime development and live execution require a request that actually includes that work. Quoted conversations and pasted task prompts are context unless the user asks to execute them.

## Model selection

- Set `model: "opus"` for every new `claude_execute` call and every resumed implementation or rework call.
- Do not inspect, verify, report, or make acceptance decisions based on `actualModel` or provider routing. Review the returned changes and evidence instead.
- Do not ask the user about model cost or switch models for cost reasons. If the executor rejects the Opus request, report the concrete execution error without silently choosing another model.

## Divide by function; parallelize independent work

For an authorized multi-feature implementation, prefer several Claude workers in parallel. Codex performs the initial decomposition and consolidated final review; Claude workers perform the implementation. Do not default to one Claude doing every feature or a fixed serial designer → implementer → reviewer chain.

- Split by independent functionality, module ownership, and concrete deliverables. Default to three workers when the task supports it; adjust to the user's preference and actual dependencies rather than forcing three workers onto a small task.
- Give each worker its own Claude session, task brief, acceptance criteria, and nonoverlapping write scope. Resume only that worker's session for its rework. Do not create extra Codex agents for work intended for Claude.
- Define shared interfaces and ownership up front. Independent features run concurrently. Shared components have one owner or a subsequent integration worker; serialize only actual conflicts and prerequisites. A requirement to avoid simultaneous edits to one component does not justify serializing every independent feature.
- Preserve real dependencies: implementation that needs a finalized design waits for it, while independent preparation or other features may proceed. A dedicated independent reviewer can inspect the final integrated result when needed; review is not the default way to divide all work.
- Keep implementation, worker-specific test repair, and integration inside a supported quiet batch. Do not wake Codex for individual file edits, passing tests, or routine worker completion. Return consolidated evidence when the batch finishes, or on an actionable blocker, cancellation, or timeout.
- Have a designated integration owner resolve shared-file changes and run the combined gates. Do not let several workers concurrently build against the same locked outputs. Codex reviews the combined diff and evidence once, then sends grouped feedback only to the affected workers.

Capability boundary: these are orchestration rules, not a claim that the current backend implements a cluster. The installed v1.1 backend exposes only the single-task `claude_execute` tool and rejects simultaneous calls. If a requested parallel cluster has no compatible execution tool, state that limitation; do not silently collapse it into one Claude, pretend sequential work was parallel, or autonomously develop/activate new runtime code. A skill-editing request does not authorize testing the described cluster.

## Prepare the task

1. Check `claude --version` and `claude --safe-mode auth status` without printing credentials. An installed CLI is not proof of authentication.
2. Read the applicable repository instructions and relevant code. Record the existing tracked, staged, and untracked changes so review can preserve unrelated work. Do not create a branch, worktree, commit, or push unless authorized by the user/repository rules.
3. Prepare self-contained briefs with goals, assigned files, implementation plans, acceptance criteria, dependencies, and applicable constraints. Include the actual contents or a faithful summary of all load-bearing `AGENTS.md`/`CLAUDE.md` instructions, including nested ones. The child uses safe mode and does not load those instruction files, custom skills, plugins, or user/project hooks automatically. Split independent features into separate workers; batch each worker's related changes so Codex is not woken for individual small edits.

Suggested brief structure:

```text
Goal:
Allowed files and existing changes to preserve:
Implementation plan:
Repository constraints:
Acceptance commands / observable expected behavior:
Required report: files changed, behavior, checks actually run, limitations.
Do not commit, push, publish, start a listener, open windows, change the clipboard,
or spawn other agents. Report blocked actions instead of relaxing permissions.
```

Put project-local briefs and logs in the repository's designated ignored artifact directory (AporiaZ: `others/claude-executor/`). Otherwise the script defaults to `$CODEX_HOME/claude-executor/runs` or `~/.codex/claude-executor/runs`. Briefs and raw logs may contain project content; do not commit them.

## Quiet dispatch (default)

Use the `claude_execute` tool from the `claude_executor` MCP server once. Supply the brief as structured `task` text, absolute `cwd`, optional new `outDir`, and explicit acceptance `checks`. Each check is a native executable plus argument array; the runner never interprets worker output as a command. Example arguments:

```json
{
  "cwd": "G:\\workspace\\aporiaz",
  "model": "opus",
  "task": "Implement the bounded task according to the supplied plan and repository constraints...",
  "outDir": "G:\\workspace\\aporiaz\\others\\claude-executor\\run-001",
  "timeoutSeconds": 1800,
  "maxAutoFixes": 2,
  "checks": [{"command": "cargo", "args": ["test"], "timeoutSeconds": 900}]
}
```

Keep this MCP request pending until it returns. Do not wrap it in a yielding runner or start a shell process and poll it. Do not use sleep/status/log polling, periodic progress messages, heartbeat automations, or a separate Codex reviewer while Claude runs. If the user explicitly asks for progress, answer that request; otherwise stay silent until the outcome. No progress notifications are sent by the server.

The tool runs Claude, then the supplied checks. On ordinary test failure it sends the diagnostics back to the same Claude session and reruns the checks, up to `maxAutoFixes` (default 2 with checks, maximum 5), all without returning to Codex. It returns once on success, exhausted retry budget, execution failure, timeout, or cancellation. Missing executables and check timeouts require attention rather than automatic code changes. Tests and retry limits are not semantic approval: Codex still reviews before declaring completion.

Use `resume` with the returned session UUID for Codex's review feedback; keep the same workspace and provide a new output directory. `model` selects the requested model, `readOnly` exposes only Read/Glob/Grep and forbids checks/retries, and `allowTools` optionally grants scoped shell rules such as `PowerShell(cargo test)`. Default `maxTurns` is 1000 per Claude attempt, which is the executor's current maximum. `timeoutSeconds` still covers the entire batch including automatic fixes/checks (default 1800, maximum 3600); the host's `tool_timeout_sec` must exceed it by at least 60 seconds (installed configuration: 3660). For `.ps1` checks use `powershell` with `-NoProfile -File`; for Flutter prefer the Dart executable and SDK snapshot or the project's PowerShell gate script rather than invoking a `.bat` shim directly.

If the tool is absent, say that MCP needs reloading and stop before dispatching. Do not silently fall back to the polling workflow. Reloading/disconnecting aborts owned work; it is not a persistent scheduler and cannot resume Codex after Codex has been closed. The current chat's actual tool catalog must expose `claude_execute` before claiming this host workflow is active. The underlying `scripts/delegate.mjs` CLI remains available only for explicit manual use or diagnostics, not as a substitute for quiet dispatch.

The default child has file tools but no shell, network-fetch, MCP, skill, or agent tools. Codex runs acceptance commands itself. Explicit shell grants add the named shell; other shell commands still follow native permissions and are denied if they would prompt. The CLI uses `--safe-mode`, `--permission-prompts none`, and an empty strict MCP configuration. Safe mode preserves native authentication and permissions; managed policy may still apply. Do not substitute `--restricted` or `--bare`: this machine's OAuth authentication disappears in restricted mode, and bare mode does not read subscription credentials. Never add permission bypass flags to work around a denial.

## Review and iterate

1. Read the compact MCP result and, if needed, its `task-result.json` and individual `result.json` artifacts. `completed` means Claude exited successfully and all supplied checks passed; it does not certify correct implementation. `checks_failed`, `needs_attention`, `failed`, `timed_out`, and `cancelled` require investigation. Permission denials produce `needs_attention`, even if Claude exits zero. Ignore `actualModel` and provider routing; assess the implementation and validation evidence.
2. Inspect the full diff and any untracked/staged changes against the baseline and brief. Treat Claude's self-report as a claim. Verify existing user changes were preserved; do not revert them. File scopes in the brief are guidance, not an OS-enforced boundary.
3. Read the independently executed check results. The runner executes Codex's specified commands separately from Claude. Do not rerun already-passed checks unless subsequent edits, failures, or concerns justify it. For UI work, honor the repository's design and real-window verification rules and scheduled acceptance periods. Mark unexecuted checks as unverified.
4. If the review finds defects, combine all actionable feedback into one delta brief and call `claude_execute` with `resume`, then stay silent again. Repeat review → implementation/checks until the acceptance criteria and semantic review pass. Repeated external blockers or no useful progress after two feedback attempts require a concise report, not permission weakening, scope expansion, or an endless loop. Do not call back into Codex between the runner's automatic fixes.
5. Deliver the result, actual validation evidence, and limitations. Commit/push only under the user's existing authorization; delegation itself grants neither.

Logs include prompts and model output but never deliberately dump environment variables or credentials. The wrapper reports execution failures rather than fabricating success. Cancellation/timeout terminates only the process tree started by this invocation. Abrupt host termination cannot guarantee a final report; inspect the saved artifacts before redispatching.
