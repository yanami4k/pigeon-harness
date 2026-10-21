# Sessions

Purpose: how Pigeon records conversations and lets the user come back to them — the session
record on disk, resuming at startup or with "/resume" (including every resume error), starting
over with "/clear" and "/new", naming, rewinding conversation and code with "/rewind", forking
with "/fork", and the session's token count.

## Session records

- **SESSIONS-001** Pigeon shall store each top-level session as one JSONL file under the project's `.pigeon/state/sessions/`, in one folder per working directory, with the creation time and session ID in the file name (subagent sessions: see SUBAGENTS-077).
- **SESSIONS-002** A session ID shall be `sess_` followed by a 26-character ULID.
- **SESSIONS-003** The first line of a session file shall record the session ID, creation time, working directory and, for fork sessions and subagent sessions, the session they came from; a fork session also records its fork point, checkpoint and worktree.
- **SESSIONS-004** Every message shall be stored in full, including thinking unless `--no-persist-thinking` was given, in which case only an omission marker is kept.
- **SESSIONS-005** Besides messages, the file shall record Pigeon's own entries, among them run start (with configuration and system prompt) and end, compactions, file checkpoints, forks, grants given and revoked, hook runs, approval-mode and effort changes, git branch, rewinds, worktree moves, background jobs and agent messages.
- **SESSIONS-006** Records shall be appended in order as the conversation proceeds, without forcing them to disk; a record whose write has completed survives Pigeon being killed, and a machine crash or power loss may lose the last records.
- **SESSIONS-007** When writing the record fails, Pigeon shall show "session store warning: <action> failed: <cause>" once per failed action (such as opening the session file or writing one kind of record) and keep the session running.
- **SESSIONS-008** A session started in the terminal UI at launch or by "/new" or "/clear" shall create its file only when its first record other than a hook run, approval-mode or effort change, git branch record or "/rename" is written; those are held and written first, and such a session that never gets another record leaves no file.
- **SESSIONS-009** Every other session — resumed sessions, fork sessions, subagent sessions, sessions started from the session panel and `pigeon run` sessions — shall open or create its file as soon as it opens.
- **SESSIONS-010** A session whose file holds no record other than hook runs shall count as never started: `pigeon session list`, `list_sessions` and `search_sessions` neither list nor count it, and, having no turn, it is not offered by `--continue` or the resume list.
- **SESSIONS-011** Reading a session record for listing, search, history, trace or replay shall not modify it and shall work while another process is writing it; a partly written last line and unreadable lines are skipped without failing the file, and a file with an unreadable first line is ignored.
- **SESSIONS-012** Session files in a format Pigeon does not read — `<session ID>.jsonl` lying directly in `.pigeon/state/sessions/` — shall not be listed or resumed; resuming one fails with "can't resume <id>: old-format session; <hint>" (history display: see RENDERING-064).
- **SESSIONS-013** Subagent sessions shall not appear in the resume list or be picked by `--continue`, and "/resume <id>" or `--resume <id>` with a subagent session's ID reports it as not found (storage: see SUBAGENTS-077).
- **SESSIONS-014** Pigeon shall offer no command that deletes session records.
- **SESSIONS-015** A session shall belong to exactly one project and work only in its main checkout or one of its worktrees; "/resume", the resume list and `--continue` see only that project's sessions, including those working in its worktrees when run from the main checkout.
- **SESSIONS-016** Project and working directory of a session started inside a worktree: see WORKTREES-043.

## Resuming at startup

- **SESSIONS-017** `pigeon --continue` shall resume the project's most recently active session that has at least one turn, skipping sessions open in another Pigeon; with `--sandbox` it considers only sandbox sessions, without it only local ones; fork sessions take part like any other session.
- **SESSIONS-018** With nothing to continue, Pigeon shall start a new session and show "no session to continue; started a new session", or with `--sandbox` "no sandbox session to continue; started a new session".
- **SESSIONS-019** `pigeon --resume <session ID>` shall open the terminal UI in that session, the word after `--resume` counting as the ID unless it starts with `--`; `--resume` without an ID opens the UI and shows the resume list.
- **SESSIONS-020** `--continue` and `--resume` shall exclude each other ("--continue can't be used with --resume"), either one given twice fails with "<flag> given more than once", and `--worktree` with either fails with "--worktree can't be used with --continue or --resume".
- **SESSIONS-021** Without `--sandbox`, `--resume` shall fail before taking over the terminal with "session not found: <id>" for an unknown session and "can't resume <id>: old-format session; <hint>" for a file Pigeon does not read (SESSIONS-012).
- **SESSIONS-022** Sandbox and local sessions shall not be resumed across modes: a sandbox session resumed without `--sandbox`, by "/resume <id>" or from the resume list gets "<id> is a sandbox session; resume with: pigeon --sandbox --resume <id>", and `--sandbox --resume <id>` with any other session fails with "<id> is not a sandbox session; resume without --sandbox". In a sandbox session "/resume" replies "/resume not available in the sandbox; use pigeon --sandbox --resume <session ID>", "/new" replies "/new not available in the sandbox" and "/clear" replies "/clear not available in the sandbox".
- **SESSIONS-023** `pigeon resume [session ID] [options]` shall behave as `pigeon --resume`; the ID may come before or after the options.
- **SESSIONS-024** The resume list shall mark a session open in another Pigeon process "open elsewhere"; resuming such a session, from the list or with "/resume <id>", shall fail with "resume failed: session is open in another Pigeon (pid <pid>)", and `pigeon --resume <id>` with "session is open in another Pigeon (pid <pid>)".
- **SESSIONS-081** `--sandbox --resume` without an ID shall fail with "--sandbox --resume needs a session ID", and a sandbox session that has no delivered branch fails with "session <id> has no delivered sandbox branch pigeon/sandbox-<id>" (starting from the delivered branch: see SANDBOX-064).

## What resuming restores

- **SESSIONS-025** Resuming shall continue the conversation on its current branch, compactions replaced by their summaries; each tool call left without a result gets a result saying the process was interrupted and the result is unknown, and is never re-run.
- **SESSIONS-026** Before resuming a session with interrupted calls, Pigeon shall show "<N> tool call(s) interrupted, results unknown: <tools>".
- **SESSIONS-027** What a resumed session keeps (grants, task list, effort, system prompt): see APPROVALS-054, TOOLS-093, VIEWS-027, CONTEXT-090.
- **SESSIONS-028** Resuming a fork session whose worktree is gone shall fail with "branch worktree is gone: <path> (branch <branch> still exists)" (other sessions: see WORKTREES-042).
- **SESSIONS-029** When rendering the history after a resume fails, Pigeon shall show "rendering history failed: <reason>" and the resume stands (history display: see RENDERING-059, RENDERING-061).

## /resume

- **SESSIONS-030** "/resume <session ID>" shall switch the window to that session of the current project, also while running: a current session still working — a turn, compaction, reload or settings change of it in progress, or a subagent of it running, starting or compacting, or stopped with background jobs not finished — moves to the session panel and keeps working, otherwise it is closed.
- **SESSIONS-031** "/resume" with the current session's ID shall only show "already in session <id>"; with a session open in the panel, "session <id> is open in the session panel".
- **SESSIONS-032** When "/resume <id>" fails, Pigeon shall show "resume failed: <reason>" (a reason starting with "can't " is shown alone) and stay in the current session.
- **SESSIONS-033** While a resume, "/clear" or "/new" switch, a rewind, a reload or a compaction is in progress, a move into a worktree is queued, a panel session is being entered, or a turn is finishing, "/resume", "/clear" and "/new" shall be refused with "can't switch sessions right now" (entering a panel session: see PANEL-042).
- **SESSIONS-034** Messages typed while a switch is in progress shall be queued and sent after it.
- **SESSIONS-035** "/resume" without an ID shall open a full-screen view headed "resume a session" listing the project's sessions with at least one turn, fork sessions included and marked "fork of <source name>", except the current session and sessions open in the session panel; with none it shows "no sessions to resume".
- **SESSIONS-036** Each row shall read "<last active>  <name>  <git branch>  <N> turn(s)[ [sandbox]]  <first input>" ("1 turn", "2 turns"), newest first: the time as "just now", "<n>m ago", "<n>h ago", "<n>d ago" or, from 30 days on, YYYY-MM-DD; the last recorded git branch (short commit when detached, left out when none was recorded); the first input cut at 60 characters with "..." ("(no input)" if none).
- **SESSIONS-037** When a row does not fit, the first input shall be cut first and the branch dropped when fewer than 12 columns would remain for the first input.
- **SESSIONS-038** In the resume view, "↑" and "↓" shall move the selection, "Enter" shall return to the view the list was opened from and resume the selected session, and "Esc" shall close the list back to that view.
- **SESSIONS-039** Typing in the resume view shall filter by conversation content 150 ms after the last keystroke, listing matches by relevance with a dim snippet and the heading "resume a session · filter: <text>"; when no rows are shown it reads "searching..." while a search runs and "no matching sessions" after it; "Backspace" deletes a character and the first "Esc" clears the filter.
- **SESSIONS-040** When the session list cannot be read, "/resume" shall show "reading session list failed: <reason>".

## Names

- **SESSIONS-041** Pigeon shall use as a session's display name the name last saved for it — with "/rename", with "Ctrl+R" in the resume view, or, for a session started from the session panel, "<project-directory name>-<last 4 characters of the session ID, lowercased>" saved when it starts — when that name is valid, and otherwise "<working-directory name>-<last 4 characters of the session ID, lowercased>"; in both generated forms invalid characters in the directory name become `-`, the directory part is at most 35 characters, and an empty directory name becomes `pigeon`.
- **SESSIONS-042** A name shall be 1–40 letters, digits, `_`, `-` or `.`; names need not be unique and are for display only.
- **SESSIONS-043** In the main view "/rename <name>" shall rename the current session and reply "renamed to <name>", also while running; an invalid name gets "invalid name: use letters, digits, _, - and . (max 40)" and no name "usage: /rename <name>" (in a subagent view: see SUBAGENTS-070).
- **SESSIONS-044** Pigeon shall keep a saved name across quitting, resuming and rewinding; the main view has no title line with the name, which appears in "/status", the session panel, the resume list, the subagent panel's path line ("<name> › <path>"), `pigeon session list`, and in "/worktrees" and `pigeon worktrees` as the owner "in the session panel: <name> (<id>)".
- **SESSIONS-045** A fork session shall not inherit the source's name.
- **SESSIONS-046** In the resume view, "Ctrl+R" shall turn the selected name into an input prefilled with it and the hint "new name: enter to save, esc to cancel"; an invalid name or refusal is shown and the input stays open.
- **SESSIONS-047** Renaming from the resume view shall be refused for a session open in another Pigeon ("can't rename: the session is open in another Pigeon (pid <pid>)"), in this window ("can't rename: the session is open in this window; use /rename there"), or whose lock cannot be read ("can't rename: can't tell whether another Pigeon has the session open").

## Locks

- **SESSIONS-048** Only one process at a time shall write a session file, holding the lock file `<session file>.lock`; a lock whose process is gone or whose content is unreadable is taken over.
- **SESSIONS-049** Opening a session for writing that another live process holds shall fail with "session store warning: opening the session file failed: session is open in another process (pid <pid>): <lock file>" and write nothing (resuming: see SESSIONS-024).

## /clear and /new

- **SESSIONS-050** "/clear" shall replace the conversation with a new empty session in the same working directory; with arguments it shows "usage: /clear".
- **SESSIONS-051** Pigeon shall open a new session at the project root for "/new", and at the given path for "/new <path>" (spaces allowed, one pair of surrounding double quotes removed, `~` expanded, relative to the current working directory; inside a worktree see WORKTREES-043), failing with "new failed: no such directory: <path>" or "new failed: not a directory: <path>", where <path> is the resolved full path with the home directory shown as `~`.
- **SESSIONS-052** A new session from "/clear" or "/new" shall start without the old context and with its token count at zero (approval mode: see APPROVALS-007); the old session moves to the panel if it is still working (SESSIONS-030), otherwise it is closed.
- **SESSIONS-053** "/clear" and "/new" shall work while running, and "/new" also in a subagent view (see SUBAGENTS-070).

## /rewind

- **SESSIONS-054** "/rewind", or "Esc" twice within 500 ms when idle in the main view with an empty input and no completion list open, shall open a full-screen list headed "== messages =="; "/rewind" is refused while a turn runs with "can't use /rewind while running".
- **SESSIONS-055** The list shall show only the user's messages on the current path, one per line with the time right-aligned, newest at the bottom with the cursor there; program-injected inputs (agent messages, "[Pigeon] " notes, status blocks) are not the user's words and not listed; an empty session shows "(no messages yet)".
- **SESSIONS-056** Where the conversation forked, the row shall end with "‹i/n›", and "←"/"→" on it switch versions in place, the rows below following; after a rewind with nothing sent yet, that position has an extra dim "(no message yet)" version.
- **SESSIONS-057** Pigeon shall, on "Enter" on a row, open a menu titled "Rewind to \"<message>\"" ("Current position" on the "(no message yet)" row) with only the feasible items among "Restore code and conversation", "Restore conversation", "Restore code", "Switch to this version" and "Undo last code rewind", followed by "Cancel"; when none of these is feasible, no menu opens and the list shows the reason, or "already here" when there is none.
- **SESSIONS-058** The code items shall be absent when there is no code to restore, the session has no file checkpoints, a later message has none, or the point is in another workspace; a point in a worktree cannot be reached from the main checkout ("can't rewind: target is in a worktree, now in the main checkout; can't switch").
- **SESSIONS-059** Rewinding the conversation shall delete nothing: the later conversation stays as a branch that can be switched back to; the message area is redrawn followed by "--- rewound ---", the chosen message goes back into the input, and Pigeon reports what was rewound.
- **SESSIONS-060** A rewind shall not change session grants, stop background jobs or subagents, or undo learned memory.
- **SESSIONS-061** When the session changed after the point was picked, the rewind shall fail with "rewind failed: session changed after the point was picked".

## File checkpoints and code restore

- **SESSIONS-062** In a git workspace, in terminal-UI sessions and fork sessions, outside sandbox sessions and subagents, Pigeon shall checkpoint the working tree in the background after each tool that may change files and, in terminal-UI sessions, whenever a turn starts (for a session started from the session panel, only after it has been reloaded by "/reload" or by a "/config" change); it never touches the user's working tree, index, branch or HEAD, excludes `.pigeon/state`, `.pigeon/settings.local.json` and `.pigeon/worktrees`, and takes none in non-git workspaces or in other `pigeon run` sessions.
- **SESSIONS-063** Checkpoints shall leave out untracked files over `snapshot.untrackedFileMaxBytes` and beyond `snapshot.untrackedTotalMaxBytes` in total; a rewind never touches them ("skipped: <path> (too large to snapshot)").
- **SESSIONS-064** Before the next tool, hook, fork, switch or exit, Pigeon shall wait up to 30 seconds for a pending checkpoint; one that times out counts as failed.
- **SESSIONS-065** Pigeon shall, when restoring code, restore only files the agent changed after the chosen point, deleting files it created there, after checkpointing the current state; files edited by hand since the agent changed them or between two messages, files to be deleted that the agent did not create after that point, that current ignore rules ignore or whose ignore rules changed in that range, and files differing from another only in letter case are listed as uncertain (SESSIONS-066) instead of restored.
- **SESSIONS-066** Files Pigeon is unsure about shall be listed under "uncertain files (kept by default; space to toggle)" as "[keep] <path> (<reason>)" or "[revert] <path> (<reason>)"; "Space" toggles, "Enter" proceeds, "Esc" goes back.
- **SESSIONS-067** Pigeon shall, in a code restore, never write under `.pigeon` or `.git`, outside the repository, through symbolic links or junctions, to paths that are symbolic links or submodules in the target or directories on disk, to files with other hard links, to files on disk that the current-state checkpoint does not hold, to files differing from another only in letter case, or to files changed or deleted after planning; each is reported "skipped: <path> (<reason>)".
- **SESSIONS-068** Code restore shall reproduce file bytes exactly and save the bytes it overwrites, and switching back shall restore those bytes exactly; files whose content git might transform and that have no saved bytes are reported and left unwritten.
- **SESSIONS-069** Overwritten files shall keep their permissions; restored deleted files are created owner-only (with owner execute if they were executable).
- **SESSIONS-070** Code restore shall stop at the first failure, report "restoring files failed partway; conversation not rewound" with what was written, and not rewind the conversation; success lists restored, removed and skipped files.
- **SESSIONS-071** "Undo last code rewind" shall put every file the last code rewind touched back as it was just before; it is unavailable after an undo, after moving into a worktree since, or in another workspace.
- **SESSIONS-072** Queued input while the rewind list is open: see VIEWS-050.

## /fork

- **SESSIONS-073** "/fork [--at <entry> | --at <run prefix>:<entry>] [\"new input\"]" shall fork the session, by default at the start of the latest run; bad syntax shows the usage.
- **SESSIONS-074** Forking at an assistant message shall require new input ("fork failed: fork point is an assistant message; new input needed").
- **SESSIONS-075** A fork shall create a worktree `fork-<id>`, where `<id>` is the last 8 characters of the new session's ID in lowercase, from the checkpoint before the fork point, copy the history up to that point into a new session on that worktree, and add it to the session panel as an ordinary session; the source session stays current and unchanged.
- **SESSIONS-076** With "new input" the fork shall start a turn with it at once; otherwise it waits for input. It runs with the source session's approval mode and effort at the moment of forking, and its approvals wait in its own session like any other.
- **SESSIONS-077** "/fork" shall fail without recording a fork outside git ("can't fork: source workspace is not a git workspace: <path>"), without runs ("fork failed: no runs in this session yet; nothing to fork"), or when the needed checkpoint failed or is missing.
- **SESSIONS-078** "/fork" shall be refused while a turn runs ("can't use /fork while running") and in a sandbox session ("/fork not available in the sandbox"; in a subagent view: see SUBAGENTS-070).

## Token count

- **SESSIONS-079** The status bar shall show the session's cumulative tokens (input including cache reads and writes, plus output) of its own requests, its subagents at all levels and model requests made inside tools and any review session recorded as forked from it; sessions created from it by "/fork" are not counted, and no money amount is shown.
- **SESSIONS-082** Context copied into a subagent when it starts shall not be counted again, and the count shall update within about 0.5 seconds after a subagent changes state.
- **SESSIONS-080** A resumed session or one entered from the session panel shall start its count from the total recorded for it, conversation rewound away included, plus its subagents and review sessions (as in SESSIONS-079); "/clear", "/new" and a new session at launch begin at zero.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `snapshot.untrackedFileMaxBytes` | `10485760` | Largest untracked file kept in a checkpoint. |
| `snapshot.untrackedTotalMaxBytes` | `209715200` | Total untracked bytes kept in a checkpoint. |
| `keybindings."pigeon.resume.rename"` | `ctrl+r` | Rename in the resume view. |

Flags: `--continue`, `--resume [id]`, `--history-limit <n>`, `--no-persist-thinking`; command `pigeon resume`.

## Known limitations

- Locks are judged by process ID; a reused ID can make a session look held.
- Edits the user makes while the agent runs, between two tool calls, are taken for the agent's own.
- If Pigeon is killed between moving the branch and recording grants, a revoked grant may return after resume.
- Empty directories are removed only where their creation time can be read.
- On case-insensitive file systems, files differing only in case are never written by a restore.
- A same-length overwrite that also restores the modification time is not captured on Windows: Git for Windows records ctime as the creation time, so the git status cache that checkpoint snapshots rely on does not see the overwrite.
