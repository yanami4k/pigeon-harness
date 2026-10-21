# Subagents

Purpose: how an agent starts other agents to work for it — the tools the model uses, agent
types, limits on concurrency and nesting, how messages and results travel between agents,
how the user watches and steers subagents in the terminal UI (the subagent panel and
subagent views), and how `pigeon run` waits for them.

## Availability

- **SUBAGENTS-001** When subagents are available, Pigeon shall give each agent the tools `spawn_agent`, `send_message`, `list_agents`, `stop_agent` and `take_changes`, less those left out by its nesting depth or a read-only type (SUBAGENTS-005) or by its type's `tools` list (SUBAGENTS-022).
- **SUBAGENTS-002** Approval needs of the subagent tools: see APPROVALS-012.
- **SUBAGENTS-003** With `--no-subagents` (terminal UI or `pigeon run`), Pigeon shall register none of these tools and show no subagent panel.
- **SUBAGENTS-004** Sandbox sessions, in the terminal UI and in `pigeon run --sandbox`, shall offer none of these tools and no subagent panel.
- **SUBAGENTS-005** `spawn_agent` shall not be offered to an agent at the maximum nesting depth or to an agent of a read-only type, and `take_changes` shall not be offered to an agent of a read-only type.
- **SUBAGENTS-006** The `spawn_agent` description shall list every available agent type as "- <name>: <description>".

## Spawning

- **SUBAGENTS-007** `spawn_agent` shall take `task` (required) and optional `type` (default `general`), `name`, `model`, `background` (default true), `inherit_context` (default false) and `worktree` (default false).
- **SUBAGENTS-008** An unknown `type` shall fail with "unknown agent type <type>. Available types: <list>."; a blank `task` shall fail with "task is empty."
- **SUBAGENTS-009** A given name shall be 1–40 letters, digits, hyphens or underscores starting with a letter or digit; otherwise `spawn_agent` fails with "name must be 1-40 letters, digits, hyphens or underscores, starting with a letter or digit."
- **SUBAGENTS-010** Without a name, Pigeon shall name the subagent "<type>-<n>", where n counts up from 1 per type across the process and skips names already taken; a given name already taken in the process (by a subagent, or as a session's full session ID) becomes "<name>-2", "<name>-3", …, the first one free, with <name> cut short to keep the whole within 40 characters.
- **SUBAGENTS-011** Subagent names shall be unique across the whole process.
- **SUBAGENTS-012** A successful background spawn shall return "Started <name> (<type>) in the background." followed by the advice that the final reply will arrive as a message, not to wait or poll, and to use `send_message` or `stop_agent`.
- **SUBAGENTS-013** With `background: false`, the call shall wait until the subagent stops and return its result as the tool result, without a separate message.
- **SUBAGENTS-014** When a foreground `spawn_agent` call is aborted, Pigeon shall stop the subagent too.
- **SUBAGENTS-015** The subagent's model shall be the `model` argument if given, else its type's model, else the spawning agent's model.
- **SUBAGENTS-016** A subagent shall start with an empty conversation whose first input is the task; with `inherit_context` it starts with a copy of the spawner's conversation up to, not including, the reply that made the call.
- **SUBAGENTS-017** A subagent's system prompt shall end with its type's extra prompt, if any, and a block stating "You are a sub-agent named <name>, started by <parent>." and that its final reply is sent to the parent in full; a session parent is written "session <full session ID> (<session name>)".
- **SUBAGENTS-018** With `worktree: true` in a project that is not a git repository, `spawn_agent` shall fail at once with the tool error "a worktree needs this session's project to be a git repository; <working directory> is not in one" and start no subagent (see WORKTREES-066).

## Types

- **SUBAGENTS-019** Pigeon shall provide two built-in types: `general`, with the spawner's tools except `update_tasks`, `list_tasks`, `enter_worktree` and `update_memory`, and `explore`, which gets only the reading and network tools: it can read and search files and the web but cannot change files or run commands.
- **SUBAGENTS-020** Pigeon shall read custom types from `.pigeon/agents/*.md` in the project and `~/.pigeon/agents/*.md`, one type per Markdown file.
- **SUBAGENTS-021** A type file shall start with a `---` front-matter block with required `name` (lowercase letters, digits and hyphens, starting with a letter, at most 40 characters) and `description`, and optional `tools` and `model`; the body after the block is appended to the subagent's system prompt, and the type is registered under its `name` whatever the file is called.
- **SUBAGENTS-022** `tools` shall accept a comma-separated list, a `[a, b]` list or one `- a` item per line; the subagent then gets only those of the spawner's tools, unknown names ignored; without `tools` it gets the general set.
- **SUBAGENTS-023** A `model` of `inherit` or empty shall mean the spawner's model.
- **SUBAGENTS-024** A project type shall override a user type of the same name, and a custom type a built-in one; built-in types are listed first, then custom types by name.
- **SUBAGENTS-025** A type file that cannot be read, lacks front matter, `name` or `description`, has an invalid name, or repeats a name in the same folder shall not be registered, and Pigeon shall report "[agents] <path>: <reason>" — as an alert in the terminal UI at startup, on standard error in `pigeon run`.
- **SUBAGENTS-026** Types shall be read when a project is first opened in the process and again on "/reload"; sessions of another project use that project's types.

## Limits

- **SUBAGENTS-027** Pigeon shall count running subagents per session across all levels below it; at `agents.maxConcurrent` running, `spawn_agent` fails with "concurrent sub-agent limit reached (<N> running). Wait for one to finish or stop one, then try again." and nothing is queued.
- **SUBAGENTS-028** A subagent being compacted shall count as running.
- **SUBAGENTS-029** Subagents shall nest at most `agents.maxDepth` levels below a session; a deeper spawn fails with "sub-agents can be nested at most <N> levels deep; this one can't start more."
- **SUBAGENTS-030** Waking a stopped subagent shall also respect the limit: a message is refused with "concurrent sub-agent limit reached (<N> running); <name> can't start now. Try again when one finishes.", and a finished background job's notice or a result from one of its subagents waits until fewer than `agents.maxConcurrent` subagents are running.

## Messages

- **SUBAGENTS-031** `send_message` shall address a subagent by name and a session by its full session ID, with no prefix matching; subagent names are looked up first.
- **SUBAGENTS-032** An unknown target shall fail with "no sub-agent named <to> and no session with that full session ID. Known: <list>."; a message to oneself fails with "can't send a message to yourself."; success returns "Sent to <to>."
- **SUBAGENTS-033** A message to a running agent shall be delivered when its current turn ends; a message to a subagent that is not running (done, failed, stopped or interrupted) makes it work again, unless its start failed (SUBAGENTS-034) or the limit of SUBAGENTS-030 refuses the message.
- **SUBAGENTS-034** A subagent whose start failed shall be unreachable: messages to it fail with "<name> can't be reached."
- **SUBAGENTS-035** Pigeon shall refuse a message that is blank ("message is empty; not sent"), longer than 100,000 characters ("message is too long; not sent"), identical to one the same sender sent the same recipient in the last 60 seconds ("the same message was just sent to <to>; not sent again"), beyond 10 per minute from one sender to one recipient ("too many messages to <to> in the last minute; not sent"), or addressed to a recipient with 50 or more unread notices ("<to> has too many unread messages; not sent").
- **SUBAGENTS-036** Every message between agents (task, message or result) shall carry a header "[Agent task|message|result] From <sender> (<relation>)." and a fixed sentence saying it was written by another agent, not the user, with the body between unique begin and end markers.
- **SUBAGENTS-037** The relation shall be one of "a sub-agent you started", "the agent that started you", "an agent above the one that started you", "a sub-agent below the ones you started", "another agent in your session" or "an agent in another session".
- **SUBAGENTS-038** A task shall end with "To message it, use send_message to <address>." and a message with "To reply, use send_message to <address>.", the address being a subagent's name or a session's full session ID.
- **SUBAGENTS-039** A line in a relayed body that reads as a begin or end marker ("<<<BEGIN AGENT-MESSAGE …" or "<<<END AGENT-MESSAGE …", also when written with full-width or zero-width characters) shall be prefixed with "(escaped) ".
- **SUBAGENTS-040** Text the user types in a subagent's view shall count as the user's own words: it is sent without the agent-message header, markers or record.
- **SUBAGENTS-041** Each relayed message shall be recorded in the recipient's session with sender, recipient, kind and text.
- **SUBAGENTS-042** How agent-to-agent messages show in history, and that they are not rewind points: see RENDERING-063, SESSIONS-055.
- **SUBAGENTS-043** `list_agents` shall list every session in the process as "<name>: session <full session ID>" and every subagent as "<name>: <type>, <state>, started by <parent>", with "<name> (shown as <display name>)" for renamed ones and "No agents." when there are none. The state shall be one of `starting`, `running`, `idle`, `failed`, `stopped` or `interrupted`, and a session parent is written "session <full session ID> (<session name>)".

## Results

- **SUBAGENTS-044** When a subagent stops, Pigeon shall, except as SUBAGENTS-048 says, return its last reply in full ("(no reply)" when empty) to its parent after a status line "<name> finished.", "<name> failed: <reason>" or "<name> was stopped before it finished."
- **SUBAGENTS-045** A background subagent's result shall arrive as a message in the parent's next turn; a parent that is idle, failed or interrupted is woken to handle it (a parent subagent within the limit of SUBAGENTS-030, and after its compaction when it is compacting), and a stopped parent is not (see SUBAGENTS-051, PANEL-047).
- **SUBAGENTS-046** Where a subagent's untaken worktree changes are reported: see WORKTREES-067.
- **SUBAGENTS-047** When the loop guard stops a subagent, its result shall start "<name> failed: stuck in a loop: the same tool calls and results repeated for <N> consecutive rounds, so it was stopped. Repeated calls: <calls>".
- **SUBAGENTS-048** A background subagent named in a `stop_agent` call, closed with its session, stopped because the program closes, or stopped when `pigeon run` stops waiting for it (SUBAGENTS-082) shall return no result; one stopped by the user in the UI, or stopped because a subagent above it was stopped, returns "<name> was stopped before it finished."

## Stopping

- **SUBAGENTS-049** `stop_agent` shall stop only a subagent the caller started, directly or further down, together with all subagents below it; otherwise it fails with "you can only stop sub-agents you started (or theirs)."; unknown names fail with "no sub-agent named <name>."; success returns "Stopped <name>."
- **SUBAGENTS-050** When the named subagent is not running, `stop_agent` shall still stop the subagents below it and reply "<name> isn't running." followed by the names of those it stopped; with none below it running, it replies "<name> isn't running." and changes nothing.
- **SUBAGENTS-051** A stopped subagent shall stay stopped until it receives a message; neither its own background jobs finishing nor the results of subagents below it that were stopped with it wake it, and those results wait for its next turn (see APPROVALS-048).
- **SUBAGENTS-052** The line left when a stopped subagent's approval is withdrawn: see APPROVALS-048.

## Permissions

- **SUBAGENTS-053** A subagent's approval mode and starting grants: see APPROVALS-008, APPROVALS-092.
- **SUBAGENTS-054** A subagent's approval request (source line, allow keys, grant scope): see APPROVALS-022.
- **SUBAGENTS-055** A subagent's approval in the main view and in its own view: see APPROVALS-042, SUBAGENTS-061.
- **SUBAGENTS-056** Subagent calls that need approval in `pigeon run`: see APPROVALS-015.
- **SUBAGENTS-057** A subagent shall take no file checkpoints (see MEMORY-020, WORKTREES-029, TOOLS-090).
- **SUBAGENTS-058** A subagent shall reuse its spawner's MCP connections and web settings; MCP problems already reported are not reported again.
- **SUBAGENTS-059** Hook and MCP notices from a subagent shall be prefixed "[<path>] " (in the message area, or on standard error in `pigeon run`); a loop-guard stop of a subagent produces no notice and is reported in its result (SUBAGENTS-047).

## Panel and views

- **SUBAGENTS-060** The subagent panel shall sit below the input box in the main view and in subagent views, list the current session's subagents one level at a time with `main` as the first row at the top level, and take no space when there is nothing to list.
- **SUBAGENTS-061** Each row shall show the name (or display name), the type and a state — `starting`, `running`, `done`, `failed: <reason>`, `stopped`, `interrupted`, `compacting` or `waiting for approval` — plus "(+N)" when N rows are listable below it; the agent being viewed is bold and, while the panel is focused, the selected row starts with "› ".
- **SUBAGENTS-062** When drilled into a lower level, the panel's first line shall show the path back ("<session name> › <path>").
- **SUBAGENTS-063** The row being viewed and rows with listable rows below them shall always stay listed; running, starting and compacting rows stay listed, interrupted rows stay until hidden with "x", and done, failed and stopped rows stay 30 seconds after their last change unless hidden with "x" sooner.
- **SUBAGENTS-064** With the input empty, "↓" shall focus the panel; there "↑"/"↓" select ("↑" on the first row returns to the input), "→" enters a row's lower level, "←" goes up (at the top, back to the input), "Esc" returns to the input, and while no approval is shown any other key except "Ctrl+C" and the scrolling and search keys (VIEWS-057) returns to the input and is typed there; once the panel has no rows left, any such key returns to the input. The quit question (SUBAGENTS-075), the worktree clean question and a waiting "/memory edit" save (MEMORY-052) take their keys before the panel.
- **SUBAGENTS-065** "Enter" on a subagent row shall switch to its view (also from another subagent's view), "Enter" on `main` returns to the main view, and focus stays on that row.
- **SUBAGENTS-066** "x" or "X" on a running, starting or compacting row shall stop that subagent with everything below it, or only interrupt its compaction when it is compacting; on any other subagent row it hides that row until it changes again, except that the row being viewed and a row with listable rows below it stay, and on `main` it does nothing (see APPROVALS-046).
- **SUBAGENTS-067** Opening a subagent's view shall replace the message area with its conversation — the history from its session record and "--- live ---" (both absent while it has no record yet), then its live output; the view has no title row, and its status line reads "sub-agent: <name> <state>" (the display name when renamed; the state as in the panel, without a failure reason or "waiting for approval").
- **SUBAGENTS-068** Text typed in a subagent's view shall go to that subagent (after its current turn, or waking it); when it cannot be delivered Pigeon shows "<name> is gone", "<name> can't be reached" or "concurrent sub-agent limit reached (<N> running)" and keeps the text in the input.
- **SUBAGENTS-069** "Esc" in a subagent's view shall stop that subagent while it is running, starting or compacting, as "x" does on such a row (SUBAGENTS-066), without leaving the view, and otherwise do nothing; while the subagent panel is focused (SUBAGENTS-064), the completion list or the find box is open, an approval is shown (APPROVALS-046), the quit question (SUBAGENTS-075) or the worktree clean question is pending, or a "/memory edit" save is waiting (MEMORY-052), "Esc" acts there instead; double "Esc" does not open the rewind list there.
- **SUBAGENTS-070** In a subagent's view, "/clear", "/rewind", "/fork" and "/take" shall be refused with "/<name> only works in the main agent's view", the text staying in the input; "/status", "/compact", "/rename", "/effort", "/tasks", "/hooks", "/grants", "/revoke" and "/grants save" act on that subagent; "/quit", "/resume", "/new", "/memory", "/memory edit", "/reload", "/worktrees", "/config" and "/panel" work as in the main view, their lines shown in the subagent's view; a sandbox session runs no subagents, and in a subagent's view "/deliver" is an unknown command.
- **SUBAGENTS-071** For a subagent not open right now — restored from a resumed session and not yet reopened, still starting, or whose start failed — "/rename", "/effort", "/tasks", "/hooks" and "/grants" in its view, and "/compact", "/revoke" and "/grants save" while it is not starting (otherwise SUBAGENTS-085), shall reply "<name> isn't open right now" (the display name when renamed) and keep the text in the input.
- **SUBAGENTS-072** "/rename <name>" in a subagent's view shall change only its display name (letters, digits, `_`, `-`, `.`, at most 40), reply "renamed to <name>", survive resume, and keep the original name as its address.
- **SUBAGENTS-073** "/compact" in a subagent's view shall run only while that subagent is not working (SUBAGENTS-085); messages arriving meanwhile wait until compaction ends.
- **SUBAGENTS-074** "/status" in a subagent's view shall show `agent` ("<display name> (<name>) · <type> · <state>", or "<name> · <type> · <state>" when not renamed), `session` ("<session name> · <full session ID>" of its top-level session), `cwd`, `record`, `model` ("<model> · effort <level>") and `usage`. For a subagent not open right now (SUBAGENTS-071) it shall show what its record holds: no `record` line, `model` reads "—" with no effort, and `usage` shows only its tokens.
- **SUBAGENTS-085** In a subagent's view, "/compact", "/revoke" and "/grants save" shall be refused with "can't use /<command> while running" while that subagent is running, starting or compacting, and "/memory edit" and "/reload" while the current session's turn is running (for "/config" see SETTINGS-069); the text stays in the input.

## Quitting and busy sessions

- **SUBAGENTS-075** When the user quits ("Ctrl+C" twice or "/quit") while any subagent in the process is running, starting or compacting, the status line shall ask "sub-agents are still running; exit anyway? (y/n)" instead of exiting; "y", "Y", "Enter" or "Ctrl+C" twice more exits, any other key except the scrolling and search keys (VIEWS-057) cancels, and the question takes keys before a pending approval.
- **SUBAGENTS-076** Commands and tools refused while the current session has running subagents: see SETTINGS-052, SETTINGS-069, WORKTREES-033.

## Records, resume and tokens

- **SUBAGENTS-077** Each subagent shall have its own session record, stored in a `subagents` folder under its top-level session's ID next to that session's record, naming its parent, name, type and path (see SESSIONS-013, MEMORY-063).
- **SUBAGENTS-078** When a session is resumed in the terminal UI, Pigeon shall restore its subagents: those whose last run had not finished show `interrupted`, the others are idle (`done` in the panel); a taken name gets a suffix, a subagent whose type is not among the available types gets `general`, and a message to a restored subagent reopens its session (see WORKTREES-069).
- **SUBAGENTS-079** Subagents in the status bar's token count: see SESSIONS-079.
- **SUBAGENTS-080** When a session is closed — switched away from while neither it nor its subagents are working, removed from the session panel, or Pigeon exiting — its subagents shall be stopped without returning results (see WORKTREES-068).

## pigeon run

- **SUBAGENTS-081** In `pigeon run`, when the main agent's run completes (not failed, aborted or stopped by a limit) while subagents are still working (running, or with background jobs not yet finished), the run shall wait, hand their results and messages to the main agent to continue, and, except as SUBAGENTS-082 and SUBAGENTS-083 say, end only when no subagent is working and the main agent has stopped.
- **SUBAGENTS-082** When one continuous wait exceeds `agents.runWaitMinutes` (0 means no limit), Pigeon shall stop the remaining subagents, drop their results, write "stopped <N> sub-agents after waiting <wait>" ("sub-agent" when N is 1; the wait as "<M> min" from one minute on, otherwise "<S> s") to standard error, and finish the run normally.
- **SUBAGENTS-083** When the run's own limit (turns, wall clock, tokens, loop guard) or an abort hits while waiting, the run shall end with that limit's status and its subagents are stopped.
- **SUBAGENTS-084** Turns, tool calls and usage in the `pigeon run` result shall count only the main agent's session; kept background jobs include those of subagents.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `agents.maxConcurrent` | `20` | Subagents working at once per session, all levels included. |
| `agents.maxDepth` | `3` | Nesting levels below a session. |
| `agents.runWaitMinutes` | `10` | `pigeon run`: longest continuous wait for subagents; `0` = no limit. |
| `stopHookBlockCap` | `8` | Extra turns `SubagentStop` hooks may force (see Hooks). |

Flag: `--no-subagents`. Type files: `.pigeon/agents/*.md`, `~/.pigeon/agents/*.md`.

## Known limitations

- Problems in type files are reported only for the project opened at startup; problems found on "/reload" or in another project are not shown.
- A custom type that overrides `explore` is not read-only unless its `tools` list makes it so.
- On exit Pigeon waits at most 5 seconds for subagents to finish their turn and at most 5 more for them to close; closing the terminal skips the quit question.
- A read-only `explore` subagent still has `send_message`, `list_agents` and `stop_agent`.
- A custom type that lists tools must list `spawn_agent` to spawn and `send_message` to message; results are returned regardless.
- Project type files take effect without confirmation; they can only narrow, never widen, the spawner's tools.
- Changes a subagent makes to files cannot be rewound.
