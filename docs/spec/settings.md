# Settings

Purpose: where Pigeon's settings live and how they combine, how they are validated, when
they are read, which entries need the user's confirmation before they take effect, and how
the user changes them inside the terminal UI with "/config", "/reload" and key bindings.

## Layers and merging

- **SETTINGS-001** Pigeon shall read settings from `~/.pigeon/settings.json` (user), `.pigeon/settings.json` (project, may be committed) and `.pigeon/settings.local.json` (project local), with precedence project local over project over user.
- **SETTINGS-002** A missing settings file shall count as an empty layer without error.
- **SETTINGS-003** Apart from the cases in SETTINGS-004 to SETTINGS-007 and key bindings (SETTINGS-074), objects shall merge key by key, and scalars and arrays from a higher layer shall replace lower ones as a whole.
- **SETTINGS-004** Grant rules from all layers apply together: see APPROVALS-068.
- **SETTINGS-005** Hooks from all layers apply side by side: see HOOKS-006.
- **SETTINGS-006** `disableAllHooks` (default `false`) and `stopHookBlockCap` (default `8`) shall be taken from the highest layer that sets them.
- **SETTINGS-007** `trustedDirectories` shall be taken only from the user layer.
- **SETTINGS-008** The project's `.mcp.json` at the project root shall be read together with the settings files.

## Home directory

- **SETTINGS-009** When the project's `.pigeon` directory is the user's `~/.pigeon` (the project root is the home directory, or `.pigeon` links there), Pigeon shall read only the user and project-local layers, treating the shared file as user settings.
- **SETTINGS-010** In that case `trustedDirectories` and `keybindings` in `~/.pigeon/settings.json` shall be accepted as user settings.
- **SETTINGS-011** On Windows the comparison of the two directories shall ignore case.

## Validation

- **SETTINGS-012** Pigeon shall ignore a leading UTF-8 byte-order mark in settings files and `.mcp.json`.
- **SETTINGS-013** A settings file that is not valid JSON shall stop startup with "settings file <file> (<layer>) is not valid JSON: <message> (<path>)", where the layer is "user settings", "project settings" or "project local settings".
- **SETTINGS-014** A top level that is not an object shall fail with "settings file <file> (<layer>): top level must be an object".
- **SETTINGS-015** An unknown top-level key shall fail with "settings file <file> (<layer>): unknown key <key> (valid: …)" listing the accepted keys; an unknown key directly inside a section other than `keybindings` fails with "settings file <file> (<layer>): unknown key <key> in <section> (valid: …)".
- **SETTINGS-016** A section that is not an object shall fail with "settings file <file> (<layer>): <section> must be an object".
- **SETTINGS-017** Pigeon shall accept a top-level `$schema` string in every settings layer and otherwise ignore it.
- **SETTINGS-018** A top-level `messaging` or `orchestration` section shall fail with "settings file <file> (<layer>): <section> has been removed; delete this section", adding " (taskList is now tools.taskList)" when `orchestration` has `taskList`; a `roles` key in `commands` fails with "settings file <file> (<layer>): commands.roles has been removed; delete it".
- **SETTINGS-019** When a file has none of the problems in SETTINGS-014 to SETTINGS-022 or HOOKS-004 but a value has the wrong type or is out of range, Pigeon shall fail with "settings file <file> (<layer>): <pointer>: <message>", where <pointer> is the value's JSON pointer such as `/loopGuard/remindAt`. All problems found in one file shall be joined by "; " into one message followed by " (<path>)" with the file's full path.
- **SETTINGS-020** `web.search.zai.apiKey` or `web.search.tavily.apiKey` in a settings file shall fail with "settings file <file> (<layer>): web.search.<backend>.apiKey is not allowed in settings files; the key is read from <ENV>" (`ZAI_API_KEY` or `TAVILY_API_KEY`).
- **SETTINGS-021** `trustedDirectories` in a project layer shall fail with "… trustedDirectories is only allowed in user settings"; an entry that is not absolute, `~`, or starting with `~/` fails with "… trustedDirectories entry <dir> must be an absolute path or start with ~".
- **SETTINGS-022** A `keybindings` key that is not shaped like an action name (`pigeon.*` or `tui.*`) shall fail with "… keybindings key <key> is not an action name (like pigeon.toggleToolOutput or tui.editor.undo)"; values are a key or an array of keys.
- **SETTINGS-023** After every layer is valid, Pigeon shall check the merged settings and fail with "merged settings invalid: <problems>", each problem prefixed by its section (`commands:`, `loopGuard:`, `repetitionGuard:`, `sandbox:`, `mcp:`) and joined by "; " (see TOOLS-095, CONTEXT-056, CONTEXT-068, SANDBOX-019).
- **SETTINGS-024** A settings error at startup shall stop Pigeon before any session opens (see CLI-007).
- **SETTINGS-025** When `.pigeon/` holds `mcp.json`, `grants.json`, `commands.json`, `orchestration.json`, `web.json`, `sandbox.json`, `loop-guard.json`, `sessions`, `tui-history.json`, `pi-debug.log`, `pi-crash.log`, `verify.json`, `memory-review.json`, `memory`, `review-backfill`, `learned` or `learned.lock` (the last three also under `.pigeon/state/`), or when `~/.pigeon/preferences.md` exists, the terminal UI and `pigeon run` shall refuse to start with a message starting "legacy config layout found; not migrated automatically:" and ending "run pigeon migrate-config in the project root first".

## Snapshot

- **SETTINGS-026** Pigeon shall read the settings once when it starts, and once for each other project when the first session of that project opens in the process; all sessions of a project in the process shall use that snapshot, including its hooks and saved grant rules, and edits to the files take effect only after a restart, "/reload" or a "/config" change.
- **SETTINGS-027** The content of the project Dockerfile named by `sandbox.dockerfile` shall be read with the snapshot; a missing file is not an error.
- **SETTINGS-028** A subagent shall use the snapshot its session has when the subagent starts, and the sandbox container shall be set up from the snapshot read at startup; neither reads the settings files again or asks for confirmation (for "/reload" in a sandbox session see SANDBOX-071).
- **SETTINGS-029** When a session of another project is opened in the same process (from the session panel's work list, or with "/new <path>"), Pigeon shall read and confirm that project's settings the first time and reuse them for its later sessions until "/reload" or a "/config" change reads them again.
- **SETTINGS-030** When the other project's settings fail to load (any error in SETTINGS-013 to SETTINGS-025), its `.mcp.json` is invalid, or the record of what was confirmed for it is damaged, Pigeon shall not open the session and report "can't open <name>: <reason>" for a work-list session, or "new failed: <reason>" for "/new <path>".

## Confirming settings that run commands or grant permissions

- **SETTINGS-031** Pigeon shall require confirmation for each entry that runs commands or grants permissions and whose content differs from what was last confirmed for this project, including new ones: each command short name, each MCP server launch definition, each hook (none while hooks are disabled, see HOOKS-064), each grant rule from the project layer, and, in a session that starts a sandbox (`pigeon --sandbox`, `pigeon run --sandbox`), the `sandbox` section with its Dockerfile. Any change to an entry's content makes it unconfirmed again; grant rules from the user layer and an untracked `.pigeon/settings.local.json` apply without confirmation.
- **SETTINGS-032** When `.pigeon/settings.local.json` is tracked by git, its grant rules shall need confirmation like project-layer rules.
- **SETTINGS-033** Identical hooks or rules from different layers shall be listed once.
- **SETTINGS-034** When the project lies inside a `trustedDirectories` entry (`~` expanded; case-insensitive on Windows and macOS), no confirmation shall be asked.
- **SETTINGS-035** Each pending entry shall be listed as "[<origin>] <kind> <id>: <summary>", with kinds `command`, `sandbox`, `MCP server`, `permission rule` and `hook`; <origin> is the layer ("user settings", "project settings", "project local settings", several joined by ", ") or ".mcp.json".
- **SETTINGS-036** With pending entries, the terminal UI shall ask before entering full screen: "new or changed settings that run commands or grant permissions:", the entries, and "a trust all | s skip this time | q quit", repeating until it gets `a`, `s` or `q`.
- **SETTINGS-037** On `a`, Pigeon shall record the confirmed content for this project and not ask again for the same content.
- **SETTINGS-038** On `s`, Pigeon shall run the session without those entries and record nothing; once the terminal UI starts, the message area shows the dim line "not using unconfirmed settings: <kind>:<id>, …", where <kind> is `command`, `sandbox`, `mcp-server`, `permission` or `hook` and <id> is the identifier shown for the entry in the list.
- **SETTINGS-039** On `q`, Pigeon shall exit with "settings that run commands or grant permissions not confirmed; exited".
- **SETTINGS-040** In `pigeon run` with pending entries, Pigeon shall exit with code 1 before running, printing "unconfirmed settings that run commands or grant permissions:", the entries, and "--trust-config allows them for this run only"; with `--trust-config` it runs with them and records nothing.
- **SETTINGS-041** A corrupt confirmation record shall fail with "trust record <file> is not valid JSON: …" or "trust record <file> is malformed" rather than being treated as empty.
- **SETTINGS-042** When a session of another project with pending entries is opened in the UI, the entries shall be shown in the approval area with the project path and "a trust all | s skip this time"; afterwards a line "trusted settings in <root>" or "skipped unconfirmed settings in <root>" remains.

## /reload

- **SETTINGS-043** "/reload" shall re-read the settings files and `.mcp.json` and print "settings unchanged" or "settings reloaded: <sections> changed".
- **SETTINGS-044** When "/reload" finds changed settings, the current session shall be reloaded in place and use them from its next turn (its approval mode: see APPROVALS-007); when reading or reloading fails, the session keeps its previous settings and Pigeon reports "reloading settings failed: <reason>".
- **SETTINGS-045** When changed entries need confirmation, "/reload" shall apply nothing yet and print "changed settings that run commands or grant permissions:", the entries, and "/reload confirm to apply | /reload skip to skip".
- **SETTINGS-046** "/reload confirm" shall apply the entries and record them only after the session has been reloaded successfully.
- **SETTINGS-047** "/reload skip" shall keep the previous content of each changed command short name, MCP server and `sandbox` section, keep in effect the hooks that were in effect and are gone or changed in the new settings, leave new commands, servers, new and changed hooks and a new `sandbox` section disabled and new or changed grant rules unused for this session, and print a line that names the entries kept as before and the grant rules not applied in this session.
- **SETTINGS-048** "/reload confirm" or "/reload skip" with nothing pending shall print "nothing pending to confirm"; other arguments print "usage: /reload | /reload confirm | /reload skip".
- **SETTINGS-049** When the pending reload belongs to another project than the current session's, confirm and skip shall discard it with "the pending reload is for another project; run /reload again".
- **SETTINGS-050** When "/reload" reloads the session (SETTINGS-044), Pigeon shall keep the connection of each MCP server that is still connected and whose launch definition and workspace root are unchanged, restart every other server that stays in the settings, stop servers taken out of the settings and start new ones, and print "MCP servers: restarted <names>; stopped <names>; started <names>" with the parts that apply, where the restarted names are the servers whose launch definition changed; the MCP tools offered change only through these restarts, stops and starts, and a "/reload" that finds no change restarts nothing.
- **SETTINGS-051** The system prompt across "/reload": see CONTEXT-090.
- **SETTINGS-052** "/reload" shall be refused with "can't use /reload while running" while a turn, compaction, settings reload, session switch or rewind is in progress, and with "sub-agents are running" while subagents of the current session run.
- **SETTINGS-053** "/reload" shall also apply to the other open sessions: same-project sessions in the session panel are reloaded when idle (a running one after its turn, once its subagents have stopped), and sessions of other projects re-read their own project's settings, asking in the approval area about entries that need confirmation (`s` keeps the previous content as "/reload skip" does); a failure to reload a same-project session shows "reloading settings failed: <reason>" in that session, and a failure for another project shows "reloading settings in <root> failed: <reason>".
- **SETTINGS-054** After "/reload", and when the current session changes to a session of another project, key bindings shall be reinstalled from that settings snapshot (wheel scrolling: see VIEWS-056).

## /config

- **SETTINGS-055** "/config" shall open a full-screen settings view headed "settings (user level, ~/.pigeon/settings.json)" with tabs `model`, `web`, `context`, `tools`, `agents`, `guards & hooks`, `workspace`, `interface` and `keys`; "←"/"→" or "Tab" switch tabs (wrapping around), and "Esc" closes the view and returns to the sub-agent view it was opened from, otherwise to the main view.
- **SETTINGS-056** Each option shall show its label, the user-level value ("default" when unset) and its default, with a dim description line; an option overridden by a project layer is marked " (overridden)" with the overriding layer and effective value, and a git-tracked local file counts as project settings.
- **SETTINGS-057** The effective value shown shall be the one in the settings the current session uses, ignoring launch flags such as `--thinking` or `--no-web`.
- **SETTINGS-058** The view shall list only simple options (switches, choices, numbers, short strings), not MCP, hooks, commands, permissions, trusted directories, lists or free-text addresses.
- **SETTINGS-059** "↑"/"↓" shall select an option and "Enter" start editing it: a choice shows the value being chosen as ‹value› and "←"/"→" cycle through "default" and the allowed values; a number or string is typed in place (empty means default); "Enter" saves, "Esc" cancels, and "↑"/"↓" do not move the selection while editing.
- **SETTINGS-080** Below the heading, the settings view shall show one dim line with the keys of its current state: "↑/↓ select · Enter edit · ←/→ group · Esc close" while browsing, "←/→ change · Enter save · Esc cancel" while editing a choice, "type a value · Backspace delete · Enter save · Esc cancel" while typing a value, and "press a key · Backspace clear · Esc cancel" while waiting for a new key.
- **SETTINGS-060** Saving an unchanged value shall not write the file.
- **SETTINGS-061** Changes shall be written only to `~/.pigeon/settings.json`, keeping its other content, removing the key (and emptied parents) for "default", and creating the file only when a non-default value is set.
- **SETTINGS-062** A value out of range, not an integer where required, not an allowed word (case-sensitive), longer than 200 characters or of the wrong format shall be rejected and not written, with "<id> must be one of <values>", "<id> must be an integer <range> or default" (or "a number"), or "<id>: <value> is not a valid value (<description>)".
- **SETTINGS-063** Before writing, Pigeon shall check the new user file and the merge of all layers, refusing with "user settings would be invalid; not written: …" or "would make the settings invalid; not written: …".
- **SETTINGS-064** Pigeon shall not change a user settings file that is a symbolic link, a directory, read-only, invalid JSON or not an object, refusing with "<path> is a symlink; not changed", "<path> is a directory; not changed", "<path> is read-only; not changed", "<path> is not valid JSON: <message>" or "<path>: top level is not an object; not changed".
- **SETTINGS-065** In the view, errors shall appear on its bottom line: a value that is rejected or cannot be written, and a change refused while subagents run, are prefixed "not changed: "; other messages, such as "that key can't be bound" or "reloading settings failed: <reason>", appear as they are. Successful saves add nothing to the message area, and the view stays on the same option with refreshed values.
- **SETTINGS-066** Each saved change shall be followed by the same reload as "/reload" for all open sessions; when that reload finds entries that need confirmation, they are listed on the view's bottom line (in the message area for "/config <id>=<value>") and wait for "/reload confirm" or "/reload skip".
- **SETTINGS-067** In a session without a sandbox, a change to `sandbox.memory`, `sandbox.pids` or `sandbox.cpus` made with "/config" shall take effect without confirmation; a session that starts a sandbox asks to confirm the changed `sandbox` section as usual (SETTINGS-031).
- **SETTINGS-068** "/config <id>=<value>" shall change one option and print "<id> = <value> (written to user settings)" or "<id> is already <value>", adding ", but <layer> override it" (inside the parentheses in the first form) when overridden; a malformed argument prints "usage: /config [key=value]" and an unknown id "not changed: unknown option: <id>".
- **SETTINGS-069** While the current session is busy (as in VIEWS-038), "/config" shall open for viewing; changes are refused with "running; change settings later" while the session is busy or a settings reload is in progress, and with "not changed: sub-agents are running" while subagents of the current session run.
- **SETTINGS-070** When reading settings for the view fails, Pigeon shall print "reading settings failed: <reason>" and not open the view.
- **SETTINGS-071** Input queued while the settings view is open: see VIEWS-050.
- **SETTINGS-072** When the view does not fit the window, it shall scroll to keep the selected option and its description visible.

## Key bindings

- **SETTINGS-073** The `keybindings` section shall map action names to a key or an array of keys; an empty array unbinds the action; unconfigured actions keep their defaults.
- **SETTINGS-074** Key bindings shall be taken only from the user layer; bindings in the project layer or in `.pigeon/settings.local.json` are ignored, and Pigeon says "keybindings in <file> are ignored" once at startup, once at "/reload" and once when the session changes to another project, naming each file whose bindings were ignored.
- **SETTINGS-075** An unknown action name shall be ignored with "keybindings: unknown action <id>; ignored"; when one key is bound to two approval-prompt actions (`pigeon.approval.*`), or to two other Pigeon actions, Pigeon shows "keybinding conflict: <key> is bound to <a>, <b>"; both lines go to the message area.
- **SETTINGS-076** For Pigeon's actions (`pigeon.*`), single-letter keys shall match regardless of case, and key releases or repeats shall not count as presses.
- **SETTINGS-077** The `keys` tab shall list each action with its effective keys ("(none)" when unbound), its default, and "conflicts with <actions>" when another action in its group shares a key; it shows only bindings from the user layer, so bindings in the project layer or `.pigeon/settings.local.json` neither appear nor are marked.
- **SETTINGS-078** In the `keys` tab, "Enter" shall wait for a new key for the selected action, showing "(press a key)" in its row, and bind the next key pressed (including "Shift+Tab" and "Ctrl+X") except the key bound to `pigeon.exit` ("Ctrl+C" by default), which is not bound and counts as an exit press, and the scrolling and search keys (VIEWS-057), which keep working and are not bound; while waiting, "Esc" cancels and "Backspace" leaves the action without keys; otherwise "Delete" restores the default. A key that cannot be bound shows "that key can't be bound", and changes go to the user layer.
- **SETTINGS-079** The approval prompt names the keys currently bound: see APPROVALS-025.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `$schema` | none | Ignored schema reference. |
| `trustedDirectories` | `[]` | User layer only; projects inside need no confirmation. |
| `keybindings.<action>` | see Views | Key or keys for an action; `[]` unbinds. |
| `modelInfo.models."<provider>/<model>"` | none | Overrides for that model: `contextWindow`, `maxTokens`, prices (`cost`, all four prices and `currency`) and prompt caching (`cache`); keys not shaped "<provider>/<model>" are rejected. |

Other sections are specified in the area they configure: `permissions` (Approvals), `hooks`, `disableAllHooks`, `stopHookBlockCap` (Hooks), `sandbox`, `snapshot` (Sandbox, Sessions), `memory`, `sessionSearch` (Memory), `tools`, `commands`, `web`, `mcp` (Tools), `agents` (Subagents), `worktree` (Worktrees), `thinking`, `tui` (Views, Panel), `loopGuard`, `contextPrune`, `truncationContinuation`, `repetitionGuard`, `modelRequest` (Context).

Flag: `--trust-config` (`pigeon run`, this run only).

## Known limitations

- Confirming while another window writes the confirmation record fails instead of waiting.
- `~\path` in `trustedDirectories` is rejected on Windows; only `~` and `~/` expand.
- "/config" rewrites the whole user file as 2-space JSON, dropping its byte-order mark and layout.
- "/config <id>=<value>" accepts no spaces in the value and cannot set key bindings.
- A misplaced `apiKey` for the DeepSeek search backend gets a generic error without naming the environment variable.
- Only the first invalid layer is reported per start.
- Edits made while "/reload" waits for confirmation need another "/reload".
- After each reload, key-binding warnings are written to the message area again.
