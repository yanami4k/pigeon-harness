# Panel

Purpose: the session panel, where one Pigeon window shows and steers several independent
sessions — the current one, others open in this process, and sessions on the cross-workspace
work list — and the read-only view of a session open in another Pigeon process.

## Opening and leaving

- **PANEL-001** "/panel" shall open the full-screen session panel, headed "== sessions panel ==", with an input box at the bottom; it works while a turn is running.
- **PANEL-002** A sandbox session shall have no session panel: "/panel" replies "/panel not available in the sandbox" and "Left" does not open it.
- **PANEL-003** With the input empty in the main, subagent or read-only view, a first "Left" (the `pigeon.openPanel` key) shall show "press Left again to open the panel" on the status line, and a second within a second opens the panel with the card of the session just viewed selected (from a subagent view, the current session's card); otherwise the hint clears after that second.
- **PANEL-004** Any other key handled by the view shall cancel a pending first "Left"; keys taken first by an approval, "Esc" while "/memory edit" waits to save, the subagent panel, "Esc" in a subagent view, the completion list, the search box, an exit question or "Ctrl+C", and the scrolling and search keys (VIEWS-057), leave it pending until the hint clears. With text in the input "Left" shall move the cursor; with `tui.leftArrowOpensPanel` false it keeps that meaning and never opens the panel.
- **PANEL-005** The panel shall open without a peek; opened with "Left", the cursor is on the card of the session whose view it was opened from; opened with "/panel", it stays on the last selected card while that card exists, otherwise on the current session's card.
- **PANEL-006** "Esc" in the panel shall close an open peek, otherwise return to the current session's main view.

## Cards

- **PANEL-007** The panel shall list the current session, every other independent session open in this process, and work-list sessions not open in this process; subagents are not listed.
- **PANEL-008** Cards shall be grouped under "waiting", "running", "preparing", "idle", "failed" and "stopped", in that order, each heading "  <state> (<count>)"; empty groups are omitted and cards carry no state word.
- **PANEL-009** The current session's card shall be first within its group and tagged "current".
- **PANEL-010** Within a group, other open sessions shall be ordered most recently updated first, followed by work-list sessions in the order they were added.
- **PANEL-011** Each card shall be one line with four aligned columns — name, working directory, task, summary — "> " marking the selected card; the working directory is shown as the full path, also when it is the current session's, without `~` for the home directory, and when it does not fit it is shortened from the front so that it starts with "…" and keeps its end; other text that does not fit is cut with "…"; an empty task or summary shows the dim placeholder "-".
- **PANEL-012** The name column shall be as wide as the widest name with its tags, at most 32 columns; the task column as wide as the longest task but, when any card has a summary, at most half of the remaining width, that limit being never below 6 columns.
- **PANEL-013** The summary shall read "waiting: <what>" while an approval waits, "failed: <reason>" after a failure (except on the current session's card), otherwise the start of the last reply on one line (for sessions other than the current one at most 120 characters, then "…"), or, when there is none, the dim placeholder "-".
- **PANEL-014** A card's name shall carry the tags "current", "cancelling" (current session being interrupted) and "open elsewhere".
- **PANEL-015** Card and peek text shall be collapsed to one line (see RENDERING-048).
- **PANEL-016** When the cards do not fit, the list shall scroll to keep the selected card near the middle.
- **PANEL-017** While the panel is shown, the status line shall read "panel: <N> session(s)", with ", <M> waiting" when any card waits, except while an exit hint, the exit question "sub-agents are still running; exit anyway? (y/n)", the "/worktrees clean" question "remove these worktrees? [y/N]" or a settings confirmation takes the line.
- **PANEL-018** The latest message-area line shall also appear on the panel's note line under the cards; moving the selection clears it.
- **PANEL-019** Notices from sessions other than the current one shall be prefixed "[<session name>] ".

## Keys

- **PANEL-020** "Up" and "Down" shall move the selection one card, also with text in the input, unless the completion list or the search box is open, the exit question is waiting or a confirmation of another project's settings is shown.
- **PANEL-021** With the input empty, "Space" shall toggle the peek of the selected card.
- **PANEL-022** With the input empty, "Enter" or "Right" shall enter the selected session; on the current session's card it returns to the main view.
- **PANEL-023** A slash command submitted in the panel shall leave the panel and run in the main view for the current session.
- **PANEL-024** The key that moves queued input back to the editor shall not touch the current session's queue while in the panel.
- **PANEL-025** In the panel, letter keys shall go to the input box unless a confirmation of another project's settings is shown (see APPROVALS-041), the exit question is waiting (any key answers it) or the "/worktrees clean" question is waiting ("y", "n" and "Esc" answer it); a session with a pending approval (its own or a subagent's, also when stopped) is in "waiting" with "waiting: <tool> <args>", for a subagent "waiting: <path>: <tool> <args>", and for a subagent of the current session whose approval has not yet reached the approval area "waiting: <path>: approval".

## Peek and reply

- **PANEL-026** The peek shall appear under the cards as "  -- peek --" with "<name>: <task>", any waiting or failure line, and up to the last 4 typed messages ("> ") and replies, each cut at 200 characters; status blocks and program notices are not listed.
- **PANEL-027** Peeking the current session shall show any waiting line and up to its last 4 typed messages ("> ") and replies.
- **PANEL-028** Peeking a work-list session not open here shall show "<name>: <task>" and up to its last 4 messages from its record.
- **PANEL-029** While peeking another session, "Enter" shall send the input to that session; when refused, the reason goes to the note line and, if the input is still empty, the text back into it.
- **PANEL-030** Messages to a panel session shall be refused with "no such session", "session <name> is still starting", "session <name> is stopped" (stopped before it finished opening), "message is empty" or "can't send while <name> is running".
- **PANEL-031** A message to a stopped session shall resume it, also delivering subagent results that arrived meanwhile.
- **PANEL-032** While peeking the current session, input shall go to it: sent at once when idle, otherwise queued with the note "queued".

## Starting sessions

- **PANEL-033** Text submitted in the panel without a peek shall start a new session with that task when it has at least 3 characters after trimming (a CJK character counts as one); shorter text stays in the input and the note says "too short to start a session".
- **PANEL-034** A new session's card shall appear in "preparing" as "s<N>" and, once open, take the session's default name, the selection following it.
- **PANEL-035** A session started from the panel shall belong to the current session's project and, outside a git repository, work directly in the project directory (see APPROVALS-007, WORKTREES-080).
- **PANEL-036** When a new session fails to open, its card shall move to "failed" with the reason; an outright rejection shows "spawn failed: <reason>".
- **PANEL-037** When a panel session's turn ends, its card shall move to "idle", or to "failed" with the error, and its summary update; a stopped card stays "stopped".
- **PANEL-038** A session started from the panel shall store its name in its record and join the work list once open.
- **PANEL-039** A panel session that is not current shall run with its own MCP servers like the current session; when a background job ends or a subagent reports back while it is idle or failed and not stopped, it shall start a turn with those notices, and no job-ended line is shown for it (see CONTEXT-054, HOOKS-020).

## Entering a session

- **PANEL-040** Entering a panel session shall make it the current session, showing its conversation and carrying over its running turn and queue; the previous current session becomes a card that continues its own work.
- **PANEL-041** When the current session is interrupted from the panel, its queued input shall go back into the input box only when the user returns to that session's main view.
- **PANEL-042** Entering shall be refused with "can't switch sessions right now" while resuming, rewinding, reloading, compacting, finishing a turn, another switch, or a queued move into a worktree is in progress, or while the target is being reloaded with new settings.
- **PANEL-043** Entering a "preparing" card shall be refused with "session <name> is still starting"; a session released while opening with "session <name> is stopped"; other failures with "session <name> isn't open" or "opening <name> failed: <reason>".
- **PANEL-044** Entering a work-list session not open here shall first resume it in this process in its own project and directory; on failure the note gives the reason and the card stays.
- **PANEL-045** A work-list session opened here takes the current session's approval mode at that moment: see APPROVALS-007.
- **PANEL-046** Sending to a work-list session not open here shall open it first and then deliver; an empty message is refused before opening.

## Ctrl+X

- **PANEL-047** "Ctrl+X" on another open session's card shall stop it: interrupt its turn, keep it open with its subagents running, and move it to "stopped" (see APPROVALS-048); a stopped session is not woken by background events.
- **PANEL-048** A second "Ctrl+X" on the same card within 2 seconds shall remove the session from the panel and the work list and close it, keeping its record (see WORKTREES-079).
- **PANEL-049** A first "Ctrl+X" on a stopped card shall only arm the second press.
- **PANEL-050** "Ctrl+X" on a "preparing" card shall stop it, and it is released without running its task once open.
- **PANEL-051** For a work-list card not open here, the first "Ctrl+X" shall do nothing and a second within 2 seconds removes it from the work list only.
- **PANEL-052** Failures shall show "stopping <name> failed: <reason>", "removing <name> failed: <reason>" or "updating the work list failed: <reason>".
- **PANEL-053** A first "Ctrl+X" on the current session's card shall interrupt its running turn without leaving the panel and tag it "cancelling" until it stops (see APPROVALS-048); when idle it does nothing.
- **PANEL-054** A second "Ctrl+X" on the current session's card within 2 seconds shall make the next card (below, else above) that is neither "preparing" nor "open elsewhere" the current session, stay in the panel on it, and remove and close the previous one.
- **PANEL-055** Without such a card, or when entering it is refused, Pigeon shall open a new empty session as the current one instead and then remove the previous one.
- **PANEL-056** When switching is blocked, the second press shall only show "can't switch sessions right now".
- **PANEL-057** A session removed from the panel shall stay off the work list, also when the removal comes right after it joined the list, such as a quick double "Ctrl+X" on the current session just after its turn was interrupted.

## Work list

- **PANEL-058** Pigeon shall keep the work list in `~/.pigeon/state/session-index.json`, shared by all workspaces and windows and kept across restarts.
- **PANEL-059** A session shall join the work list when started from the panel or created by "/fork", when it is current and the user opens the panel from the main or a subagent view, when it is current and the user enters another session, or when "/resume", "/new" or "/clear" replaces it as current while it is still working (SESSIONS-030); only sessions with a session file join.
- **PANEL-060** The work list shall be re-read each time the panel opens.
- **PANEL-061** Entries whose session file is gone or cannot be read shall be left out of the panel; a malformed list shows as empty in the panel and is rewritten when the next session joins.
- **PANEL-062** A work-list session not open here shall be an "idle" card named from its record, with its first typed input as task and the start of its last reply as summary.
- **PANEL-063** When a listed session moves into a worktree or another directory, its entry shall follow.
- **PANEL-064** "/worktrees clean" keeps worktrees used by work-list sessions: see WORKTREES-047.
- **PANEL-065** Writes from several windows shall not overwrite each other; a held lock is retried for about a second.
- **PANEL-066** Sandbox sessions shall never join the work list.

## Sessions open elsewhere

- **PANEL-067** A work-list session held by another live Pigeon process, or whose lock cannot be read, shall be tagged "open elsewhere", checked when the panel opens.
- **PANEL-068** Entering such a card shall open a read-only view with one dim title "session <name> · open elsewhere · esc to go back", without a subagent panel and without changing the current session.
- **PANEL-069** That view shall answer every message and command with the line "session <name> is open elsewhere", keep the text in the input box and not record it in prompt history.
- **PANEL-070** That view shall follow the session's record about once a second, append new entries, start over when the file is replaced, shrinks or its modification time goes back, and stay as it is when the record cannot be read.
- **PANEL-071** In that view the status bar shall show that session's approval mode, effort, context use and tokens (see SESSIONS-079) as its record holds them.
- **PANEL-072** "Esc" or a double "Left" in that view shall return to the panel with the card selected.
- **PANEL-073** Messages to an "open elsewhere" card shall be refused with "session <name> is open elsewhere", and it cannot be stopped.
- **PANEL-076** In that view the status line shall show no session state word, neither the current session's nor the viewed session's; only hints such as "press Left again to open the panel" appear there.

## Closing

- **PANEL-074** When Pigeon exits, it shall stop all panel sessions within 15 seconds in total and, after leaving the full screen, print "session <name> didn't stop within 15s" for each that was still opening or running when the time ran out ("session panel didn't stop within 15s" when none can be named); work-list entries remain (see WORKTREES-079).
- **PANEL-075** When Pigeon exits, a panel session still opening, or a work-list session being opened, shall be released once open without running its task.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `tui.leftArrowOpensPanel` | `true` | Double "Left" on empty input opens the panel. |
| `keybindings."pigeon.openPanel"` | `left` | Key for opening the panel. |
| `keybindings."pigeon.tree"` | `ctrl+x` | Stop, then remove, the selected session. |
| `worktree.baseRef` | `"fresh"` | Start point of panel sessions' worktrees (see Worktrees). |

## Known limitations

- All panel sessions run inside the one Pigeon process that shows the panel.
- Prompt history cannot be browsed in the panel.
- A peek of another session is fetched when opened, when the selection moves and after a message is sent to it; apart from its waiting line it does not otherwise refresh.
- A reused process ID may make a closed session look open elsewhere.
- The panel's "Up", "Down", "Space", "Enter", "Right" and "Esc" cannot be rebound.
- While another window holds the work list's lock, the UI may pause for up to about a second.
