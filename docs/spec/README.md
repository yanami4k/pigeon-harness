# Behavior specifications

These pages state how Pigeon behaves, as numbered rules that can be checked one by one against
the code and its tests; a rule that changes is changed in the same commit as the code. Each
page has a short purpose, the rules grouped by topic, the settings that affect the area, and
known limitations.

Rule numbers (such as `PANEL-011`) are stable references.

| Area | Page | What it covers |
| --- | --- | --- |
| CLI | [cli.md](cli.md) | Starting Pigeon, `pigeon run`, `trace`, `replay`, `session list` and maintenance commands, options, exit codes, `--version`. |
| Settings | [settings.md](settings.md) | Settings layers and merging, validation, confirming settings that run commands, `/config`, `/reload`, key bindings. |
| Sessions | [sessions.md](sessions.md) | Session records, resuming and `--continue`, `/resume`, `/new`, `/clear`, names, `/rewind` with file checkpoints, `/fork`, token counts. |
| Panel | [panel.md](panel.md) | The session panel, the work list, sessions open elsewhere, `Ctrl+X`, short input. |
| Views | [views.md](views.md) | Main, subagent and read-only views, status bar, spinner, thinking effort, approval mode, `/status`, input, scrolling, the key table. |
| Subagents | [subagents.md](subagents.md) | Spawning, agent types, limits, messages and results, stopping, the subagent panel, waiting in `pigeon run`. |
| Approvals | [approvals.md](approvals.md) | Approval modes, the approval box and keys, grants and saved rules, the workspace fence, protected paths, confirming project rules. |
| Worktrees | [worktrees.md](worktrees.md) | `--worktree`, `enter_worktree`, subagent worktrees, `/take`, `take_changes`, `/worktrees clean`. |
| Tools | [tools.md](tools.md) | File tools, `run_command` and background jobs, search, task list, short names, web tools, MCP, skills. |
| Memory | [memory.md](memory.md) | AGENTS.md instruction files, learned memory and `/memory`, session search tools. |
| Hooks | [hooks.md](hooks.md) | Hook configuration, events, input and output protocol, decisions, where hooks run, `/hooks`. |
| Sandbox | [sandbox.md](sandbox.md) | `--sandbox`, images, resource limits, what the container sees, delivering changes, leftover containers. |
| Rendering | [rendering.md](rendering.md) | Markdown, formulas, links, images, tool output and history in the message area. |
| Context | [context.md](context.md) | Compaction, pruning, loop detection, continuation after a cut, repetition detection, retries, wall-clock budget, startup status, system prompt. |
| Model access | to be written | Connecting models (`--stream-fn`, `--provider`, `--model`) and model information; being redesigned. |
