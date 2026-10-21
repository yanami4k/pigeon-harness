# Memory

Purpose: how Pigeon gives the model persistent context across sessions. Three sources:
human-written instruction files (AGENTS.md), learned memory that the model records and
Pigeon pushes into every session, and session search tools the model uses to pull facts
from earlier sessions of the same project.

## Instruction files

- **MEMORY-001** Pigeon shall read the user-level instructions file `~/.pigeon/AGENTS.md` and, for the project, one instructions file per directory level from the repository root down to the working directory; it shall not read project instruction files above the repository root.
- **MEMORY-002** At each directory level Pigeon shall read `AGENTS.md`; when a level has no `AGENTS.md` but has `CLAUDE.md`, Pigeon shall read `CLAUDE.md` instead.
- **MEMORY-003** Pigeon shall treat the nearest ancestor of the working directory that contains a `.git` entry (directory or file) as the repository root; outside a git repository it shall read only the working directory's own level.
- **MEMORY-004** Pigeon shall concatenate the files user-level first, then project files from the repository root downward, each under a heading `### <path>` (the user file shown as `~/.pigeon/AGENTS.md`, project files relative to the repository root).
- **MEMORY-005** Pigeon shall cap the combined instructions at 32 KiB of UTF-8; the file that crosses the cap is included only up to the bytes that fit, without splitting a character, and later files are left out.
- **MEMORY-006** When the cap is exceeded, Pigeon shall tell the model which files were truncated or "not included" and that `read_file` gives the full text, and shall show the user one line starting "[instructions] AGENTS.md files over the 32 KiB limit; truncated:".
- **MEMORY-007** When at least one instructions file exists, the startup status shall contain a "Project instructions (AGENTS.md)" section with them; with no file the section is absent (see CONTEXT-080).
- **MEMORY-008** Pigeon shall re-read the instruction files during a session and send changed instructions as a replacement section, or "There are no project instructions now." when all files were removed (see CONTEXT-081, CONTEXT-082).
- **MEMORY-009** In a sandbox session, Pigeon shall read the instruction files from the host-side project, not from inside the container.

## Learned memory: storage

- **MEMORY-010** Pigeon shall keep learned memory in two layers: project memory in `.pigeon/state/memory.md` (this project only) and user memory in `~/.pigeon/state/memory.md` (all projects).
- **MEMORY-011** A memory file shall consist of a free-form header followed by one entry per line, `- [<ID>] <content> (recorded <YYYY-MM-DD> · <source> · session <session ID>)`, with IDs `P<n>` in the project layer and `U<n>` in the user layer; the trailing origin part is optional for hand-written entries.
- **MEMORY-012** When Pigeon creates a memory file it shall write the header `# Learned memory (this project)` or `# Learned memory (all projects)` with a comment saying the file is maintained by `update_memory` and editable with "/memory edit project" or "/memory edit user"; an existing header shall be kept verbatim.
- **MEMORY-013** Pigeon shall read as an entry's origin only the last `(recorded …)` group, and only when it ends the line; look-alike parentheses earlier in the line shall stay part of the content.
- **MEMORY-014** Pigeon shall treat a memory file as malformed when any line from the first line starting "- " to the last non-blank line is not a valid entry for its layer (wrong prefix; missing or duplicate ID, or an ID that is not a positive whole number written without leading zeros; empty content; stray or blank line), and shall report the first offending line number; blank lines after the last entry are allowed.
- **MEMORY-015** Pigeon shall parse memory files saved with CRLF line endings; files written by `update_memory` shall use LF and, when they have entries, end with exactly one newline, while a "/memory edit" save keeps the draft as written; the pushed section and the "/memory" listing shall show and count the text with line endings converted to LF.
- **MEMORY-016** Reading a memory file shall not rewrite it; a closing parenthesised part that does not match `(recorded <YYYY-MM-DD> · <source> · session <session ID>)` shall be read as part of the entry content, and a header that differs from Pigeon's is kept as it is (see MEMORY-012).
- **MEMORY-017** Each layer shall have a size limit in characters (Unicode code points) counted over entry lines only, each with its origin tail and newline; the header does not count.
- **MEMORY-018** Pigeon shall not assign an entry ID again within a layer once it has been assigned by `update_memory` or saved through "/memory edit", even after the entry is removed; an ID added and removed again by editing the file directly, outside "/memory edit", is not tracked.
- **MEMORY-019** Writes to a memory layer shall be serialized across processes and written atomically; concurrent writers shall neither lose nor duplicate entries.

## The update_memory tool

- **MEMORY-020** Pigeon shall offer `update_memory` only in terminal-UI sessions with pushed memory on: the main session, sessions opened from the session panel (fork sessions included) and sandbox sessions; `pigeon run` and subagents shall receive pushed memory without the tool.
- **MEMORY-021** `update_memory` shall take `action` (`add`, `replace`, `remove`), `layer` (`project` or `user`) and optional `id` and `content`; its replies shall not contain entry contents.
- **MEMORY-022** `update_memory` shall change only the target layer's memory file and the bookkeeping files beside it (`memory.md.maxid`, `memory.lock`), apart from setting up the project's `.pigeon/state` directory on first use, which in a git repository also appends to the user's global git excludes file the ignore rules git does not yet apply.
- **MEMORY-023** On `add`, Pigeon shall store the content as one line (line breaks, including U+2028 and U+2029, collapsed to single spaces, then trimmed) and append the ID, the local date, the source `tui` and the session ID; it replies "Added <ID> to the <layer> memory (now <used>/<limit> characters)."
- **MEMORY-024** When added content is identical to an existing entry in the same layer, Pigeon shall not add it and shall reply "Same content as <ID> in the <layer> memory; not added."
- **MEMORY-025** On `replace` and `remove`, Pigeon shall accept the ID as `P3`, `p3` or `3`; once the call has passed the checks of MEMORY-027, MEMORY-031, MEMORY-032 and MEMORY-054, an unknown, malformed or missing ID, or one with the other layer's prefix, gets "The <layer> memory has no <id>; existing entry IDs: <list>." (the ID as given; "(no entries)" for an empty layer) and nothing is written.
- **MEMORY-026** `replace` shall rewrite the entry with new content and a fresh origin (same ID) and `remove` shall delete it, replying "Replaced <ID> in the <layer> memory (now …/… characters)." and "Removed <ID> from the <layer> memory (now …/… characters)."
- **MEMORY-027** When `add` or `replace` has no content once line breaks are collapsed and the text trimmed, `update_memory` shall reply "add and replace need content: one sentence stating what to remember." and write nothing; a call without a valid `action` or `layer` shall fail argument validation before the tool runs.
- **MEMORY-028** When an `add` would push the layer over its limit, Pigeon shall reject it, stating current usage, the characters the entry needs, the shortfall, advice to shorten, merge or remove, and the existing entries with their sizes.
- **MEMORY-029** When a `replace` would grow a layer beyond its limit, Pigeon shall reject it with the entry's old and new sizes, the total after replacing against the limit, the overflow and the existing entries with their sizes; a replacement whose entry line, with its new origin, is not longer than the original shall not be rejected for the limit, even in a layer already over its limit.
- **MEMORY-030** The two layers' limits shall be checked independently.
- **MEMORY-031** When the target memory file is malformed, `update_memory` shall leave it untouched and reply that the file "is malformed from line <n> on", asking the user to fix it with "/memory edit <layer>".
- **MEMORY-032** When the layer cannot be locked within 10 seconds, `update_memory` shall not write and reply "The <layer> memory file is being written by another session, so this write did not happen; you can retry later."
- **MEMORY-033** Pigeon shall not echo entries the model wrote itself back into the conversation as a status update, in the same session, after "/reload" or after resume.
- **MEMORY-034** After a successful `update_memory` write the terminal UI shall add no separate message line; what was written is visible in the tool call itself.

## Pushed memory

- **MEMORY-035** When pushed memory is on, Pigeon shall read the available layers (both, or only user memory as in MEMORY-054) at session start and deliver them unfiltered as the "Learned memory" section of the startup status (see CONTEXT-080), except that a session without `update_memory` omits the section when both layers are empty (MEMORY-039).
- **MEMORY-036** Each pushed layer shall appear under `### This project (project, .pigeon/state/memory.md): <n> entries, <used>/<limit> characters` or `### All projects (user, ~/.pigeon/state/memory.md): …` followed by its entry lines verbatim apart from line endings; an empty layer shows "no entries" and its limit.
- **MEMORY-037** Pigeon shall push a malformed memory file's entry lines verbatim.
- **MEMORY-038** In a session with `update_memory`, the pushed section shall ask the model to record corrections, preferences and off-code project facts in the same reply, and to point out a conflicting entry and ask whether it applies once or from now on, to this project or all; the section is pushed even when both layers are empty.
- **MEMORY-039** In a session without `update_memory`, the pushed section shall tell the model to follow the current task on conflict and then name the conflicting entry, with no write guidance, and shall be omitted when both layers are empty.
- **MEMORY-040** The pushed section shall tell the model that entries are reference material, that the current code wins on the state of the code, and that human-written instructions win over conflicting entries.
- **MEMORY-041** Pigeon shall re-read the pushed layers during a session; a change made through "/memory edit", by another session or by editing the file directly shall reach the model as a replacement "Learned memory" section (see CONTEXT-081, CONTEXT-082), also when this session's own `update_memory` write succeeds before the change was delivered.
- **MEMORY-042** The `--no-pushed-memory` flag of `pigeon`, `pigeon resume` and `pigeon run` shall turn off pushed memory and `update_memory` for that run; pushed memory is on by default.
- **MEMORY-043** The system prompt's note that startup-status text is reference attached by Pigeon and the user's request wins on conflict: see CONTEXT-089.
- **MEMORY-044** An entry recorded in one session shall appear in the next session's pushed section with its layer, source, date and session ID.

## The /memory command

- **MEMORY-045** "/memory" shall list each available layer as `<layer> memory (<display path>, <absolute path>): <n> entries, <used>/<limit> chars` followed by its entry lines, or "no entries" with the limit; a malformed layer adds "bad format from line <n>; update_memory refuses this layer".
- **MEMORY-046** "/memory" and "/memory edit" shall act on the project of the session being viewed, also from a subagent view; "/memory" works while a run is in progress, "/memory edit" is rejected with "can't use /memory edit while running".
- **MEMORY-047** Any other argument form shall print "usage: /memory | /memory edit project|user".
- **MEMORY-048** "/memory edit <layer>" shall copy the layer (or the default header when the file does not exist) to a draft `<memory file>.edit.md` next to the memory file and open it with `$VISUAL`, else `$EDITOR` (which may carry arguments), suspending the full-screen UI while the editor runs.
- **MEMORY-049** When neither `$VISUAL` nor `$EDITOR` is set, "/memory edit" shall reply "no editor set ($VISUAL/$EDITOR); edit <absolute path> directly" and open nothing.
- **MEMORY-050** When the editor exits with the draft unchanged, Pigeon shall delete the draft and reply "<layer> memory unchanged"; a valid draft within the limit shall replace the memory file as written and be deleted, with the reply "saved <layer> memory (<display path>): <n> entries, <used>/<limit> chars".
- **MEMORY-051** "/memory edit" shall not save, keeping the original file and the edits in the draft, when the editor fails to start or exits non-zero, the draft is malformed, the draft exceeds the limit, or the file was changed elsewhere during editing; each case replies "<layer> memory not saved: <reason>; edits kept in <draft>", with the reason "editor exited with code <n>", "bad format from line <n>", "<used> chars, <over> over the <limit> limit" or "changed elsewhere while editing".
- **MEMORY-052** When another writer holds the layer while saving, "/memory edit" shall wait without a time limit, show "saving memory… (Esc to cancel)" after one second, and on "Esc" cancel the save, leaving the file untouched and replying "not saved; edits kept in <draft>".
- **MEMORY-053** The limits shown and enforced by "/memory" shall follow the current settings, including after "/reload"; a failed "/reload" leaves them unchanged.

## Home directory

- **MEMORY-054** When the project's `.pigeon` directory is the user's `~/.pigeon` (started in the home directory, or linked to it), Pigeon shall offer only user memory: only that layer is pushed and listed, "/memory edit project" replies "in the home directory, project memory is user memory; use /memory edit user", and `update_memory` refuses `layer: project` with an explanation.

## Session search: registration

- **MEMORY-055** Pigeon shall register `search_sessions`, `read_session_entry` and `list_sessions` together, as read-only tools that see only this project's sessions (see APPROVALS-012).
- **MEMORY-056** Pigeon shall not register the three tools when the project has no started session (see SESSIONS-010) outside the sessions excluded by MEMORY-060; `pigeon trace` then shows the reason "no past sessions in this project" under "tools not registered" (see TOOLS-119, TOOLS-120).
- **MEMORY-057** Session search shall be on by default; `sessionSearch.enabled: false` or the `--no-session-search` flag (current run only) shall leave the three tools unregistered and leave the session-search sentence out of the system prompt when the prompt is generated (a resumed or reloaded session keeps its system prompt, see CONTEXT-090); `pigeon trace` shows the reason "sessionSearch.enabled is false", or "--no-session-search" when the flag was given, in the terminal UI and in `pigeon run` alike.
- **MEMORY-058** When the tools are registered, the system prompt shall tell the model to browse with `list_sessions`, search with `search_sessions`, read originals with `read_session_entry`, and treat snippets as leads only.
- **MEMORY-059** Each of the three tools shall reject unknown parameters with "Unknown parameters for <tool>: <names> (available: <names>)".

## Session search: scope and results

- **MEMORY-060** `search_sessions` and `list_sessions` shall exclude the current session's tree: its top-level session, found by following fork sources upward, and every session forked from it at any depth, the current session included.
- **MEMORY-061** Search shall cover the user's words, the model's text replies and, by default, earlier tool output; thinking, tool names and arguments, images, startup-status messages and the session-search tools' own output shall never be searchable.
- **MEMORY-062** History that "/fork" copies into a fork session shall produce hits only in the source session.
- **MEMORY-063** Subagent sessions shall not be searched or listed.
- **MEMORY-064** `list_sessions` and `search_sessions` shall not list or count sessions that never started: see SESSIONS-010.
- **MEMORY-065** `search_sessions` shall take 1–8 `keywords`, optional `conversationOnly` and optional `limit` (1–10); a session matches when any keyword matches, case-insensitively and literally (no regular expressions).
- **MEMORY-066** When every keyword consists only of whitespace, `search_sessions` shall fail with "Session Search needs at least one keyword" (an empty keyword or an empty list fails argument validation instead); when no keyword contains an ASCII letter, an ASCII digit or a CJK ideograph, it shall fail with "Session Search keywords contain no searchable terms (only punctuation or other characters that are not split into terms)"; otherwise a keyword without any of them matches nothing.
- **MEMORY-067** Matching shall ignore English case, match code identifiers whole and split at case changes, underscores, hyphens, dots, slashes and letter–digit boundaries, match Chinese by overlapping character pairs (a single character as a substring), and score a multi-word keyword per word with a bonus for the whole phrase.
- **MEMORY-068** Hits shall be ranked by relevance with rarer terms ranking higher and ties going to the newest message; sessions shall be ordered by their combined hit scores, ties by the latest hit.
- **MEMORY-069** `conversationOnly: true` shall restrict search to conversation text; otherwise tool output is searched with equal weight.
- **MEMORY-070** Results shall list one item per session (`- Session <id> | started <YYYY-MM-DD HH:MM> | <n> matching entries`) with up to two hits, each with entry ID, run, role, time, matched keywords and a snippet of at most 400 characters of the message (marked "…" where cut); 5 sessions by default, at most 10.
- **MEMORY-071** A hit on earlier tool output shall be labelled "Earlier tool output, may be out of date" with the tool, its key parameters, exit code or error, and time.
- **MEMORY-072** The reply shall state the number of sessions, keywords and scope, add a narrowing hint when more sessions matched than shown or the 16 KiB output cap was hit, and end with the reminder that snippets are only leads; with no hits it shall say "No matches" and suggest other wording.
- **MEMORY-073** `read_session_entry` shall read one message by `entryId` from the current branch of any of this project's sessions except subagent sessions, the current one included (optional `sessionId` narrows the lookup), showing text, thinking, tool calls and image placeholders.
- **MEMORY-074** `read_session_entry` shall return at most 4,000 characters by default (`maxChars` up to 8,000), state the total length and the range shown, and give the `offset` to continue when more remains; an offset past the end is an error.
- **MEMORY-075** With `before` or `after` (0–5), `read_session_entry` shall also show that many neighbouring messages, each cut at 1,000 characters with a note on reading the full text.
- **MEMORY-076** An unknown entry shall fail with "Entry <id> not found" and a note that only this project's sessions are searched.
- **MEMORY-077** `list_sessions` shall list earlier sessions newest first, at most 20 (optional `limit`, 1–20), each with ID, start time (UTC), the first user message cut at 60 characters, and up to 10 changed files with the total when more; a non-empty list ends with a line saying whether it was truncated, and an empty one is "No earlier sessions match" with the filters given.
- **MEMORY-078** A session's changed files shall be the paths of successful `edit_file` and `write_file` calls plus the files `run_command` reported as added, modified or removed.
- **MEMORY-079** `list_sessions` shall filter by `since` and `until` (inclusive; a `YYYY-MM-DD` date covers the whole UTC day) and by `path` (substring of a changed file); an unreadable time fails with "Unrecognized time: <raw>".
- **MEMORY-080** Pigeon shall cache each session's searchable text under `.pigeon/state/search-cache/`, extract it again when the session file's size or modification time changed or the cache file is unreadable, and keep searching when the cache cannot be written; during search and listing it deletes cache files of sessions whose file no longer exists.
- **MEMORY-081** Search shall never modify session files, and a partially written last line produces no hits.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `memory.projectLimitChars` | `4000` | Size limit of project memory, in characters. |
| `memory.userLimitChars` | `4000` | Size limit of user memory, in characters. |
| `sessionSearch.enabled` | `true` | Register the three session-search tools. |

Flags: `--no-pushed-memory`, `--no-session-search` (current run only). Environment: `VISUAL`, then `EDITOR`, for "/memory edit".

## Known limitations

- The over-limit line for instruction files is shown to the user only when a session opens; growth past the limit mid-session is reported only to the model.
- An unreadable instructions file (for example, no permission) fails without a dedicated message.
- There is one draft per layer: a draft left by a failed save is overwritten by the next "/memory edit" of that layer.
- The 10-second lock wait of `update_memory` is not configurable; a "/memory edit" save can only be cancelled after the one-second notice appears.
- Duplicate detection catches only identical content within one layer.
- Search indexes only ASCII letters and digits and CJK ideographs; kana, Hangul, Cyrillic and accented letters are not searchable, and a keyword made only of them matches nothing.
- The session-search tool list is fixed when a session opens: a project that gains its first past session mid-session gets the tools only in the next session.
