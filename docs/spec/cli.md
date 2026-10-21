# CLI

Purpose: how Pigeon is started from the shell — the terminal UI and its launch options,
unattended runs with `pigeon run`, the read-only inspection commands `trace`, `replay` and
`session list`, the maintenance commands `sandbox`, `worktrees` and `migrate-config`, help,
version and exit codes. Model access options are specified separately.

## Routing, help and version

- **CLI-001** When the first argument is not `--help`, `-h`, `help`, `--version` or a subcommand, Pigeon shall start the terminal UI and pass all arguments to it; `pigeon` alone starts the terminal UI.
- **CLI-002** Pigeon shall recognise exactly these subcommands: `run`, `trace`, `replay`, `session list`, `resume`, `sandbox`, `worktrees` and `migrate-config`.
- **CLI-003** `--help`, `-h` or `help` shall print the top-level usage, listing the terminal UI forms (including `--worktree <name>`) and each subcommand, and exit with 0.
- **CLI-004** `--version` shall print one line "pigeon <version> (commit <short hash>)", adding ", uncommitted changes" when Pigeon's own checkout has uncommitted changes or untracked files that are not ignored (for a packaged build, when it was built), and exit with 0; unknown parts read "unknown".
- **CLI-005** When `--help` or `-h` is among the arguments of `run`, `trace`, `replay`, `session list`, `resume`, `sandbox`, `worktrees` or `migrate-config`, Pigeon shall print that subcommand's own usage and exit with 0; `--version` is recognised only as the first argument.
- **CLI-006** `pigeon session` not followed by `list` shall fail with the usage "usage: pigeon session list [--tool <name>] [--class <cancelled|business|infrastructure|unknown>] …".
- **CLI-007** When a command fails before or instead of doing its work (bad arguments, missing files, refused settings), Pigeon shall print the error message without a stack trace on standard error and exit with 1; a `pigeon run` that has started ends by its status (see CLI-048), an uncaught error in the running terminal UI is printed with its stack (see CLI-067), and `pigeon worktrees clean` without a terminal and without `--yes` prints its plan and "no terminal to confirm; rerun with --yes" on standard output and exits with 0.
- **CLI-008** The standard output of the commands other than the terminal UI — help, version, the run summary and `--json` line, trace, replay, session list, maintenance results and the `pigeon worktrees clean` question — shall carry no terminal control characters other than newline and tab: human-readable text is neutralised (see RENDERING-049), and the `--json` line writes control characters as JSON escapes, U+007F–U+009F included as `\u` escapes.
- **CLI-009** The terminal UI shall run as a child process sharing the terminal; the launcher ignores Ctrl+C meanwhile and exits with the UI's exit code (1 if it was killed by a signal).
- **CLI-010** A packaged build shall start the terminal UI from the same packaged file.

## Terminal UI options

- **CLI-011** `--continue` and `--resume` exclude each other: see SESSIONS-020.
- **CLI-012** Reading the session ID after `--resume`: see SESSIONS-019.
- **CLI-013** `pigeon resume [session ID] [options]` as `pigeon --resume`: see SESSIONS-023.
- **CLI-014** Refusing unknown, unrecognised-format and cross-mode sandbox resumes before taking the terminal: see SESSIONS-021.
- **CLI-015** `--worktree <name>` parsing and its conflicts with `--sandbox`, `--continue` and `--resume`: see WORKTREES-020, WORKTREES-021 and SESSIONS-020.
- **CLI-016** The terminal UI shall accept `--history-limit <n>` and fail with "--history-limit needs a positive integer (…)" when n is not a positive integer; `pigeon run` rejects it as an unknown option (see RENDERING-061).
- **CLI-017** The terminal UI shall reject the run-only options `--json`, `--max-turns`, `--wall-clock`, `--governance-root`, `--trust-config` and `--edit-mode` as unknown options.

## Options of both entries

- **CLI-018** The terminal UI and `pigeon run` shall both accept `--yolo`, `--no-hooks`, `--no-web`, `--no-persist-thinking`, `--no-pushed-memory`, `--no-session-search`, `--no-subagents`, `--thinking <level>`, `--max-output-tokens <n>`, `--context-window <n>`, `--compact-threshold <n>`, `--compact-keep <n>`, `--root <dir>` and `--sandbox` with its options.
- **CLI-019** An unrecognised option shall fail with "unknown option: <option> (<usage>)", except that `pigeon sandbox`, `pigeon worktrees` other than `clean`, and `pigeon session` not followed by `list` fail with their usage line (see SANDBOX-078, WORKTREES-064, CLI-006), a subcommand given `--help` or `-h` prints its usage (see CLI-005), and arguments after a first argument `--help`, `-h`, `help` or `--version` are ignored.
- **CLI-020** Switch options shall take no value and never consume the next argument.
- **CLI-021** `--thinking` shall accept `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; any other value fails with "--thinking takes off/minimal/low/medium/high/xhigh/max (…)".
- **CLI-022** `--max-output-tokens` shall need a positive integer, failing otherwise with "--max-output-tokens needs a positive integer (…)" (see CONTEXT-073).
- **CLI-023** `--context-window`, `--compact-threshold` and `--compact-keep` on both entries: see CONTEXT-005.
- **CLI-024** `--root <dir>` shall set the session's working directory (default the current directory), resolved through symbolic links; a missing directory fails the start.
- **CLI-025** `--root` (in every entry), trace's `--run`, replay's `--session` and `pigeon migrate-config --root` given as the last argument, without a value, shall fail with "<option> needs a value"; other options that need a value keep their own errors for a missing value.
- **CLI-026** `--no-hooks` disables all hooks for the process: see HOOKS-063.
- **CLI-027** `--no-web` withholds the web tools: see TOOLS-096.
- **CLI-028** The usage line printed with an error shall list all of the command's options, apart from "usage: pigeon --worktree <name>" (see WORKTREES-020); the terminal UI's includes `--worktree` and `--no-session-search`, and `pigeon run`'s includes `--provider <name>`, `--model <id>`, `--no-session-search`, `--no-persist-thinking` and `--edit-mode hashline|replace`.

## pigeon run

- **CLI-029** `pigeon run` shall take the task from its first argument not starting with "-", otherwise from all of standard input; an unrecognised word starting with "-" fails with "unknown option: <word> (<usage>)", the task is trimmed, and an empty one fails with "task is empty (usage: …)".
- **CLI-030** A second positional argument shall fail with "unknown option: <argument> (<usage>)".
- **CLI-031** `--max-turns <N>` and `--wall-clock <ms>` shall need a positive integer, failing otherwise with "<option> needs a positive integer (…)".
- **CLI-032** With `--max-turns N`, the run shall stop after N model turns with status `turn-limit`; a run whose Nth turn ends on its own is `completed`.
- **CLI-033** With `--wall-clock <ms>`, the run shall stop with status `wall-clock-limit` when that time has passed since the start, time spent waiting for background jobs included (see SUBAGENTS-083).
- **CLI-034** A `--wall-clock` value above 2147483647 shall fail before the run starts with an error that states the maximum 2147483647.
- **CLI-035** `--governance-root <dir>` shall take settings, `.mcp.json` and Pigeon's state from that directory instead of the working directory; without a value or followed by a word starting with `--` it fails with "--governance-root needs a directory (…)", and with `--sandbox` it fails with "--governance-root can't be used with --sandbox".
- **CLI-036** `pigeon run`, `trace`, `replay`, `session list` and `migrate-config` shall take a `--root` (default the current directory) inside a worktree under `.pigeon/worktrees`, or in a subdirectory of one, as belonging to the main checkout, reading settings and state there as the terminal UI does (see WORKTREES-043).
- **CLI-037** Unconfirmed settings that run commands or grant permissions in `pigeon run`: see SETTINGS-040.
- **CLI-038** Refusing to start with a configuration layout that needs migrating: see SETTINGS-025.
- **CLI-039** `pigeon run` shall accept `--edit-mode hashline|replace` (default `replace`), failing otherwise with "--edit-mode takes hashline/replace (…)".
- **CLI-040** Calls that need approval in `pigeon run`, which has no approval channel: see APPROVALS-015.

## Output and status

- **CLI-041** Without `--json`, the run shall end with one line "session <id> | status <status> | class: <badge> | <n> turn(s) | <n> tool call(s) | <n> approval(s) needed | <n> token(s) | label <label>", plus " | <error>" when there was one; the counts cover every run of the session in this invocation.
- **CLI-042** The badge shall be one of `ok`, `cancelled`, `breaker`, `business failure`, `infrastructure error` and `unknown`.
- **CLI-043** The label shall be one of `Passed`, `Failed`, `Abandoned`, `InfrastructureError` and `Unknown`; a normally completed run is `Unknown` and a run stopped by a limit or loop detection is `Failed`.
- **CLI-044** With `--json`, the result shall be one JSON line, the last on standard output, with `sessionId`, `status`, `failure`, `turns`, `toolCalls`, `approvalsNeeded`, `usage`, `label`, `durationMs` (`turns`, `toolCalls`, `approvalsNeeded` and `usage` covering every run of the session in this invocation) and, when present, `runId`, `errorMessage`, `looping` and `keptJobs` (jobs of the session and its subagents still kept at the end, each with `sessionId`, `jobId`, `command` and, for a local job, `pid`). With `--sandbox` it shall also have `sandboxNotice` and, when the changes were handed back, `sandbox` with `branch`, `commit`, `changed`, `viewCommand` and, when the branch starts with a snapshot, `snapshotCommit`; it then has no `keptJobs`.
- **CLI-045** `approvalsNeeded` shall count, over every run of the session in this invocation, writing, command and network calls that needed a person — approved under bypass, answered by a person, or refused for lack of an approval channel — and shall not count calls allowed by rules, grants or a `PreToolUse` hook, calls to approval-free tools, calls refused by the deny list or by a `PreToolUse` hook, reading calls, calls interrupted before a result, or calls in sub-agents' sessions.
- **CLI-046** The line printed after a loop stop: see CONTEXT-055.
- **CLI-047** Sandbox notices of `pigeon run --sandbox` on standard error: see SANDBOX-056.
- **CLI-048** `pigeon run` shall exit with a code by status: `completed` 0, `failed` 2, `aborted` 3, `unknown` 4, `turn-limit` 5, `wall-clock-limit` 6, `token-limit` 7, `empty-reply` 8, `looping` 9, `stop-hook-limit` 10; 1 means the run never started.
- **CLI-049** The run shall end `failed` on a model or internal error and `aborted` when it is cancelled (see CONTEXT-072 for `empty-reply`, HOOKS-050 and HOOKS-053 for stops by a hook).
- **CLI-050** Ending `stop-hook-limit` when `Stop` hooks keep blocking: see HOOKS-060.
- **CLI-051** During `pigeon run`, the notice of truncated instructions and the line "web_search not registered: <reason>" shall go to standard error (see also SUBAGENTS-025, CONTEXT-027, SUBAGENTS-082).
- **CLI-052** `pigeon run` shall record its session in the project's `.pigeon/state/sessions/` (the `--governance-root` directory when given) in the same form as terminal UI sessions, and `trace`, `replay` and `session list` shall show it.

## trace, replay and session list

- **CLI-053** `pigeon trace <session ID> [--run <run ID>] [--with-content] [--root <dir>]` shall show a session report, taking the first argument not starting with "--" as the session ID; a missing ID or an empty run ID fails with the usage, and other arguments, apart from those of CLI-005 and CLI-025, with "unknown option: <arg> (usage: …)".
- **CLI-054** `trace`, `replay` and `session list` shall read the sessions under the project's `.pigeon/state/sessions/` and need no model configuration (see SESSIONS-011).
- **CLI-055** An unknown session shall fail with "session not found: <id>; sessions: <ids>" (or " (no sessions yet)"); a session whose file format is not recognised with "session <id> is an old-format session; …"; an unknown run in trace with "run not found in this session: <run>; runs: <runs>".
- **CLI-056** The trace report shall start with "session <id> | <n> run(s) | <n> tool call(s)", plus " | <n> unfinished run(s) (possible crash)" when a run has no end, and, for a branch session, a "branch session: from session …" line; then, per run, a header with stop reason and badge, a `start:` line (model, effort, approval mode, tools, memory, skills, prompt hash, requests), lines for tools not registered, MCP toolset conflicts and MCP servers not connected or that sent list changes, an `ended:` line when the run ended, its verification, hook, continuation, repetition, prune, request retry, approval mode change, effort change and agent message entries, per turn the time, stop reason and token usage with each tool call's arguments, result and class, plus its approval, error kind and checkpoint when recorded, and, with `--with-content`, its message text; session-level hook, approval mode change, effort change and agent message entries follow under "session entries:", and read warnings under "anomalies:".
- **CLI-057** Trace and replay shall write the approval mode with its recorded values "prompt" and "yolo", on run start lines and on mode-change lines alike (such as "prompt -> yolo").
- **CLI-058** Trace and replay shall shorten session, run and grant IDs to their prefix and the first 8 characters of the ULID followed by "…" (such as "sess_01HX2ABC…"), except the source session of a branch session in trace, which is shown in full; tool call IDs are shown in full, and arguments over 160 characters are cut with "… (<n> chars)".
- **CLI-059** `--with-content` shall add message text and thinking to trace and replay, images folded to a count; without it no message text is shown.
- **CLI-060** `pigeon replay <run ID> [--session <id>] [--with-content] [--root <dir>]` shall find the run across sessions, failing with "run not found: <run>; runs: …" (or "run not found: <run> (no sessions yet)" when no session has a run), or "run <run> is in more than one session: …; pick one with --session" when ambiguous; with `--session`, an unknown or old-format session fails as in CLI-055, and a run missing there fails with "run not found in this session: <run>; runs: …" (or " (no runs in this session)"); a missing run ID or an empty session ID fails with the usage, and other arguments, apart from those of CLI-005 and CLI-025, with "unknown option: <arg> (usage: …)".
- **CLI-061** The replay report shall start "replay run <id> | session <id> | <n> entries | end: …" and list one line per recorded entry in file order with its UTC time, showing snapshot marks only when the snapshot failed or was interrupted; it never re-executes anything.
- **CLI-062** `pigeon session list` shall accept `--tool <name>`, `--class cancelled|business|infrastructure|unknown`, `--since` and `--until` (ISO date or epoch milliseconds) and `--root`, each with a specific error for a bad value.
- **CLI-063** `pigeon session list` shall print one line per session, oldest first, in UTC: "YYYY-MM-DD HH:MM  <name>  <n> run(s)  <session ID>" plus "  <n> tokens" in short form (such as "12.3k") when it used any, or "no sessions"; sessions never started are left out (see SESSIONS-010), and sessions whose file format is not recognised are counted on a final line "<n> old-format session(s) not listed; …".

## Maintenance commands

- **CLI-064** `pigeon sandbox` subcommands and usage error: see SANDBOX-078.
- **CLI-065** `pigeon worktrees list | clean` and its scope: see WORKTREES-064.
- **CLI-066** `pigeon migrate-config [--root <project root>]` shall check every step first and change nothing when one is blocked ("migration blocked:" with the reasons), print "nothing to migrate" when there is nothing to do, otherwise print each step's results and where moved files were backed up; it can be run repeatedly.

## Terminal UI process

- **CLI-067** The terminal UI shall exit with 0 on a normal exit ("/quit", double "Ctrl+C", SIGINT, SIGTERM) and with 1 when start-up fails or after an uncaught error, restoring the terminal first.
- **CLI-068** Notices raised before the terminal UI takes the screen — the `--continue` fallback note, worktree notices, sandbox alerts, agent type problems, problems restoring a resumed session's sub-agents, MCP notes, work list update failures and the line of SETTINGS-038 — shall be shown in the message area once it starts, and any never shown are written to standard error at exit; sandbox progress lines and warnings raised before then go to standard error directly.
- **CLI-069** The hand-back line printed when a sandbox session in the terminal UI ends: see SANDBOX-057.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `agents.runWaitMinutes` | `10` | How long `pigeon run` waits for subagents. |
| `stopHookBlockCap` | `8` | Stop-hook blocks before `stop-hook-limit`. |
| `trustedDirectories` | `[]` | Projects inside need no `--trust-config`. |

Run-only options: `--json`, `--max-turns <N>`, `--wall-clock <ms>`, `--governance-root <dir>`, `--trust-config`, `--edit-mode`. Terminal-UI-only: `--continue`, `--resume [id]`, `--worktree <name>`, `--history-limit <n>`.

## Known limitations

- No command-line option sets a token budget; status `token-limit` (exit code 7) does not occur in `pigeon run`.
- `pigeon run` without a task on an interactive terminal waits for end of input without a prompt.
- The top-level help lists no options.
- `pigeon worktrees` has no `--root`.
- Error text on standard error is not sanitised.
