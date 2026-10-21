# Hooks

Purpose: user-configured shell commands that Pigeon runs at fixed points of a session —
before and after tool calls, when a prompt is sent, when a turn or session ends, around
compaction, for subagents and for approval notifications. Hooks can add context, rewrite
tool input or output, deny calls, or make the agent keep working.

## Configuration

- **HOOKS-001** Pigeon shall read hooks from the `hooks` section of each settings layer: event name → array of matcher groups, each group with an optional `matcher` and a `hooks` array of handlers with `type: "command"`, `command`, optional `timeout` (seconds) and optional `host` (boolean).
- **HOOKS-002** Pigeon shall accept only `"command"` as a handler type; any other type or any extra key in a handler or group is a settings error.
- **HOOKS-003** When a `hooks` section names an event other than the supported ones, Pigeon shall reject the settings with "settings file <file> (<layer>): unknown key <name> in hooks (valid: …)".
- **HOOKS-004** When a matcher other than empty, absent or `"*"` is not a valid regular expression, Pigeon shall reject the settings with "settings file <file> (<layer>): hooks.<Event>: matcher is not a valid regex: <matcher> (<error>)", followed by the file's path like other settings errors.
- **HOOKS-005** Pigeon shall enforce these limits: `command` 1–4000 characters, `matcher` at most 500 characters, 1–50 handlers per group, at most 100 groups per event, `timeout` an integer of at least 1.
- **HOOKS-006** Pigeon shall combine hooks from all settings layers side by side, dropping only a later entry whose event, matcher, command and `host` all equal an earlier one (`timeout` is not compared) and hooks left out when confirmation is skipped (SETTINGS-038).
- **HOOKS-007** When several matched hooks of one event run the same command in the same place (all on the local machine in a local session; in the container or on the host in a sandbox session), Pigeon shall run that command once for that event, whatever their matchers.
- **HOOKS-008** The hook list is fixed from the settings read when the session starts: see SETTINGS-026.

## Matchers

- **HOOKS-009** An absent matcher, an empty string and `"*"` shall match everything; any other matcher is an unanchored regular expression tested against the event's match target, except on the events of HOOKS-011.
- **HOOKS-010** The match target shall be: the tool name for `PreToolUse`, `PostToolUse` and `PostToolUseFailure`; `startup` or `resume` for `SessionStart`; `exit` or `switch` for `SessionEnd`; `auto` or `manual` for `PreCompact` and `PostCompact`; the notification type for `Notification`; the subagent type for `SubagentStart` and `SubagentStop`; the run's failure class (`business`, `infrastructure` or `unknown`, as used by `pigeon session list --class`) for `StopFailure`.
- **HOOKS-011** `UserPromptSubmit` and `Stop` shall ignore matchers: a matcher written on these events is not an error beyond the check of HOOKS-004, and their hooks run on every such event.

## Events

- **HOOKS-012** Pigeon shall support exactly these events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Notification`.
- **HOOKS-013** In the terminal UI, Pigeon shall fire `SessionStart` with source `startup` when a new session opens (at launch, by "/new" or "/clear", or started from the session panel) and with source `resume` when a session is continued at launch or by "/resume", reloaded by "/reload" or by a "/config" change, moved into a worktree, created by "/fork", or opened from the session panel's work list while not open in this Pigeon, whether entered or reopened in the background; making a session already open in the session panel the current one fires no `SessionStart`.
- **HOOKS-014** `SessionStart` shall send `source` and, when known, `model` as `<provider>/<model>`, alike in the terminal UI and `pigeon run`; in `pigeon run` it fires before the first turn (source `startup`, or `resume` when continuing).
- **HOOKS-015** Pigeon shall fire `SessionEnd` before the session is released: with reason `exit` when the terminal UI quits (for each open session, including those in the session panel), when a session is removed from the session panel or stopped there while it is still being opened, or when `pigeon run` finishes; with reason `switch` when "/resume", "/new", "/clear", "/reload", a "/config" change or a move into a worktree replaces a session and closes it. A replaced session that is still working moves to the session panel and fires no `SessionEnd` then, and a session that never fired `SessionStart`, such as one opened for a switch that is then refused, fires no `SessionEnd`.
- **HOOKS-016** Pigeon shall fire `UserPromptSubmit`, with `prompt`, for each message the user sends to a top-level session — the current one, one in the session panel, or the task of `pigeon run` — including messages released from the input queue; it does not fire for slash commands, for messages to a subagent, for turns started by hooks, or for turns started by notices such as finished background jobs or subagent results.
- **HOOKS-017** Pigeon shall fire `PreToolUse` for each tool call before any approval decision, with `tool_name`, `tool_input` and `tool_use_id`, except for calls to a tool that is not offered, calls whose arguments do not fit the tool's parameters, and the calls left in a batch after a `continue: false` from a `PreToolUse`, `PostToolUse` or `PostToolUseFailure` hook (HOOKS-048, HOOKS-049).
- **HOOKS-018** After a tool call, Pigeon shall fire `PostToolUse` with `tool_response` when it succeeded, or `PostToolUseFailure` with `error` when it failed; for a background command this happens when the job starts.
- **HOOKS-019** Pigeon shall fire `Stop` after a turn ends normally and `StopFailure` (with `error`) instead when the turn ended with an error, including a reply that stays empty after its retry, alike in the terminal UI and `pigeon run`; neither fires when the turn was interrupted or aborted, including by "Esc" or a hook's `continue: false`, or when the turn could not be started.
- **HOOKS-020** Pigeon shall fire `Stop` and `StopFailure` for every top-level session alike, including sessions running in the session panel and a turn that was handed to the panel while running; subagent sessions do not fire them (HOOKS-028).
- **HOOKS-021** `Stop` shall send `stop_hook_active` and `last_assistant_message`; `StopFailure` shall send `error` (the failure class it is matched on, HOOKS-010), `error_details` when available and `last_assistant_message` holding the error text, alike in the terminal UI and `pigeon run`.
- **HOOKS-022** In `pigeon run`, Pigeon shall not fire `Stop` when the run already ended on a turn, wall-clock, token or looping limit.
- **HOOKS-023** Pigeon shall fire `PreCompact` before a compaction (trigger `manual` for "/compact", `auto` otherwise) with `trigger` and `custom_instructions` (the "/compact" focus text, or null), and wait for it; it cannot prevent the compaction, and a failing `PreCompact` hook does not stop it.
- **HOOKS-024** Pigeon shall fire `PostCompact` after a compaction with `trigger` and `compact_summary`, without waiting for it.
- **HOOKS-025** In the terminal UI, Pigeon shall fire `Notification` with `notification_type` `permission_prompt` when any session raises an approval request, whether or not its box is shown in the current view, with `message` set to the box text; for a request from a session other than the current one, the message starts with the line "source: session <name>".
- **HOOKS-026** Pigeon shall fire `SubagentStart` once when a subagent is started (not when it is messaged later), before its first turn, with `agent_name` and `agent_type`; context it returns is prefixed to the subagent's task.
- **HOOKS-027** Pigeon shall fire `SubagentStop` when a subagent's turn completes normally (not when it failed or was stopped), with `agent_name`, `agent_type`, `stop_hook_active` and `last_assistant_message`.
- **HOOKS-028** Subagent sessions shall not fire `SessionStart`, `SessionEnd`, `Stop` or `StopFailure`; their tool, compaction, `SubagentStart` and `SubagentStop` hooks are recorded in the subagent's own session. `Notification` for an approval shall run with the hooks of the session the approval belongs to — for a subagent's approval, its top-level session — and be recorded there, also when that session is not the current one.

## Input

- **HOOKS-029** Pigeon shall pass each hook a one-line JSON object on standard input with `session_id`, `cwd`, `hook_event_name`, `permission_mode` and the event's own fields.
- **HOOKS-030** `permission_mode` shall be the session's approval mode at the moment the hook fires (`yolo` or `prompt`).
- **HOOKS-031** Pigeon shall set `PIGEON_PROJECT_DIR` for every hook: the project root for hooks on the local machine, the container's workspace root for hooks in a sandbox container.
- **HOOKS-032** Pigeon shall run each hook in the workspace root — inside the container for a hook that runs there, on the host otherwise — and report that directory as `cwd`.
- **HOOKS-033** `stop_hook_active` shall be `false` on the first check after a turn and `true` on checks after a turn that a stop hook made continue.

## Output

- **HOOKS-034** When a hook of an event that can block exits with code 2, Pigeon shall treat it as a block with the trimmed standard error as reason, or "Blocked by a hook (exit code 2, no reason given)" when it is empty; standard output is ignored. Exit code 2 from other events follows HOOKS-057.
- **HOOKS-035** When a hook exits with another non-zero code, ends without an exit code, cannot start, or times out, Pigeon shall treat it as a hook error that blocks nothing, with reason "hook exited with code <n>: <stderr>" (without ": <stderr>" when standard error is empty; <n> is "none" when there is no exit code), "starting hook failed: <message>" or "hook timed out (<ms> ms)"; for `Notification` and `StopFailure` the exit code is ignored (HOOKS-057).
- **HOOKS-036** When a hook exits with 0, Pigeon shall read standard output as JSON only if it is a JSON object after trimming; otherwise it is plain text.
- **HOOKS-037** Plain-text output (trimmed, capped at 2000 characters with "… (truncated)") shall become added context only for `SessionStart` and `UserPromptSubmit`; for other events it is only recorded.
- **HOOKS-038** Pigeon shall honour these JSON fields: `continue: false` with optional `stopReason`; `systemMessage`; `decision: "block"` with `reason`; and in `hookSpecificOutput`: `additionalContext`, `permissionDecision` (`allow`, `ask`, `deny`) with `permissionDecisionReason` and `updatedInput` for `PreToolUse`, and `updatedToolOutput` for `PostToolUse`.
- **HOOKS-039** A block without a reason shall read "Blocked by a hook (decision: block, no reason given)"; a deny without a reason shall read "Denied by a hook (permissionDecision: deny)".
- **HOOKS-040** Pigeon shall run all hooks matched by one event in parallel; the event is complete when all of them have finished, and Pigeon waits for that except for `PostCompact` and `Notification`.
- **HOOKS-041** In the terminal UI, a `systemMessage` from `SessionStart`, `UserPromptSubmit`, `Stop` or a subagent's `SubagentStart` shall be shown as a line in the message area.

## Decisions per event

- **HOOKS-042** Pigeon shall combine `PreToolUse` results as deny over ask over allow; a deny (exit 2, `decision: "block"` or `permissionDecision: "deny"`) blocks the call and its reason becomes the tool result the model sees.
- **HOOKS-043** When a `PreToolUse` hook allows a call, Pigeon shall skip only the human approval step: deny-listed tools are still refused, writes to protected paths still ask a person, and write tools still refuse paths outside the workspace as they would without the hook.
- **HOOKS-044** When a `PreToolUse` hook asks, Pigeon shall send the call to human approval even if a grant, bypass mode or the read tier would allow it automatically; a deny-listed tool stays refused (see APPROVALS-015).
- **HOOKS-045** When a `PreToolUse` hook returns `updatedInput`, Pigeon shall evaluate, approve, preview and run the call with the new arguments (the last hook that gives them wins); arguments that do not fit the tool's parameters are ignored and the originals used.
- **HOOKS-046** `additionalContext` from `PreToolUse`, `PostToolUse` and `PostToolUseFailure`, and the reasons of post-tool hooks that blocked, shall be appended to that call's result for the model.
- **HOOKS-047** When a `PostToolUse` hook returns `updatedToolOutput` as a string, Pigeon shall replace the tool result text with it.
- **HOOKS-048** When a `PreToolUse` hook returns `continue: false`, Pigeon shall block that call and every remaining call in the batch without running their hooks or asking for approval, send no further model request, and end the turn as aborted with "hook asked to stop: <reason>" (without a reason, "A hook asked to stop processing this turn").
- **HOOKS-049** When a `PostToolUse` or `PostToolUseFailure` hook returns `continue: false`, Pigeon shall end the turn as aborted; calls already started in the batch finish but run no post-tool hooks.
- **HOOKS-050** When `UserPromptSubmit` blocks or returns `continue: false`, Pigeon shall not start the turn. In the terminal UI, context waiting for that message (such as `SessionStart` context) is kept for the next one; in `pigeon run` the run ends aborted with "input blocked by hook: <reason>" for a block, or with the stop reason alone for `continue: false` ("hook stopped the session" when none is given).
- **HOOKS-051** When a session in the session panel has its message blocked by `UserPromptSubmit`, Pigeon shall fail that turn with "input blocked by hook: <reason>" ("input blocked by hook: hook stopped the session" for `continue: false` without a stop reason).
- **HOOKS-052** Context from `SessionStart` and `UserPromptSubmit` shall be prefixed once, separated by blank lines, to the next user message sent to the model; it does not change the system prompt.
- **HOOKS-053** When a `SessionStart` hook returns `continue: false`, Pigeon shall not start the session, alike in the terminal UI and `pigeon run`; `pigeon run` ends aborted with the stop reason, or "hook stopped the session" when none is given.
- **HOOKS-054** When a `Stop` hook blocks or returns `additionalContext`, Pigeon shall start a new turn whose input is the added context followed by the block reason; `continue: false` from a `Stop` hook ends without a new turn.
- **HOOKS-055** When a turn started by a `Stop` hook ends with an error, Pigeon shall fire `StopFailure` for it and stop the loop; when it is aborted, Pigeon shall stop without firing `Stop` again.
- **HOOKS-079** When "Esc" is pressed while a `Stop` hook runs, Pigeon shall not start the continuation turn that the hook asks for.
- **HOOKS-056** When a `SubagentStop` hook blocks or adds context, Pigeon shall run the subagent another turn with that text as input; `continue: false` ends it.
- **HOOKS-057** `SessionEnd`, `StopFailure`, `PreCompact`, `PostCompact`, `Notification` and `SubagentStart` shall not be able to block, and their runs shall not be recorded as `block` or shown as "hook blocked". `Notification` and `StopFailure` ignore the exit code; for the other four, exit code 2 only shows the hook's standard error to the user; `decision: "block"` from any of them is ignored.

## Stop-hook cap

- **HOOKS-058** `Stop` hooks shall force at most `stopHookBlockCap` (default 8) consecutive extra turns per user message; on the next block Pigeon stops continuing.
- **HOOKS-059** When the cap is reached in the terminal UI, Pigeon shall show "[hooks] Stop hook blocked <N> times in a row; not continuing".
- **HOOKS-060** When the cap is reached in `pigeon run`, the run shall end with status `stop-hook-limit` (see CLI-048).
- **HOOKS-061** `SubagentStop` shall share the same cap per task: after that many extra turns the subagent ends normally and reports its result; the count resets on a new task or message.

## Disabling

- **HOOKS-062** When `disableAllHooks` is true, Pigeon shall run no hooks, and "/hooks" shows "disableAllHooks: on" and "active hooks: none".
- **HOOKS-063** The `--no-hooks` flag of the terminal UI and `pigeon run` shall disable all hooks for that process, including sessions reloaded by "/reload" and sessions of other projects opened in it.
- **HOOKS-064** When `disableAllHooks` or `--no-hooks` is in effect, Pigeon shall not list hooks for confirmation, at startup or on "/reload"; unconfirmed hooks alone shall not make `pigeon run --no-hooks` fail without `--trust-config`.
- **HOOKS-065** "/reload" shall pick up changes to `disableAllHooks` and `stopHookBlockCap`.

## Where hooks run

- **HOOKS-066** Pigeon shall run a hook command through the system shell: `/bin/sh -c` on POSIX and `cmd.exe /d /s /c` (or `%COMSPEC%`) on Windows.
- **HOOKS-067** In a local session hooks shall run on the local machine; in a sandbox session they run inside the container at the workspace root, except hooks with `host: true`, which run on the host.
- **HOOKS-068** Default timeouts shall be 30 seconds for `UserPromptSubmit`, 1.5 seconds for `SessionEnd` and 600 seconds for other events; a hook's `timeout` overrides the default, but a `SessionEnd` hook is capped at 60 seconds.
- **HOOKS-069** When a local hook times out, Pigeon shall kill its whole process tree; when a container hook times out, Pigeon shall stop only that hook and keep the container running.
- **HOOKS-070** Pigeon shall capture at most 64 KiB each of a hook's standard output and standard error.
- **HOOKS-071** Pigeon shall start a matched hook only after any pending checkpoint of the hook's own session has finished, and the hook sees, and may change, the workspace as it is after that checkpoint (see SESSIONS-064); hooks of a subagent or sandbox session wait for no checkpoint.

## Records and display

- **HOOKS-072** Pigeon shall record every hook run in the session with event, command, matcher, exit code, whether it timed out, duration, conclusion (`pass`, `context`, `allow`, `deny`, `ask`, `block` or `error`) and an output summary: the trimmed standard error, or the standard output when standard error is empty, up to 2000 characters.
- **HOOKS-073** A hook record shall belong to the active run; outside a run, `Stop`, `StopFailure`, `SubagentStop` and auto-compaction `PostCompact` records belong to the run that just ended, and the rest are session-level entries.
- **HOOKS-074** `pigeon trace` shall list each hook run as "hook <Event> (matcher <m>): <conclusion> | exit <code> | <ms> ms | command <cmd> | output <summary>", with the matcher part only when the hook has one, "exit none" when there is no exit code, " (timed out)" after the code when it timed out, and the output part only when there is output; `pigeon replay` shows the same line with " | <conclusion>" after the matcher and without the output.
- **HOOKS-075** In the terminal UI, Pigeon shall show one alert line when a hook blocks ("hook blocked (<Event>): <reason>"), asks to stop ("hook asked to stop (<Event>): <reason>", with the command when no reason is given) or errors ("hook error (<Event>): <reason>") (see PANEL-019).
- **HOOKS-076** Hook runs before a session's first real write, and sessions holding nothing but hook runs: see SESSIONS-008, SESSIONS-010.
- **HOOKS-077** "/hooks" shall print, read-only, "== hooks ==", "disableAllHooks: on|off", one line per active hook "- <Event> (matcher: <m>) | <command> | <layer> | runs on host|runs in workspace | timeout <s>s" (the matcher part only when it is set and not empty), then "1 hook" or "<N> hooks"; with none, "active hooks: none".
- **HOOKS-078** "/hooks" shall work while a turn is running and show effective timeouts, including defaults (see SUBAGENTS-070).

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `hooks.<Event>` | none | Matcher groups for one event; all layers apply side by side. |
| `hooks.<Event>[].matcher` | match all | Unanchored regular expression; `""` or `"*"` matches all; ignored for `UserPromptSubmit` and `Stop`. |
| `hooks.<Event>[].hooks[].command` | required | Shell command, 1–4000 characters. |
| `hooks.<Event>[].hooks[].timeout` | 30 / 1.5 / 600 s | Per-hook timeout in seconds; `SessionEnd` at most 60. |
| `hooks.<Event>[].hooks[].host` | `false` | In a sandbox session, run on the host instead of the container. |
| `disableAllHooks` | `false` | Run no hooks. |
| `stopHookBlockCap` | `8` | Consecutive extra turns `Stop` / `SubagentStop` hooks may force. |

Flag: `--no-hooks` (this process only). Hooks receive `PIGEON_PROJECT_DIR`.

## Known limitations

- In `pigeon run`, the main session shows no line for blocked or failed hooks and does not print `systemMessage`; only subagents' hook notices reach standard error.
- Container hooks receive only `PIGEON_PROJECT_DIR` from the environment and always use `/bin/sh`.
- A container hook that itself exits with 124, 137 or 143 after its time limit has passed is reported as timed out.
- `systemMessage` from tool, compaction, notification, `SessionEnd`, `StopFailure` and `SubagentStop` hooks is not shown.
- `Notification` has only the `permission_prompt` type.
- Each matched hook starts a new process (in a sandbox, a new container exec).
