# Worktrees

Purpose: how Pigeon isolates work in git worktrees — a session started or moved into a named
worktree, worktrees of session-panel sessions, forked sessions and subagents, bringing their
changes back with "/take" or `take_changes`, and listing and cleaning leftover worktrees.

## Shape and location

- **WORKTREES-001** Every worktree Pigeon creates (for `--worktree`, `enter_worktree`, session-panel sessions, forked sessions and subagents) shall live at `<main repository root>/.pigeon/worktrees/<name>` on a branch `pigeon/<name>`; a forked session's worktree is named `fork-<id>`, `<id>` being the last 8 characters of the forked session's ID in lowercase (see SESSIONS-075).
- **WORKTREES-002** When the project is a subdirectory of a repository, worktrees shall still be created, found and listed under the main repository root.
- **WORKTREES-003** The main repository root shall be the main checkout for linked worktrees; for a submodule, a separate git directory or a bare-plus-worktree layout it is the current checkout's top level.
- **WORKTREES-004** A worktree name shall start with a lowercase letter or digit, contain only lowercase letters, digits, underscores and hyphens, and have at most 64 characters; other names are rejected with "invalid worktree name: \"<name>\"" before git runs.
- **WORKTREES-005** Pigeon shall recognise worktrees only under `.pigeon/worktrees/` of the main repository root: worktrees elsewhere are not listed or moved there, and a session whose recorded worktree lies elsewhere resumes in the project root, except that a forked session resumes in its recorded worktree (see WORKTREES-042).
- **WORKTREES-006** When Pigeon creates a worktree for `--worktree`, `enter_worktree` or a panel session, it shall make sure the user's global git excludes file ignores `**/.pigeon/worktrees/`, adding the line only when git does not already ignore that path; when `core.excludesFile` is a relative path it only reports that the line was not added.
- **WORKTREES-007** Pigeon shall record each new worktree's start commit in the repository's local git configuration; without it "/worktrees" counts the start point as unknown (for a `pigeon/` branch without a worktree see WORKTREES-087) and "/take" reports "no base recorded" (WORKTREES-077) unless the session has an earlier complete take point, while `take_changes` falls back to the start noted at spawn, the subagent's start snapshot or the commit its branch was created at.
- **WORKTREES-008** A new worktree for `--worktree`, `enter_worktree`, a panel session or a subagent shall not inherit the start or take point of an earlier worktree of the same name.

## Copied ignored files

- **WORKTREES-009** When creating a worktree, if the repository top level has a `.worktreeinclude` file (gitignore syntax), Pigeon shall copy into the new worktree the files of the source checkout that both match it and are ignored by git, except those skipped by WORKTREES-011; tracked files, non-ignored files and anything under `.pigeon` are not copied.
- **WORKTREES-010** `.worktreeinclude` paths shall be relative to the repository top level, also when the session runs in a subdirectory.
- **WORKTREES-011** Pigeon shall copy only regular files and skip any path that goes through a symbolic link or junction, resolves outside the repository, contains a `.git` segment, cannot be read, or whose target already exists.
- **WORKTREES-012** When copying fails, Pigeon shall remove the new worktree and branch and fail with "copying .worktreeinclude files failed: <reason>".

## Start point

- **WORKTREES-013** For a new named worktree (`--worktree`, `enter_worktree`, panel session), `worktree.baseRef` `"fresh"` (default) shall start it from the remote default branch and `"head"` from the current HEAD.
- **WORKTREES-014** In `"fresh"` mode, when the repository has not fetched in the last 24 hours, Pigeon shall first fetch that branch from `origin` with a 5-second limit, with terminal and credential prompts turned off and ssh in batch mode unless the user configured an ssh command.
- **WORKTREES-015** Without a remote default branch Pigeon shall start from HEAD with no line in the message area (the label is "HEAD (no remote default branch)"); when the fetch fails or times out it starts from HEAD labelled "HEAD (fetching origin failed)" or "HEAD (fetching origin timed out)".
- **WORKTREES-016** When `pigeon --worktree` starts from HEAD after the fetch failed or timed out, Pigeon shall show "worktree base: <label>" in the message area.
- **WORKTREES-017** In a repository without commits, creating a named worktree (`--worktree`, `enter_worktree`, panel session) shall fail with "repository has no commits; can't create a worktree"; a subagent worktree fails with "The repository has no commits yet, so no working-directory snapshot can be taken: commit once first".
- **WORKTREES-018** A change to `worktree.baseRef` shall apply to the next named worktree once the session's settings are current (at once via "/config", after "/reload" for a hand edit); it does not affect subagent or forked-session worktrees.

## pigeon --worktree

- **WORKTREES-019** `pigeon --worktree <name>` (or `--worktree=<name>`) shall start the terminal UI with the session working in that worktree.
- **WORKTREES-020** Only the terminal UI shall accept `--worktree` (`pigeon run` reports "unknown option: --worktree (<usage>)"); a missing, empty or dash-prefixed value exits with "usage: pigeon --worktree <name>", a repeated flag with "--worktree given more than once".
- **WORKTREES-021** `--worktree` shall be refused with "--worktree can't be used with --sandbox" alongside `--sandbox` (for `--continue` and `--resume` see SESSIONS-020).
- **WORKTREES-022** Outside a git repository, `--worktree` shall exit with "not in a git repository; can't use --worktree".
- **WORKTREES-023** With `--worktree`, the session's project (settings, session records, memory) shall be the main repository root; only the working directory is the worktree.
- **WORKTREES-024** When a worktree of that name already exists in this repository, Pigeon shall open it, unless another session is using it (WORKTREES-026), and show "opened the existing worktree <path>" in the message area; a directory of that name that is not a worktree of this repository fails with "<path> exists but is not a worktree of this repository".
- **WORKTREES-025** An existing worktree that is on another branch than its own shall still open but count as having changes.
- **WORKTREES-026** `pigeon --worktree <name>` and `enter_worktree` shall refuse, creating nothing, a worktree that another session or a running subagent is using, with "worktree <path> is in use by session <name> (<id>)" (`enter_worktree`: "Not now: the worktree <path> is in use by session <name> (<id>). Wait until that is resolved, then call enter_worktree again."); a worktree is in use as in WORKTREES-047.
- **WORKTREES-027** When the directory of `<name>` is gone but the branch `pigeon/<name>` is still there, `--worktree <name>` and `enter_worktree` shall check for the branch before changing anything and fail, keeping the branch and its recorded start and take points, with an error that names the leftover branch and suggests "/worktrees clean <name>" or another name.
- **WORKTREES-028** When a session ends or is removed from the panel, Pigeon shall neither delete nor ask about the worktree it works in; cleanup is left to "/worktrees clean" (subagent worktrees: see WORKTREES-068).

## enter_worktree

- **WORKTREES-029** Pigeon shall offer `enter_worktree` only to terminal-UI sessions opened by startup, "/resume", "/new", "/clear" or opening a work-list session, in a git repository; not in `pigeon run`, sandbox sessions, sessions started from the panel or subagents. While such a session runs in the background of the panel (for example a work-list session opened by sending it a message from the panel), the call is refused with the reason "the session is in the background (session panel)".
- **WORKTREES-030** When offered, the system prompt shall say it may be called only when the user explicitly asks to work in a separate worktree, and the tool description shall add "Use it only when no other session is using that worktree."
- **WORKTREES-031** `enter_worktree` shall take one parameter, `name`, checked by WORKTREES-004 (approval: see APPROVALS-012).
- **WORKTREES-032** `enter_worktree` shall create or reuse the worktree by the same rules as `--worktree`, and its result shall state path, branch and start point (or reuse), how many uncommitted files were not carried over, and that the move happens when the turn ends.
- **WORKTREES-033** `enter_worktree` shall refuse, creating nothing, with "This session is already working in the worktree <path>; it cannot move into another one." when it already works in a worktree, and otherwise with "Not now: <reason>. Wait until that is resolved, then call enter_worktree again." where the reason is "the session is in the background (session panel)", "sub-agents are running" or "a move into the worktree <path> is already pending this turn" (with running subagents the reply reads "Not now: sub-agents are running. Wait until that is resolved, then call enter_worktree again.").
- **WORKTREES-034** When creation fails, `enter_worktree` shall return "Creating the worktree failed: <reason>" and the session stays put.
- **WORKTREES-035** At the end of the turn, Pigeon shall move the session into the worktree and reload it as "/reload" does with the same session record and grants (see APPROVALS-007, CONTEXT-090), show "moved into worktree <path> (branch <branch>)" (with "; N uncommitted change(s) left in the main checkout" when there are any), and start a new turn with a program note telling the agent to continue its task.
- **WORKTREES-036** Hook events fired by a move into a worktree: see HOOKS-013 and HOOKS-015.
- **WORKTREES-037** When the turn is interrupted, Pigeon shall not move, shall show "didn't move into worktree <path>: turn interrupted; session stays here", keep the worktree, and tell the model with the user's next message; no new turn starts.
- **WORKTREES-038** When reloading the session in the worktree fails, Pigeon shall stay in place, show "didn't move into worktree <path>: rebuilding the runtime failed: <reason>; session stays here", keep the worktree and tell the model with the user's next message.
- **WORKTREES-039** Only a successful move shall be recorded in the session record.
- **WORKTREES-040** While a move into a worktree is pending, switching sessions shall be refused (see SESSIONS-033).
- **WORKTREES-041** Program notes about worktree moves shall begin with "[Pigeon] " (see SESSIONS-055, RENDERING-063).

## Sessions and worktrees

- **WORKTREES-042** When a session is resumed or reloaded, Pigeon shall reopen it in the worktree it last moved into with `enter_worktree`, else the worktree it was started in; when that worktree is gone, in the project root without an error, except that a forked session whose worktree is gone fails (see SESSIONS-028).
- **WORKTREES-043** Starting the terminal UI, or "/new <path>", in a directory inside a worktree of a repository shall make the main checkout the session's project, with that directory as working directory; sandbox sessions are excluded (command-line entries: see CLI-036).
- **WORKTREES-044** A session working in a worktree shall keep its records, settings and memory in the project's `.pigeon` (see SESSIONS-015).
- **WORKTREES-045** Leaving a worktree by "/new", "/resume" or quitting shall leave the worktree on disk untouched, except a subagent's temporary worktree (see WORKTREES-068).

## In use

- **WORKTREES-046** While a terminal-UI session in any Pigeon process (forked sessions included) or a subagent works in a worktree or a directory inside it, Pigeon shall mark that worktree in use under `~/.pigeon/state/`; a mark whose process has exited is removed when checked.
- **WORKTREES-047** A worktree shall count as in use when a running process marks it, or when a session in the session panel's work list, whose session record still exists, works in it or below it; when the work-list file exists but cannot be read or is not a valid work list, every listed worktree and directory counts as in use (a branch without a worktree does not).
- **WORKTREES-048** Work-list entry following a session that moves into a worktree: see PANEL-063.

## Listing and cleaning

- **WORKTREES-049** "/worktrees" (or "/worktrees list") and `pigeon worktrees list` shall list, under "leftover worktrees and branches (N):", worktrees under `.pigeon/worktrees/`, registrations whose directory is gone, `pigeon/` branches without a worktree, and unknown directories there; with none, "no leftover worktrees or branches".
- **WORKTREES-050** Each item shall be one numbered line with name, branch and markers "(worktree gone)", "(directory gone, still registered)" or "directory (unknown to git)", its untaken-change status ("no untaken changes", "untaken changes: N file(s)", "new commits on branch" or "untaken changes: unknown"), its disk size when it has a directory, and "in use (<reason>)" with reason "session open", "in the session panel: <name> (<id>)" or "the session panel's work list can't be read: <path>".
- **WORKTREES-051** For a worktree with its directory, untaken changes shall be the files changed since the recorded start point (committed or not, plus untracked non-ignored files) whose content differs from the main checkout; an unknown start point, a worktree off its own branch, an unknown directory or a failure of git to list the changes counts as "unknown" and as having changes.
- **WORKTREES-087** For a registration whose directory is gone, or a `pigeon/` branch without a worktree, only new commits on its own branch shall count ("new commits on branch"), measured from the recorded start point or, for a branch without a worktree, from the commit git's reflog shows it was created at ("unknown" when that is missing).
- **WORKTREES-052** `pigeon worktrees` shall act on the repository of the current directory and refuse to run inside a worktree with "not available inside a worktree under .pigeon/worktrees; run from the main checkout"; "/worktrees" in the terminal UI works on the session's project.
- **WORKTREES-053** `clean` without arguments shall select every item not in use with no untaken changes; `--all` every item not in use; numbers, full branch names or names select those items; an ambiguous name is refused "<arg>: ambiguous (N matches)", an unknown one "<arg>: not found".
- **WORKTREES-054** Items in use shall never be removed: naming a work-listed session's worktree is refused with "<arg>: belongs to session <name> (<id>) in the session panel; remove it from the panel first", other in-use items with "<arg>: in use (<reason>)", and a mark found at the moment of removal gives "removing <name> failed: in use (session open)".
- **WORKTREES-055** Before removing, Pigeon shall show "will remove N item(s):" with each item and the branch to delete and, for items with untaken changes, ": <status>, lost on removal", then "kept <reason>" lines; with nothing selected it says "nothing to remove" and asks nothing.
- **WORKTREES-056** In the terminal UI the status line shall then ask "remove these worktrees? [y/N]"; "y" or "Y" removes; any other key except the scrolling and search keys (VIEWS-057), "Esc" or another command cancels with "cancelled"; "y", "Y", "n", "N" and "Esc" are used up as the answer, and any other key then acts normally.
- **WORKTREES-057** While the question is pending, status refreshes shall not overwrite it, and an arriving approval takes the keys first; the question remains afterwards.
- **WORKTREES-058** `pigeon worktrees clean` shall ask "remove? [y/N] " when standard input is a terminal (accepting `y` or `yes` in any case; any other answer prints "cancelled"); without a terminal it prints the plan and "no terminal to confirm; rerun with --yes" and removes nothing; `--yes` prints the plan and removes without asking.
- **WORKTREES-059** After confirmation Pigeon shall re-check each item and keep any that is gone ("<name>: gone"), now in use ("<name>: now in use (<reason>)") or changed ("<name>: changed since listing (<status>)").
- **WORKTREES-060** Results shall read "removed N item(s): <names>" or "nothing removed", followed by "removing <name> failed: <reason>" and "kept …" lines; one failure does not stop the others.
- **WORKTREES-061** Removing a worktree shall delete only its own `pigeon/<name>` branch and its recorded start and take points; for a registration whose directory is gone, only that registration, that branch and those points; for an unknown directory, only that directory.
- **WORKTREES-062** Removal shall not follow symbolic links or junctions, shall drop only that worktree's registration, and shall refuse a locked worktree ("worktree is locked (git worktree lock); not removed: <path>") or a checkout whose `.git` is a directory ("<path> is not a git worktree (.git is a directory); not removed").
- **WORKTREES-063** "/worktrees" shall be available only outside the sandbox (inside it is an unknown command) and reply "not a git repository" for a project outside git; it works while a turn is running; a wrong sub-command shows "usage: /worktrees [list] | /worktrees clean [<number|branch|name>...] [--all]", the same usage the "/" completion list shows for it, and an unknown option to `clean` shows "unknown option: <option> (<that usage>)".
- **WORKTREES-064** `pigeon worktrees` without a valid sub-command (or `list` with arguments) shall fail with "usage: pigeon worktrees list | clean [<number|branch|name>...] [--all] [--yes]"; an unknown option to `clean` fails with "unknown option: <option> (<that usage>)".
- **WORKTREES-065** "/worktrees" shall follow the repository of the current session's project, and a pending clean question is kept per repository.

## Subagent worktrees

- **WORKTREES-066** `spawn_agent` with `worktree: true` shall create a temporary worktree started from a snapshot of the spawner's working directory, uncommitted changes included, named after the subagent (lowercased, each run of characters other than `a-z`, `0-9` and `-` replaced by one `-`, leading and trailing `-` removed, at most 40 characters, `agent` if empty) and yielding to "<name>-2", "<name>-3", ….
- **WORKTREES-067** Each time such a subagent reports, if its worktree has changes since its start or last complete take, the report shall add "Its changes are in the worktree at <path> (branch <branch>). Use take_changes with its name to bring them into your working directory."
- **WORKTREES-068** When a subagent is released (its session closed or switched away, or Pigeon exiting), Pigeon shall delete its temporary worktree and branch if it has no changes since its start or last complete take, and keep it if it has changes, the subagent was interrupted mid-turn, or another session is using it.
- **WORKTREES-069** A restored subagent that is reopened shall work again in its recorded worktree if it still exists, else in the spawner's working directory.

## /take and take_changes

- **WORKTREES-070** "/take <session ID>" shall bring the changes made in a panel session's worktree since its start point, or since the last complete take, into the current working directory with a per-file three-way merge; only the full session ID matches.
- **WORKTREES-071** "/take" without arguments shall put "/take " in the input and offer the sessions that can be taken now; with none it says "no session to take changes from".
- **WORKTREES-072** "/take" shall report "took N file(s): <files>", "conflicts, not written: <files> (still in worktree <path>)", "deleted in session, kept here: <files>", "too large, not taken: <files>", or "no changes to take from session <name>".
- **WORKTREES-073** The merge shall write only files changed in the worktree, never delete or revert a working-directory file, and list as conflicts incompatible edits, differing new files, binary files changed on both sides, files deleted in the working directory but changed in the worktree, symbolic links, submodules, type changes and files whose working-directory path is not a regular file; it cannot be undone.
- **WORKTREES-074** The merge shall not take program-owned paths (`.pigeon/state/`, `.pigeon/settings.local.json`, `.pigeon/worktrees/`) but shall take a tracked `.pigeon/settings.json`; new untracked files over the snapshot size limit are listed as too large.
- **WORKTREES-075** After a complete "/take" (nothing in conflict, deleted or too large), Pigeon shall move that session's take point to the worktree's current state and keep it across restarts; the next "/take" brings only later changes, and a failure to move it adds "advancing the base failed: <reason>".
- **WORKTREES-076** "/take" shall refuse a session not in the panel ("no session with ID <id> in the session panel"), the current session ("<id> is the current session; nothing to take"), a running, starting or stopped session ("can't take while <name> is running", "session <name> is still starting", "session <name> is stopped"), one without a worktree ("<name> has no worktree; nothing to take") or in another repository ("<name> is in another repository; nothing to take"), and the case where the current session works in that worktree ("the current session is in <name>'s worktree; nothing to take").
- **WORKTREES-077** When the worktree is gone or has no recorded start point, "/take" shall say "worktree of session <name> is gone (<path>)" or "worktree of session <name> has no base recorded"; a merge failure reads "taking changes from session <name> failed: <reason>".
- **WORKTREES-078** "/take" shall be unavailable in a sandbox session ("/take not available in the sandbox") and refused while a turn is running ("can't use /take while running") (subagent views: see SUBAGENTS-070).
- **WORKTREES-079** Removing a session from the panel or closing Pigeon shall keep its worktree, branch and take point for "/worktrees clean".
- **WORKTREES-080** A session started from the panel in a git repository shall get its own worktree named after its default display name (cleaned to worktree-name rules, `session` if empty), yielding with "worktree name <wanted> is taken; using <name>"; in `"fresh"` mode the fetch runs in the background, and a failure says "fetching the remote default branch failed; worktree starts from HEAD".
- **WORKTREES-081** `take_changes` (`target`) shall bring a subagent's worktree changes into the caller's working directory with the same merge; a caller may take only from subagents it started directly; a session's main agent may also name a panel session of the same repository by full session ID.
- **WORKTREES-082** `take_changes` shall not be offered to read-only agent types (approval: see APPROVALS-012).
- **WORKTREES-083** `take_changes` shall fail when the target or anything below it is still working, is not a subagent the caller started, used no worktree, has a missing or foreign-branch worktree or unknown start point, or when the caller works in that worktree.
- **WORKTREES-084** `take_changes` shall not write files under `.pigeon/`; they are listed as "protected, not taken: <files>" and the take counts as incomplete.
- **WORKTREES-085** After a complete `take_changes` from a subagent, its take point shall move forward; taking from a panel session does not move it.
- **WORKTREES-086** Pigeon shall find a subagent's worktree by the working directory recorded when it was spawned, not by its name; a renamed subagent or one whose worktree name yielded ("<name>-2") is found the same way.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `worktree.baseRef` | `"fresh"` | Start point of new named worktrees: remote default branch (`"fresh"`) or current HEAD (`"head"`). |

Flags and commands: `--worktree <name>`; `pigeon worktrees list | clean [...] [--all] [--yes]`. File: `.worktreeinclude` at the repository top level. Fetching honours `GIT_SSH_COMMAND`, `GIT_SSH` and `core.sshCommand`.

## Known limitations

- The fetch for `--worktree` and `enter_worktree` runs in the foreground and can hold the UI for up to about 5 seconds; any fetch within 24 hours counts as recent.
- When the fetch fails, Pigeon falls back to HEAD rather than a previously fetched remote branch.
- Uncommitted changes in the main checkout are not carried into a worktree.
- There is no command to move a session from a worktree back to the main checkout.
- On Windows, removal may fail part-way while files are in use; the item (its registration, branch and remaining files) is kept and the failure reported.
- A restored subagent that works in its earlier worktree does not report where its changes are, and that worktree is not removed when the subagent is released.
- Repeated `take_changes` from the same panel session start from the same point each time; files changed in the working directory after an earlier take can then be reported as conflicts.
- Merging back does not apply `.gitattributes` filters (such as LFS); branches hold the working-tree text.
- `enter_worktree` reports a fetch fallback only to the model, not in the message area.
- Resuming a session back into a worktree and a session started from the panel into one are not checked by WORKTREES-026.
