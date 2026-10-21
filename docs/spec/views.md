# Views

Purpose: the terminal UI's common furniture — the main view's layout; the status bar, status
line and spinner; thinking effort; "/status"; slash commands in general; quitting and
cancelling; the input box, queue and history; scrolling and search; and the key table.

## Layout and views

- **VIEWS-001** In the main view the terminal UI shall run full-screen with the message area on top and, at the bottom from top to bottom: the spinner when busy, queued input, the approval area, a blank line, the status line, the input box, the subagent panel when it has rows (see SUBAGENTS-060), and the status bar.
- **VIEWS-002** The main view shall have no title line (see SUBAGENTS-067 for subagent views and PANEL-068 for the read-only view).
- **VIEWS-003** When a subagent view cannot render the agent's history, it shall show "rendering history failed: <message>" in place of the history and the "--- live ---" line (see SUBAGENTS-067).
- **VIEWS-004** Status line of a subagent view: see SUBAGENTS-067.
- **VIEWS-005** Opening the session panel with a double "Left": see PANEL-003, PANEL-004.
- **VIEWS-006** Input in the read-only view: see PANEL-069, PANEL-072 and APPROVALS-005 ("Alt+T" there: VIEWS-023).
- **VIEWS-007** The read-only view following the other session's record: see PANEL-070.
- **VIEWS-008** The status line in the read-only view of a session open elsewhere: see PANEL-076.
- **VIEWS-009** Expanding and collapsing tool output with "Ctrl+O": see RENDERING-037, RENDERING-038.

## Status bar

- **VIEWS-010** The status bar shall be one line at the bottom of every view, below the input box where there is one, reading "<mode> · effort <level> · ctx <P>% (<used>/<window>) · <N> tokens" and leaving out segments without data; the separators, the context segment and the token count are dim.
- **VIEWS-011** The mode segment shall read "ask" in cyan or "bypass" in orange (256-colour 208); without an approval mode it is omitted.
- **VIEWS-060** The effort segment shall be in the normal foreground colour for `off`, green for `low` and `minimal`, yellow for `medium`, magenta for `high`, and red for `xhigh` and `max`.
- **VIEWS-061** A mode or effort segment cut short by the width shall stay dim without its colour; subagent and read-only views colour their status bar the same way, and the `mode` line of "/status" carries no colour.
- **VIEWS-012** The context segment shall show the context use (see CONTEXT-044, CONTEXT-007) as a rounded percentage, at most 999, with compact counts such as "46k/200k", and is omitted when the context window is unknown.
- **VIEWS-013** Token count on the status bar: see SESSIONS-079 and SESSIONS-080.
- **VIEWS-014** When the full text does not fit, the status bar shall switch the context and token segments to the short forms "ctx <P>%" and "<N>", then cut at the width without wrapping.
- **VIEWS-015** The status bar shall describe the agent being viewed: in a subagent view the session's approval mode with that subagent's effort, context and tokens; in the read-only view see PANEL-071; in every other view the current session's main agent.

## Status line and spinner

- **VIEWS-016** In the main, settings and resume views the status line, just above the input box (or the status bar), shall show only the current session's state word — "resuming", "cancelling" or "running" (also while compacting, reloading or applying a settings change) — and be blank otherwise; see PANEL-017 for the panel, SUBAGENTS-067 for a subagent view and APPROVALS-027 while an approval is shown.
- **VIEWS-017** In every view with a status line, temporary prompts shall replace its text in this order of precedence: the quit-with-subagents question (see SUBAGENTS-075), "press Ctrl+C again to exit", the worktree clean question "remove these worktrees? [y/N]" (not while an approval is shown), and "press Left again to open the panel".
- **VIEWS-018** Pigeon shall show an ASCII spinner ("-", "\", "|", "/", 120 ms a frame, no text) in the main view from sending a message, or from a pending notification starting a turn, until the work fully settles — model output, tools, waiting for subagents, stop-hook turns — and while "/compact", "/reload" or a settings change is applied.
- **VIEWS-019** The spinner shall hide while the view shows an approval and return after; in a subagent view it follows that subagent's work (starting, running, compacting); the panel, read-only, settings, resume and rewind views show none.

## Approval mode

- **VIEWS-020** Switching the approval mode with "Shift+Tab": see APPROVALS-003, APPROVALS-004, APPROVALS-005.

## Thinking effort

- **VIEWS-021** "/effort <level>" shall accept `off`, `minimal`, `low`, `medium`, `high` and `xhigh` for the agent being viewed, replying "effort set to <level> (from the next request)", "effort is already <level>", "unknown effort level: <value> (use off, minimal, low, medium, high, xhigh)" (also for `max`), or "this model doesn't support reasoning; effort stays off".
- **VIEWS-022** "/effort" without an argument shall put "/effort " in the input and list the levels below it with the current one marked "current"; choosing one switches.
- **VIEWS-023** "Alt+T" shall cycle the viewed agent's effort off → low → medium → high → xhigh → off (`minimal` goes to `low`, `max` to `off`) and update the status bar; it does nothing for a model known not to reason or in the read-only view (see APPROVALS-038 while an approval is shown).
- **VIEWS-024** In a subagent view, "Alt+T" shall change only that subagent's effort and do nothing for a subagent that isn't open right now (see SUBAGENTS-070, SUBAGENTS-071).
- **VIEWS-025** A switch shall apply from the next model request, also within a running turn, and be recorded in the session; switching to the current level records nothing.
- **VIEWS-026** A session that never switched shall use `--thinking <level>`, else `thinking.level`, else `high` for a model known to reason and `off` otherwise.
- **VIEWS-027** On resume the effort shall be restored from the last switch on the session's current branch, overriding the flag and setting, and it is kept when the session is reloaded; a "/fork" session starts with the source session's effort (see SESSIONS-076), and other new sessions use the order of VIEWS-026.
- **VIEWS-028** For a model known not to reason, effort shall stay `off` whatever the flag, setting or switch; when support is unknown the default is `off` but switching is allowed.

## /status

- **VIEWS-029** "/status" shall be read-only, work while running, and print aligned lines `session`, `project`, `cwd`, `record` (when the record file is known), `settings`, `git`, `sandbox`, `agents`, `usage` and `mode`; in a subagent view see SUBAGENTS-074.
- **VIEWS-030** `session` shall read "<session ID> · <name> · <idle|running>"; `project` the root with the home directory as `~`; `cwd` "= project" when equal, else relative to the project (or repository, in a worktree), else the path with the home directory as `~`.
- **VIEWS-031** `settings` shall list "user <path> · project <path> · local <path>" with "—" for absent files; `git` "<branch> · clean|dirty" (short commit when detached) or "not a git repository"; `sandbox` "off" or "<image> · network <on|off> · approval <ask|bypass>" with the sandbox image's name; `agents` "none" or "<N> running".
- **VIEWS-032** `usage` shall show the status bar's figures in full form ("ctx <P>% (<used>/<window>) · <N> tokens", only the tokens when the window is unknown), and `mode` shall read "<ask|bypass> · effort <level> · model <model> · <provider>", with the model as in the welcome header and left out for a placeholder model.
- **VIEWS-033** "/status" in a subagent view: see SUBAGENTS-074.

## Slash commands

- **VIEWS-034** Pigeon shall provide "/quit", "/compact [focus]", "/resume [session ID]", "/clear", "/new [path]", "/status", "/grants", "/revoke <id>", "/grants save <id>", "/fork", "/take [session ID]", "/tasks", "/hooks", "/memory", "/memory edit project|user", "/reload [confirm|skip]", "/worktrees", "/config [key=value]", "/rewind", "/panel", "/rename <name>", "/effort [level]" and, in a sandbox session, "/deliver"; in a sandbox session "/fork", "/take", "/resume", "/new", "/clear", "/worktrees" and "/panel" are unavailable.
- **VIEWS-035** Outside the read-only view (see PANEL-069), an unknown command shall be answered only with "unknown command: /<word>", where <word> is the first word after "/".
- **VIEWS-036** Typing "/" at the start of the input shall list one entry per command word with the usage of its first form ("/grants save" and "/memory edit" appear under "/grants" and "/memory"), listing "/deliver" only in a sandbox session; "Tab" or "Enter" applies the selection, and commands are run by Pigeon, never sent to the model.
- **VIEWS-037** A slash command shall be echoed (see RENDERING-052) before it is handled, also when it turns out unknown or misused; a command refused before it runs — while busy (VIEWS-038), in a subagent view as main-only or for a subagent that isn't open right now, or in the read-only view — is not echoed, only the refusal shown.
- **VIEWS-038** While the current session is busy — a turn, compaction, reload, settings change, resume or rewind in progress — Pigeon shall not queue slash commands: "/quit", "/status", "/tasks", "/effort" and unknown commands run at once, and each other command runs or is refused as its own rule states, a refusal reading "can't use /<command> while running" with the text left in the input box (see CONTEXT-022, SESSIONS-030, SESSIONS-043, SESSIONS-053, SESSIONS-054, SESSIONS-078, APPROVALS-067, HOOKS-078, MEMORY-046, WORKTREES-063, WORKTREES-078, PANEL-001, SANDBOX-059, SETTINGS-052, SETTINGS-069); in a subagent view, commands acting on that subagent are judged by whether it is working and the other commands by whether the current session is busy.
- **VIEWS-039** Slash commands submitted in the session panel: see PANEL-023.

## Quitting and cancelling

- **VIEWS-040** While the current session runs, "Esc" in the main view shall interrupt the turn once, show "cancelling" and move queued input back to the input box (see RENDERING-056 for the closing line); a failed interrupt shows "[cancel] interrupt failed: <message>".
- **VIEWS-041** "Esc" shall first close what is open — search, the completion list, the rejection reason, a "/memory edit" save waiting in line, the focused subagent panel — before it interrupts (see APPROVALS-046 while an approval is shown).
- **VIEWS-042** Opening the rewind list with a double "Esc": see SESSIONS-054.
- **VIEWS-043** A single "Ctrl+C" without a mouse selection shall clear the input without sending and show "press Ctrl+C again to exit" in the status line for 1 second or until another key; with an approval shown it clears nothing and shows no hint but still counts as the first press.
- **VIEWS-044** With no subagent working, a second "Ctrl+C" within that second, or "/quit", shall exit once: the UI stops, then the program exits; with subagents working it first asks (see SUBAGENTS-075), and pending approvals are rejected (see APPROVALS-040).
- **VIEWS-045** "Ctrl+C" with a mouse selection shall copy the selection instead.
- **VIEWS-046** Leaving full screen to open an external editor for "/memory edit" shall print nothing to the normal screen (see RENDERING-068 for the printout on exit).

## Input

- **VIEWS-047** Empty or blank input shall be ignored on "Enter".
- **VIEWS-048** The input box shall be multi-line: "Enter" sends; "Shift+Enter", "Ctrl+J", "Alt+Enter" or a trailing backslash before "Enter" inserts a newline; pastes keep their newlines and a large paste shows as a "[paste #n …]" marker, expanded when sent.
- **VIEWS-049** "Tab" shall complete a path relative to the current session's workspace and do nothing when the cursor is at the start of a line or right after a space, quote or "="; after "/take " or "/effort " it lists that command's choices; "@<name>" completes file paths when the `fd` program is available; completion only edits the text.
- **VIEWS-050** Messages sent in the main view while the current session is busy shall be queued, shown as "queued: <first line>" (cut at 80 characters with "...", and " ..." added when there are more lines), and sent one at a time once idle; nothing queued is sent while the resume, settings or rewind view is open.
- **VIEWS-051** In the main view, "Alt+Up" or "Alt+Q" shall move all queued input back into the input box ahead of the draft.
- **VIEWS-052** "Up"/"Down" shall browse prompt history, kept per project across launches in `.pigeon/state/tui-history.json` (at most 100 entries, consecutive duplicates once); a slash command typed while that `.pigeon/state` directory does not exist is kept for the current launch only; rejection reasons and main-only commands refused in a subagent view are not recorded, while commands refused during a run are (see PANEL-069 for the read-only view).
- **VIEWS-053** Prompt history shall be read from and recorded in the current session's project, and the welcome header shall show the current session's directory, both following a switch to a session in another project or directory (see RENDERING-058).
- **VIEWS-054** On Windows a right-click shall paste the clipboard into the input box (see APPROVALS-038 while an approval is shown).

## Welcome header

- **VIEWS-055** The welcome header: see RENDERING-058.

## Scrolling and search

- **VIEWS-056** The mouse wheel shall scroll the message area by `tui.wheelScrollLines` lines (default 3, 1–20), re-applied after "/config", "/reload" or switching to a session in another project.
- **VIEWS-057** "PageUp"/"PageDown" shall page the message area, "Ctrl+Home"/"Ctrl+End" jump to the oldest and newest content, and "Home"/"End" stay with the input box; these keys, "Ctrl+Up"/"Ctrl+Down", the mouse wheel (VIEWS-056) and "Ctrl+Shift+F"/"F3" (VIEWS-058) — the scrolling and search keys — are taken by the message area before any view, panel, question or the input box sees them.
- **VIEWS-058** Pigeon shall open search over the message area on "Ctrl+Shift+F" or "F3"; while it is open the search box shall take every key except "Ctrl+C" and the scrolling keys of VIEWS-056 and VIEWS-057, and while the quit-with-subagents question is waiting, the other keys go to the question except "Enter"/"Ctrl+G" (next), "Shift+Enter"/"Ctrl+Shift+G" (previous) and "Esc" (closes), which stay with the search box; closing it shall not cancel a turn.
- **VIEWS-059** Navigation keys while an approval is shown: see APPROVALS-046.

## Key table

Rebindable Pigeon actions (`keybindings.<action>`):

| Action | Default | Effect |
| --- | --- | --- |
| `pigeon.cancel` | `escape` | Interrupt the turn; twice when idle opens the rewind list. |
| `pigeon.exit` | `ctrl+c` | Copy selection, or clear input; twice exits. |
| `pigeon.toggleToolOutput` | `ctrl+o` | Expand or collapse tool output. |
| `pigeon.tree` | `ctrl+x` | Stop the selected panel session; twice removes it. |
| `pigeon.openPanel` | `left` | Twice with empty input opens the session panel. |
| `pigeon.resume.rename` | `ctrl+r` | Rename the selected session in the resume list. |
| `pigeon.toggleMode` | `shift+tab` | Switch approval mode. |
| `pigeon.effortCycle` | `alt+t` | Cycle thinking effort. |
| `pigeon.dequeue` | `alt+up`, `alt+q` | Move queued input back to the editor. |
| `pigeon.approval.approve` / `reject` / `rejectWithReason` / `grant` / `grantDirectory` | `y` / `n` / `r` / `a` / `d` | Approval answers (see Approvals). |
| `tui.altScreen.top` / `bottom` | `ctrl+home` / `ctrl+end` | Jump in the message area. |
| `tui.altScreen.search` | `ctrl+shift+f`, `f3` | Open search. |

Other `tui.*` actions keep the terminal library's defaults (editing: `ctrl+a`/`ctrl+e` line start and end, `ctrl+w` delete word, `ctrl+u`/`ctrl+k` delete to start or end, `ctrl+y` yank, `ctrl+-` undo; message area: `pageUp`/`pageDown`). Fixed keys that cannot be rebound: the subagent panel ("↑", "↓", "←", "→", "Enter", "x", "Esc"), the session panel, the read-only view's "Esc", the quit question ("y", "Enter"), the worktree clean question ("y", "n", "Esc"), the settings confirmation ("a", "s"), the rewind list, mouse wheel, drag-select and the Windows right-click.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `thinking.level` | by model (`high` or `off`) | Thinking effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `tui.wheelScrollLines` | `3` | Lines per wheel step, 1–20. |
| `tui.leftArrowOpensPanel` | `true` | Double "Left" opens the session panel. |
| `keybindings.<action>` | see key table | Rebind an action. |

Flags: `--thinking <level>` (accepts `max`), `--yolo`, `--history-limit <n>`.

## Known limitations

- "Ctrl+Up"/"Ctrl+Down" (jump to the previous or next prompt) do nothing.
- Editor line start/end defaults include "Ctrl+Home"/"Ctrl+End", which the message area takes in full screen; this overlap is not reported as a conflict.
- "Esc" in subagent and read-only views works even when `pigeon.cancel` is rebound.
- With `pigeon.exit` rebound, the quit question ignores "Ctrl+C" and treats the new exit key as any other key, cancelling the question.
