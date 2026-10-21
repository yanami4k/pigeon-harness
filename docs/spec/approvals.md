# Approvals

Purpose: when a tool call needs a person's approval and how it is given — the two approval
modes, risk tiers and the order of checks, the approval box, its keys and where it appears,
session grants and saved rules with "/grants", "/revoke" and "/grants save", the workspace
fence, protected paths and MCP tiers.

## Approval modes

- **APPROVALS-001** Pigeon shall have two approval modes: in "ask", calls to writing, command and network tools and `read_file` calls outside the workspace wait for a person's answer unless a session grant or saved rule covers them or a `PreToolUse` hook allows them (writes into protected paths always wait, APPROVALS-079); writes outside the workspace are refused (APPROVALS-077), while reading tools inside the workspace and `update_memory` run without asking (see APPROVALS-010); in "bypass", every call to an offered tool is allowed without asking unless a `PreToolUse` hook denies it or asks (see HOOKS-043, HOOKS-044).
- **APPROVALS-002** A session shall start in "bypass" with `--yolo`, or with `--sandbox` unless `--sandbox-approval prompt` is given (with `--yolo` as well it still starts in "bypass"); otherwise it starts in "ask".
- **APPROVALS-003** "Shift+Tab" shall switch the current session between "ask" and "bypass" at once; later calls are judged by the new mode.
- **APPROVALS-004** While an approval is shown, also while a reason is typed, "Shift+Tab" shall neither switch the mode nor answer the approval; switching never answers pending approvals.
- **APPROVALS-005** In the read-only view, or while the current session is still being opened, "Shift+Tab" shall do nothing.
- **APPROVALS-006** Each switch shall be recorded in the session with old mode, new mode and time; switching to the same mode records nothing.
- **APPROVALS-007** A session resumed after restarting Pigeon shall take its mode from the launch flags; within one process, "/reload", worktree moves, "/resume", "/new", "/clear", sessions started from the panel and work-list sessions opened from the panel that were not open in this process (left from before a restart, or of another project) shall take the current session's mode at that moment, while a session already open in the panel keeps its own mode.
- **APPROVALS-008** A subagent shall share its session's mode, including later switches.
- **APPROVALS-009** Whether `write_file` and `edit_file` accept paths outside the workspace shall be judged by the approval mode in force when the call runs: in "bypass" they accept them, in "ask" they refuse them as in a session opened in "ask", and "Shift+Tab" changes this at once in both directions; subagents, panel sessions and fork sessions share the same mode switch and are judged the same way (see TOOLS-032).

## Tiers and order of checks

- **APPROVALS-010** After a call's `PreToolUse` hooks (see HOOKS-042), Pigeon shall decide a call to an offered tool in this order: a write outside the workspace in "ask" → refuse (APPROVALS-077); matching session grant or saved rule → allow (not for protected paths, APPROVALS-079); approval-free tool → allow; "bypass" → allow; reading tool inside the workspace → allow; a `PreToolUse` hook's allow → allow (not for protected paths); otherwise ask a person; when a `PreToolUse` hook asks, every step before asking a person is skipped (HOOKS-044).
- **APPROVALS-011** A call to a tool the session does not offer shall be refused in every approval mode without running hooks or asking a person.
- **APPROVALS-012** The reading tools `read_file`, `grep`, `glob`, `web_search`, `load_skill`, `job_output`, `job_kill`, `search_sessions`, `read_session_entry`, `list_sessions`, `update_tasks`, `list_tasks`, `spawn_agent`, `send_message`, `list_agents` and `stop_agent` shall need no approval, except `read_file` outside the workspace (APPROVALS-072); `edit_file`, `write_file`, `take_changes` and `enter_worktree` are writing tools, `run_command` is a command tool, `web_fetch` is a network tool, and MCP tools take their configured tier (APPROVALS-089).
- **APPROVALS-013** `update_memory` shall not ask for approval in either mode, unless a `PreToolUse` hook asks.
- **APPROVALS-014** When a person rejects without a reason, the model shall receive "Rejected by the human reviewer"; with a reason, the reason as typed, without leading and trailing spaces.
- **APPROVALS-015** When a call needs a person's approval and there is no approval channel — in `pigeon run` without bypass, including subagent calls, and with bypass for calls a `PreToolUse` hook sends to approval — it shall be refused with "The policy requires human approval, but no approval channel is configured"; an outside read gets the text of APPROVALS-074 instead.
- **APPROVALS-016** When the tool can preview the call, Pigeon shall attach the preview to the approval — a diff for `write_file` and `edit_file`, how the command will run for `run_command` (see TOOLS-051); if the preview fails, the approval is shown without it.
- **APPROVALS-017** What a `PreToolUse` hook's allow or ask does to approval: see HOOKS-043, HOOKS-044.

## The approval box

- **APPROVALS-018** A pending approval shall be shown in a box with a rounded border at the bottom of its view, below the messages and above the status line and input box (in the rewind list, above the status bar), not in the message flow.
- **APPROVALS-019** The box's first line shall be the tool name in bold, followed by the command (one line per command line) for a command call, the site for a `web_fetch` call with a host, or else the `path` argument when there is one.
- **APPROVALS-020** A command that runs through a shell shall add the line "runs in a shell".
- **APPROVALS-021** The box shall warn "protected path: <path> (approve each time only)" for writes into a protected path and "outside workspace (read-only): <real path>" for reads outside the workspace; writes outside the workspace get no warning line.
- **APPROVALS-022** A subagent's request shall show "source: sub-agent <path>" (nested as "general-1 › explore-2"); a main agent's request has no source line.
- **APPROVALS-023** Remaining arguments shall be listed as "args: <JSON>", leaving out `command` and `path` when they were shown above; with nothing left the line is omitted.
- **APPROVALS-024** A diff preview shall show added lines green and removed lines red.
- **APPROVALS-025** The last line shall list the keys: "[y] approve once / [n] reject / [r] reject with reason" and the grant keys that apply, each written with the keys currently bound to it.
- **APPROVALS-026** A box taller than the terminal height minus 10 rows (at least 4 rows) shall keep its first lines and the key line, replacing the middle with "... N more lines not shown"; lines are wrapped to the box width (see RENDERING-048).
- **APPROVALS-027** While an approval is shown, the status line shall show no state word; while a rejection reason is typed it reads "reason for rejecting (enter to send, esc to go back)".

## Keys

- **APPROVALS-028** "y" shall approve the call once and "n" reject it without a reason (see SETTINGS-076).
- **APPROVALS-029** "r" shall open a reason line in the input box; "Enter" rejects with the typed text and does nothing when it is blank, "Esc" clears the text and returns to the approval, and the reason is not added to the input history.
- **APPROVALS-030** When the approval a reason is being typed for stops being the one shown, Pigeon shall discard the reason and clear it from the input box.
- **APPROVALS-031** For 300 ms after an approval appears in a view or another one takes its place, the answer keys shall do nothing.
- **APPROVALS-032** For calls not covered by APPROVALS-034 to APPROVALS-036, "a" shall approve and create a session grant for the whole tool ("[a] allow for this session", or "for this sub-agent").
- **APPROVALS-033** "d" shall be offered only outside a sandbox session, for a call with a `path` argument that is neither a command nor a network call nor a protected-path write, and approve with a grant limited to that path's directory ("[d] allow for this session (this directory)"); pressed when not offered, it acts like "a".
- **APPROVALS-034** For a call to `run_command` or to an MCP tool of tier `exec`, "a" shall read "[a] allow this exact command for this session" ("for this sub-agent" for a subagent; " (shell)" when through a shell) and grant only that exact `command` argument; when the call has no `command` argument, "[a]" is not offered and "a" approves the call once without a grant.
- **APPROVALS-035** For `web_fetch`, "a" shall read "[a] allow <host> for this session" ("for this sub-agent" for a subagent) and grant that host only; when no host name can be taken from the URL (not an http or https URL, or malformed), "[a]" is not offered and "a" or "d" approves the call once without a grant.
- **APPROVALS-036** For a write into a protected path, only "[y]", "[n]" and "[r]" shall be offered; "a" and "d" do nothing.
- **APPROVALS-037** In a sandbox session "d" shall not be offered.
- **APPROVALS-038** While an approval is shown, typed text shall not reach the input box and keys other than the answer keys, the navigation keys of APPROVALS-046 and "Ctrl+C" (APPROVALS-094) shall do nothing, including "Shift+Tab", "Alt+T" and right-click paste on Windows, while the scrolling and search keys (VIEWS-057) keep working; an open find box still receives keys, and the question "sub-agents are still running; exit anyway? (y/n)" takes keys before the approval (SUBAGENTS-075); while a reason is typed, keys go to the reason line (APPROVALS-029), where text editing, "Enter" and "Esc" work and other shortcuts, among them "Shift+Tab", "Alt+T", "Ctrl+O" and "Alt+Up"/"Alt+Q", and right-click paste do nothing, the scrolling and search keys again excepted.
- **APPROVALS-039** Approvals shall wait without a time limit.
- **APPROVALS-040** When the terminal UI exits with approvals pending in any session, Pigeon shall reject them all, giving the model "The terminal UI stopped and closed the approval panel, so this call is treated as rejected."
- **APPROVALS-094** While an approval is shown, a first "Ctrl+C" without a text selection shall change neither the input box nor the approval and show no exit hint, but still count as the first press (see VIEWS-043, VIEWS-044).

## Where approvals appear

- **APPROVALS-041** A main agent's approval shall appear only in its session's main view and that session's full-screen views (rewind list, settings, resume list), not in subagent views, the session panel, read-only views or other sessions; in the session panel letter keys go to the input box.
- **APPROVALS-042** A subagent's approval shall appear in its session's main view, in that session's full-screen views (rewind, settings, resume) and in its own view; answering in any of them settles all.
- **APPROVALS-043** The main view shall show its session's earliest pending approval, the main agent's or any subagent's, and a subagent view that subagent's earliest; approvals of different sessions and subagents wait independently, and while a confirmation of another project's settings is shown, it takes the place of any approval until it is answered.
- **APPROVALS-044** Waiting marks for pending approvals in the session panel and the subagent panel: see PANEL-025, SUBAGENTS-061.
- **APPROVALS-045** The user shall be able to leave a session with a pending approval and answer it after returning.
- **APPROVALS-046** In the main view and subagent views, while an approval is shown, the arrow keys, "Esc", "Enter" on an empty input and "x" in a focused subagent panel shall keep their navigation meaning and "Esc" does not interrupt the turn; while a reason is typed these keys go to the reason line.
- **APPROVALS-047** After an answer, the box shall close and leave one dim line in the raising agent's view, and also in the main view when a subagent's approval was answered there: "✓ approved <tool>: <subject>", "✓ allowed for this session: <tool>" ("this sub-agent" for a subagent) followed by the granted command, host or "in <dir>" when the grant is limited, or "✗ rejected <tool>: <subject> (<reason>)", prefixed "[<path>] " for a subagent; nothing is written when the approval's session is not the current one.
- **APPROVALS-048** When an agent with a pending approval is stopped, or its turn is interrupted from the session panel, Pigeon shall withdraw the approval, leave "withdrawn: <tool> was stopped" (for a subagent "withdrawn: <path> was stopped", without the "[<path>] " prefix) where the answer line would go (APPROVALS-047), and give the model "The request was withdrawn: its agent was stopped".
- **APPROVALS-049** When a call needs approval before the terminal UI's approval panel is attached, it shall be rejected with "No approval panel is attached to the terminal UI, so this call is treated as rejected."

## Session grants

- **APPROVALS-050** A session grant shall match a later call only for the same tool and, when the grant has them, the identical `command` argument, the same host (any case) and a `path` that resolves inside its directory, and, for a call that needs a shell, only when the grant is marked for shell (APPROVALS-051); a call whose command, host or path cannot be determined does not match a grant limited by it.
- **APPROVALS-051** A call that needs a shell shall be covered only by a grant or rule marked for shell.
- **APPROVALS-052** A host grant shall match only that exact host name, not subdomains.
- **APPROVALS-053** A grant shall take effect only after it is recorded in the session; if recording fails, the call is blocked, the conclusion line reads "✗ rejected <tool>: <subject> (grant failed: <message>)", and the model receives "The approval gate failed internally (blocked, fail-closed): …".
- **APPROVALS-054** Session grants shall be active again whenever Pigeon reopens the session: when it is resumed, moved into a worktree, or reopened after a "/reload" or a settings change made in "/config".
- **APPROVALS-055** Revoking, in a subagent view, a grant inherited from the parent shall remove it for that subagent only and for good: when the subagent is resumed it gets the parent's grants of that moment and its own, without the revoked ones.
- **APPROVALS-056** Grant hit counts shall count only calls the grant let through and restart at 0 whenever Pigeon reopens the session: when it is resumed, moved into a worktree, or reopened after a "/reload" or a settings change made in "/config"; "/reload" reopens the sessions of the current project only when their settings changed, and sessions of other projects open in the session panel every time.

## /grants, /revoke and /grants save

- **APPROVALS-057** "/grants" shall list "session grants (N):" with each grant's id, tool, scope, creation time (UTC), hits and first call, then "saved rules (N):" with each rule's label, tool, scope, save time and origin; with neither it adds "(none)".
- **APPROVALS-058** The scope shall read "site <host>", "command <cmd>" (" (via shell)"), "path <dir>" or "all paths".
- **APPROVALS-059** Saved rules shall be listed from all layers, project local first, then project, then user, labelled "config#N", "project#N" and "user#N" with N counting from 0 within each layer.
- **APPROVALS-060** "/revoke grant_<id>" shall end the grant at once, record it in the session and print "revoked <id>"; an unknown id fails with "command failed: grant not found or revoked: <id>", and an id that is not "grant_" followed by a 26-character ULID with "command failed: invalid ID: expected \"grant_\" + 26-char ULID, got \"<id>\"".
- **APPROVALS-061** "/revoke config#N" shall remove the rule that "/grants" shows as config#N from `.pigeon/settings.local.json` and print "removed config#N" with that rule's tool and scope; when "/grants" shows no config#N it shall refuse with "unknown grant: config#N", and when the file's rule N differs from that rule, it shall refuse, change nothing and say that the saved rules changed; the session keeps applying the rule until its settings are read again (at restart, by "/reload" or after a change made in "/config").
- **APPROVALS-062** An id that neither starts with "grant_" nor has the form config#N shall fail with "can't revoke <id>: not a grant_ id or config#N"; project and user rules cannot be revoked by command.
- **APPROVALS-063** "/grants save <grantId>" shall append the grant with its origin (including the first call's full arguments) to `permissions.grants` in `.pigeon/settings.local.json` and print "saved <grantId> → .pigeon/settings.local.json"; it applies from the next start or "/reload", and an unknown id fails with "command failed: grant not found or revoked: <id>".
- **APPROVALS-064** Saving a grant twice shall fail with "command failed: grant <id> already saved as config#N" and change nothing.
- **APPROVALS-065** "/grants save" and "/revoke config#N" shall replace the file in one step, keeping its other sections; while another window writes it, they fail with "command failed: saved rules are being written by another window".
- **APPROVALS-066** Creating the local settings file inside a git repository shall add it to the user's global git excludes when not already ignored.
- **APPROVALS-067** While a turn runs, "/grants" shall work and "/revoke" and "/grants save" are refused with "can't use /<command> while running" (see SUBAGENTS-070).

## Saved rules

- **APPROVALS-068** Saved rules from all layers shall apply together, rules in the project layer and in a git-tracked `.pigeon/settings.local.json` once confirmed (see SETTINGS-031, SETTINGS-032), and match like session grants.
- **APPROVALS-069** Saved rules are read with the session's settings and change only on restart, "/reload" or a change made in "/config": see SETTINGS-026.
- **APPROVALS-070** A saved rule shall have `tool` and `promotedFrom` (with `grantId`, `sessionId`, `firstCall` with `toolCallId` and `args`, and `promotedAt`) and may have `pathPrefix`, `command`, `shell` and `host`; a rule with any other field, missing a required field, with a value of the wrong type, an empty string, a malformed grant or session id, or a `promotedAt` that is not a whole number of at least 0 makes the settings fail to load with an error "settings file <file> (<layer>): …" that names the rule's position in `permissions.grants` and, for another field, that field.
- **APPROVALS-071** `permissions.readDeny` entries shall load but have no effect.

## Workspace fence

- **APPROVALS-072** In "ask", `read_file` of a path whose real location is outside the workspace shall need approval, with "a" granting the tool and "d" the directory.
- **APPROVALS-073** In "bypass", reads outside the workspace shall be allowed without asking, including files such as `~/.ssh`.
- **APPROVALS-074** Without an approval channel or bypass, a read outside the workspace shall be refused before the tool runs with "Reading files outside the workspace requires human approval, and this run has no approval channel; refused: <real path>", unless a saved rule matches or a `PreToolUse` hook allows it.
- **APPROVALS-075** Approving an outside read with "y" shall cover only that call; a grant from "a" or "d" lets later matching reads outside the workspace run without asking.
- **APPROVALS-076** `write_file` and `edit_file` refusing paths outside the workspace: see TOOLS-032.
- **APPROVALS-077** In "ask", a write outside the workspace shall be refused before an approval is shown, so no answer key, "a" included, grants it; switching to "bypass" makes such writes possible at once (see APPROVALS-009, TOOLS-032).
- **APPROVALS-078** Writes into `.git` and to symbolic links refused in every mode: see TOOLS-030.

## Protected paths

- **APPROVALS-079** In "ask", a write by `write_file` or `edit_file` into a protected `.pigeon` directory (APPROVALS-081) shall need a person's approval each time, even when a session grant, saved rule or `PreToolUse` hook would allow it; in "bypass" it is allowed without asking unless a `PreToolUse` hook denies it or asks.
- **APPROVALS-080** The check shall follow symbolic links and count a path that resolves into `.pigeon` or into the directory `.pigeon` links to; outside a sandbox it ignores case when the workspace's file system is case-insensitive.
- **APPROVALS-081** Pigeon shall check a path inside the workspace against the workspace's own `.pigeon` and a path outside it against the project's `.pigeon`; in a sandbox session the check is made inside the container against the container workspace's `.pigeon`.
- **APPROVALS-082** Without an approval channel, a protected-path write shall be refused with the text of APPROVALS-015 outside bypass, even when a saved rule or `PreToolUse` hook would allow it, and in bypass when a `PreToolUse` hook asks.
- **APPROVALS-083** Writes by `run_command` shall not be checked against protected paths.

## Confirming project grant rules

- **APPROVALS-084** User-layer rules and rules in an untracked `.pigeon/settings.local.json` shall apply without confirmation (see SETTINGS-031).
- **APPROVALS-085** Rules in a git-tracked `.pigeon/settings.local.json` needing confirmation: see SETTINGS-032.
- **APPROVALS-086** How pending rules are identified and listed: see SETTINGS-035.
- **APPROVALS-087** When unconfirmed rules are confirmed: see SETTINGS-036.
- **APPROVALS-088** Projects inside `trustedDirectories` skipping confirmation: see SETTINGS-034.

## MCP tiers

- **APPROVALS-089** An MCP tool shall take the tier set in `mcp.servers.<server>.tools.<tool>.tier`, else the server's `defaultTier`, else writing, adjusted by its annotations (APPROVALS-090) and within the limits of APPROVALS-091; the tiers rank `read` below `write` below `exec`.
- **APPROVALS-090** An MCP tool configured as reading shall be treated as writing unless its annotations mark it read-only (`readOnlyHint: true`) or not destructive (`destructiveHint: false`), a tool without annotations counting as possibly destructive as in the MCP specification; a tool marked read-only but configured higher keeps its configured tier; a tool configured as reading whose annotations mark it destructive, and a tool marked read-only but configured higher, are reported at startup as "MCP annotation conflicts with settings: …", while a tier set for a tool without annotations is not reported.
- **APPROVALS-091** For an MCP server defined in the user layer or an untracked `.pigeon/settings.local.json`, also when a project file defines it too, the project layer and a git-tracked `.pigeon/settings.local.json` shall only raise its tiers: a `defaultTier` or `tools.<tool>.tier` there below the tier the personal layers give (writing when they set none) shall not take effect.
- **APPROVALS-095** For an MCP server defined in the project layer, a git-tracked `.pigeon/settings.local.json` or `.mcp.json`, the tiers set for it in those files shall be part of its "MCP server" confirmation entry (see SETTINGS-031): they appear in its summary, and changing them makes the entry unconfirmed again.

## Subagents

- **APPROVALS-092** A subagent shall start with its parent's grants at that moment; grants given in its approvals apply only to it.
- **APPROVALS-093** Subagent calls that need a person in `pigeon run`: see APPROVALS-015.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `permissions.grants` | `[]` | Saved rules: `tool`, `promotedFrom`, optional `pathPrefix`, `command`, `shell`, `host`; any other field fails loading. |
| `mcp.servers.<name>.defaultTier` | `"write"` | Tier (`read`, `write`, `exec`) of the server's unlisted tools. |
| `mcp.servers.<name>.tools.<tool>.tier` | — | Tier of one MCP tool. |
| `trustedDirectories` | `[]` | User layer; projects inside skip rule confirmation. |
| `keybindings."pigeon.toggleMode"` | `shift+tab` | Switch approval mode. |
| `keybindings."pigeon.approval.*"` | `y` `n` `r` `a` `d` | Answer keys. |

Flags: `--yolo`, `--sandbox-approval yolo|prompt`, `--trust-config` (`pigeon run`).

## Known limitations

- There is no user-configurable deny list; blocking calls takes a `PreToolUse` hook.
- Three rejections of the same call, or three policy refusals of one tool, in a run stop the whole run; the threshold is fixed.
- A saved rule with `pathPrefix` that applies to a sandbox session stops it from starting with "path-scoped grant rules are not supported in a container workspace: …".
- "/grants save" stores the first call's full arguments, which may be large or sensitive.
- A grant for an exact command made through a short name keeps matching if the short name's definition later changes.
- Protected paths cover only the project's `.pigeon`, not `~/.pigeon`.
