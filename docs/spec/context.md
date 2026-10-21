# Context

Purpose: how Pigeon keeps the model's context usable over long sessions and stops runaway
behaviour — compaction, pruning of old tool results, loop and repetition detection,
continuing after an output-limit cut, request retries and output limits, the wall-clock
budget, the startup status and the system prompt's general rules.

## Automatic compaction

- **CONTEXT-001** Pigeon shall compact the conversation automatically when the estimated context exceeds the trigger point, between turns within a run and before a run starts (a new message or continuing a resumed conversation).
- **CONTEXT-002** Compaction shall trigger only when the estimate is strictly above the trigger point.
- **CONTEXT-003** The trigger point shall default to the context window minus 16,384 tokens; the most recent ~20,000 tokens are kept verbatim and everything older is summarised.
- **CONTEXT-004** The context window shall come from `--context-window <n>`, else the model's information, else 1,000,000, and be recorded with its source at each run start.
- **CONTEXT-005** The terminal UI (including `pigeon resume`) and `pigeon run` shall accept `--context-window`, `--compact-threshold` and `--compact-keep`, each needing a positive integer; otherwise startup fails with "<option> needs a positive token count (<usage>)".
- **CONTEXT-006** Pigeon shall refuse to start when the window is not above the reserve or the trigger point is not below the window, naming the values and their source.
- **CONTEXT-007** The estimate shall use the last successful reply's usage plus about one token per 4 characters of later messages, ignoring usage from before the latest summary.
- **CONTEXT-008** Before any automatic compaction — between turns, before a run, or after a context-overflow error — Pigeon shall first prune all prune candidates and re-estimate; if the context is no longer above the trigger point, no summary is made.

## How compaction works

- **CONTEXT-009** With nothing older than the kept messages, Pigeon shall skip the compaction without calling the model, running `PreCompact` or writing a compaction entry (a prune made just before may still be recorded).
- **CONTEXT-010** A compaction shall write a compaction entry to the session file while keeping the original messages there; the following context starts with the summary, sent to the model as a user message.
- **CONTEXT-011** Except in the cases of CONTEXT-014, Pigeon shall request the summary by resending the conversation as the last main request sent it (same model, system prompt, tools, messages, reasoning level and temperature) with one summary instruction appended as a user message.
- **CONTEXT-012** The instruction shall begin "Context checkpoint request: the conversation above is about to be compacted.", forbid continuing or calling tools, and require the sections Goal, Constraints & Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps and Critical Context, updating an earlier summary when one exists.
- **CONTEXT-013** When the cut falls inside a turn, the summary shall also cover that turn, quoting up to 200 characters of its first message.
- **CONTEXT-014** Pigeon shall instead send a standalone summary request, with a dedicated summarisation prompt and no reasoning, when the compaction follows a context overflow, when the conversation plus instruction and the summary's output limit would exceed the context window, or when the resend fails, returns a tool call or returns no text; an interrupted resend fails the compaction instead.
- **CONTEXT-015** The summary's output limit shall be the smallest of 0.8 × the reserve (13,107 tokens by default), `--max-output-tokens` when given, and the model's own output limit when known; the compaction entry records which request style was used and why.
- **CONTEXT-016** A summary shall end with the files read and modified in the summarised part.
- **CONTEXT-017** Summary requests shall use the same model connection and retry setting as main requests.
- **CONTEXT-018** `PreCompact` hooks before a compaction: see HOOKS-023.
- **CONTEXT-019** When an automatic compaction between turns or before a run fails or is skipped without being interrupted, the turn shall continue with the full context (an interrupt before a run: see CONTEXT-020; after a context overflow, see CONTEXT-030).
- **CONTEXT-020** An interrupt during a before-run compaction shall end the run as aborted.

## Manual compaction and messages

- **CONTEXT-021** "/compact [focus]" shall compact the conversation now, passing the trimmed text as additional focus for the summary.
- **CONTEXT-022** Pigeon shall refuse "/compact" with "can't use /compact while running", keeping the text in the input box, in the main agent's view while the session is busy (a turn, a manual compaction, a reload by "/reload" or by a "/config" change, a "/resume" switch or a "/rewind"), and in a sub-agent's view while that sub-agent is starting, running or compacting.
- **CONTEXT-023** A successful manual compaction shall add "[compact] context compacted (manual): ~<before> → <after> tokens"; a successful automatic one adds no line.
- **CONTEXT-024** A manual compaction that does not happen shall add "[compact] nothing to compact: nothing older than the kept messages to summarize", "[compact] can't compact: session file not open" when the session file cannot be read, or, as an error, "[compact] compaction failed: <reason>".
- **CONTEXT-025** An automatic compaction with nothing older than the kept messages shall add no line; any other automatic compaction that does not complete and is not interrupted shall add the alert "[compact] compaction incomplete (<trigger>): <reason>; continuing with the full context" (ending "not retrying; ended with the original error" after a context overflow) only the first time for each cause in the session.
- **CONTEXT-026** While a manual compaction runs, a new message shall wait for it.
- **CONTEXT-027** In `pigeon run`, an automatic compaction that does not complete and is not interrupted (including one with nothing to summarize) shall be reported on standard error as "compaction incomplete (<trigger>): <reason>; …", and a failing pre-compaction step as "pre-compaction callback failed: <reason>; compacting anyway", each once per cause.
- **CONTEXT-093** In compaction notices, <trigger> shall be "auto, between turns", "auto, before run" or "auto, after context overflow", and reasons of the same error type that agree up to their first ": " (compared over at most 120 characters) shall count as one cause.

## Context overflow and rejected images

- **CONTEXT-028** When a request fails with an error recognised as context overflow, Pigeon shall compact and, if that succeeds, retry once from the compacted context; the failed reply stays in the file but is not sent again.
- **CONTEXT-029** A given overflow shall be retried only once; after a normal reply a later overflow counts as new.
- **CONTEXT-030** When the overflow compaction fails, Pigeon shall end the run with the original error and record the failed stage.
- **CONTEXT-031** An HTTP 400 that is not recognised as an overflow shall not trigger compaction; it is retried only as in CONTEXT-092.
- **CONTEXT-092** When a request fails with HTTP 400 and carries image results added since the last successful reply, Pigeon shall, once per run and before any overflow handling, unless interrupted or stopped by a hook, replace those images with the note "[The provider did not accept this image: <what>. …]" (keeping the results' text), record the replacement in the session and retry; the images stay replaced on resume.

## Pruning

- **CONTEXT-032** Context pruning shall be on by default and replace only the body of older tool results with a placeholder; calls, user messages, model text, arguments, thinking and status messages are untouched, and the session file keeps the originals.
- **CONTEXT-033** Results in the last `protectTurns` turns (default 5), results of interrupted calls, and truncated command output that was not saved shall never be prune candidates; image replacement (by the image budget, or of new images after a request rejects them) does not observe these protections.
- **CONTEXT-034** Pigeon shall take as candidates stale reads (with `staleReads` on: a successful read followed by a successful read of the same file covering all its lines, or by a successful `write_file` of it), empty results (a successful `grep`, `glob` or `search_sessions` with no hits, a `web_search` with no results and no answer, a command that exited 0 with no output and no file changes) and large old results of at least `minResultTokens` (default 500); a result whose placeholder would not be smaller than it is never a candidate.
- **CONTEXT-035** At free moments — before any automatic compaction (see CONTEXT-008; unless `onCompaction` is off), at the first request after the model, tool set or system prompt changed from the previous run, and after idling longer than the cache retention (unless `onIdle` is off) — Pigeon shall prune all candidates at once.
- **CONTEXT-036** At other requests Pigeon shall prune, apart from images over the budget (CONTEXT-041), only stale reads from a chosen start onwards, together with the empty results from there on, choosing the start with the largest net saving; it prunes only when the amount saved by those stale reads is at least `minBatchTokens` (default 10,000) and `horizonTurns` (default 20) × that amount is at least (price ratio − 1) × the tokens after the start.
- **CONTEXT-037** The price ratio shall come from `contextPrune.priceRatio`, else 1 for a provider that does not cache, else the model's prices, else the cache rule's multipliers, else 50; cache retention from `retentionSeconds`, else the provider's cache rule, else unknown (no idle pruning).
- **CONTEXT-038** A pruned result shall read "[Pruned] <tool> result (<what>; ~<tokens> tokens; <why>), removed to save context. To get it back: <how>"; a pruned command keeps its file-change list.
- **CONTEXT-039** Before pruning a command result whose output was not saved, Pigeon shall save it (empty output needs no saving); if saving fails the result is kept.
- **CONTEXT-040** When a read is pruned and no unpruned read, write or edit result of that file remains, the file shall no longer count as read in the session.
- **CONTEXT-041** With pruning on, when the images in unpruned tool results exceed `maxImageBytes` (default 8 MiB), Pigeon shall replace image results from the oldest until the remaining images total at most half the budget, never the newest image result or a result of the latest turn.
- **CONTEXT-042** Each prune shall be recorded in the session before the request that first applies it.
- **CONTEXT-043** On resume, fork, "/rewind", "/reload", a settings change in "/config" and moving the session into a worktree, Pigeon shall replay the recorded prunes, also when pruning is disabled.
- **CONTEXT-044** The context usage shown in the status bar and the compaction check shall be estimated on the context actually sent, after pruning (see CONTEXT-007).

## Loop detection

- **CONTEXT-045** Loop detection shall be on by default for the terminal UI, panel sessions, `pigeon run` and subagents; `loopGuard.enabled: false` turns it off.
- **CONTEXT-046** A round shall be the tool calls of one reply (name and arguments, order kept) with their results; a round identical to the previous one adds one repeat, and any difference resets the count.
- **CONTEXT-047** Two rounds alternating shall also count as repeats.
- **CONTEXT-048** A round without tool calls shall reset the count, except as in CONTEXT-049; exempt tools (`job_output`, plus `loopGuard.exemptTools`) are ignored, and a round of only exempt calls neither counts nor resets.
- **CONTEXT-049** A reply without tool calls that stopped at the output limit or was cut by the repetition guard shall neither count nor reset.
- **CONTEXT-050** When the repeat count reaches `remindAt` (default 5) and `warnAt` (default 10), Pigeon shall add a reminder to the model's next turn starting "[Loop reminder] " with the repeated calls and the first three lines of each result (lines cut at 200 characters); the second reminder says "This is the second reminder." and "If they repeat for <n> more rounds, this run will be stopped."
- **CONTEXT-051** Each threshold shall fire once per loop; a changed pattern resets it, and counting restarts each run.
- **CONTEXT-052** Loop reminders shall go only to the model, not to the message area (history: see RENDERING-063).
- **CONTEXT-053** When the count reaches `stopAt` (default 20), the terminal UI shall show "[loop] stopped after <count> rounds of the same tool calls and results: <calls>" and interrupt the turn like "Esc" (end line: see RENDERING-056).
- **CONTEXT-054** For a panel session that is not current, a loop stop shall interrupt its turn and show the message of CONTEXT-053 with the session-name prefix (see PANEL-019).
- **CONTEXT-055** In `pigeon run`, a loop stop shall end the run `looping` and print "stopped after <count> rounds of the same tool calls and results: <calls>" (exit code: see CLI-048).
- **CONTEXT-056** Pigeon shall require `remindAt`, `warnAt` and `stopAt` to be positive integers in each settings file (otherwise that file fails as in SETTINGS-019) and, after merging layers, to strictly increase; otherwise the merged settings fail with "loopGuard: turn counts must increase: remindAt <a>, warnAt <b>, stopAt <c>" (see SETTINGS-023).

## Continuing after a cut

- **CONTEXT-057** With `truncationContinuation.enabled` on, when a reply stops at the output limit without a tool call, Pigeon shall continue the run with a prompt, up to `maxConsecutive` (default 2) in a row and `maxPerRun` (default 5) per run; then the run ends as is.
- **CONTEXT-058** For a plain output-limit cut, the cut text shall stay in the context and Pigeon appends "Your previous reply hit the output length limit and was cut off, so its last line may be incomplete. Finish that line first, then continue from where it stopped without repeating what you already wrote."
- **CONTEXT-059** For a reply cut by the repetition guard, the reply shall be dropped from the context and moved off the main branch (kept in the file), and Pigeon appends "Your previous reply was cut off and no tool was run. Do not repeat earlier text; briefly state the next step and make one tool call right away."
- **CONTEXT-060** Each continuation shall be recorded, and dropped replies still count toward turns and usage.
- **CONTEXT-061** No continuation shall start after an interrupt or a hook's stop request.
- **CONTEXT-062** A continuation after an earlier compaction in the run shall use the compacted context.
- **CONTEXT-063** How continuation prompts show in history: see RENDERING-063.

## Repetition detection

- **CONTEXT-064** With `repetitionGuard.enabled` on, Pigeon shall watch the streamed text and thinking of turn replies (not tool arguments, summary requests or web-page distillation requests) for a repeating cycle at the end of the recent text and for runs of near-identical paragraphs.
- **CONTEXT-065** Units without letters (separator lines) shall not count; paragraphs with fewer than `segmentMinChars` (default 60) non-space characters, heading lines excluded, are ignored; a paragraph hit needs at least `minSegments` (8) paragraphs so far, `minCluster` (4) near-identical ones among the last `segmentWindow` (16), and the last `minConsecutive` (3) each near-identical to the one before.
- **CONTEXT-066** In `abort` mode (default), a hit shall end the reply at the hit point and hand it to continuation; in `log` mode the reply goes on and only the first hit per channel and criterion is recorded.
- **CONTEXT-067** Each hit shall be recorded with criterion, channel, period, repeats, positions and mode.
- **CONTEXT-068** `repetitionGuard.preset` shall choose base parameters (`omp`, the default, or `wide`) that individual keys override; when `windowChars` is below `maxPeriodChars` × `minRepeats`, the merged settings fail with "repetitionGuard: windowChars <w> must be at least maxPeriodChars * minRepeats (<n>)" (see SETTINGS-023).
- **CONTEXT-069** If the detector itself fails, the reply shall end with "repetition guard failed: <reason>".

## Requests, replies and limits

- **CONTEXT-070** Every model request (turn, summary and web-page distillation requests) shall be retried up to `modelRequest.maxRetries` times (default 4; 0 disables) on connection failures, 408, 409, 429 and 5xx, honouring Retry-After up to 60 seconds and otherwise backing off exponentially, never on 400 and never once the reply has started streaming.
- **CONTEXT-071** For model connections whose `--stream-fn` module declares the `anthropic-messages`, `openai-completions`, `openai-responses` or `azure-openai-responses` API, Pigeon shall record each retry in the session with its number, the previous HTTP status or error text, and the wait.
- **CONTEXT-072** When a reply has neither text nor a tool call, Pigeon shall retry once in the same run unless interrupted; if it is still empty the run ends as an empty reply with "empty model reply (no text or tool calls), still empty after one retry" (`pigeon run` status `empty-reply`).
- **CONTEXT-073** Without `--max-output-tokens` Pigeon shall set no output limit of its own on turn requests; with it each turn request uses the smaller of that value and the model's limit (summary requests: see CONTEXT-015; web-page distillation requests keep their own limit).
- **CONTEXT-074** With `edit_file` available, the system prompt shall tell the model to split a tool call cut by the output limit into smaller calls.
- **CONTEXT-075** When within one run the same tool is refused by policy (including for lack of an approval channel) three times, the same call (tool and arguments) is rejected by a person or a `PreToolUse` hook or blocked because the approval check itself failed three times in all, or calls to the same tool are rejected before they run (unknown tool or invalid arguments) three times in a row, Pigeon shall stop the run as a circuit-breaker stop (end line "stopped", "breaker" in trace and replay).

## Wall-clock budget

- **CONTEXT-076** With `pigeon run --wall-clock <ms>`, the startup status shall include a "Time budget" section with total, used and remaining time and, when `run_command` is available, that longer command timeouts are shortened to the remaining time.
- **CONTEXT-077** The section shall be updated only when the remaining time drops below another 80%, 60%, 40% or 20% of the total, alongside another changed section, or in the full status resent after a compaction.
- **CONTEXT-078** Below 20% remaining, Pigeon shall append once a "Time reminder" section asking to prioritise a deliverable result and not start long tasks.
- **CONTEXT-079** The time sections shall appear only in a `pigeon run` with `--wall-clock`; the terminal UI and subagents never include them.

## Startup status

- **CONTEXT-080** At a session's first request, Pigeon shall send a startup status as a separate user message tagged `<pigeon-status>`, with sections in the order Project instructions, Skill catalog, External tools, Environment, Approvals, Web access, Memory, Git status, Date (then the time sections); empty sections are omitted.
- **CONTEXT-081** Later, Pigeon shall append only changed sections (plus the current "Time budget", see CONTEXT-077) in a `<pigeon-status-update>` message, each introduced by "This replaces the earlier "<name>" section in full:", never rewriting earlier messages; a removed section is sent with a fixed text such as "There are no project instructions now.".
- **CONTEXT-082** Project instructions, Skill catalog, Memory, Environment and Git status shall be re-read at run start and after a batch of tool results that included a write- or command-tier tool or followed a change in the skill directories; the other sections, including the date, are checked at run start and after every batch of tool results.
- **CONTEXT-083** After a compaction, Pigeon shall resend the full status, introduced by "The following replaces all earlier startup status in full."
- **CONTEXT-084** On resume, fork, "/rewind", "/reload", a settings change in "/config" and moving the session into a worktree, Pigeon shall compare with the last status recorded and append only what changed.
- **CONTEXT-085** Memory the model wrote itself is not echoed in status updates: see MEMORY-033.
- **CONTEXT-086** In status section text, Pigeon shall escape every "<pigeon-" or "</pigeon-" opening — matched case-insensitively, allowing spaces, ignoring invisible format characters, after NFKC normalisation and with "&lt;"-style entities decoded — by writing its "<" as "&lt;" (or the entity's "&" as "&amp;"); other text is unchanged.
- **CONTEXT-087** In the Environment section Pigeon shall give working directory, operating system and shell, sandbox state, detected languages and dependency directories, the network when known and any untracked files left out of the start snapshot; Git status gives the branch (or detached HEAD), the first 12 characters of the commit (or that there are no commits yet) and whether there are uncommitted changes, or "Not a git repository.", or why git status is unavailable.
- **CONTEXT-088** How status messages show in history: see RENDERING-063.

## System prompt

- **CONTEXT-089** The system prompt shall be English, begin "You are Pigeon, a coding agent powered by the <model> model." (without "powered by …" for a placeholder model), mention in its guidelines and tool notes only tools the session has, and end by saying that text inside `<pigeon-status>` and `<pigeon-status-update>` tags is startup status attached by Pigeon, not the user's own words, and that the user's current request wins on conflict.
- **CONTEXT-090** The system prompt shall stay byte-identical for the whole session, across "/reload", resume and moving into a worktree; it is generated anew only when the session is resumed with a different model.
- **CONTEXT-091** When a session's system prompt lacks that closing sentence and no status has been sent in the session yet, the first full status shall begin with "This status block is authoritative: …".

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `loopGuard.enabled` | `true` | Loop detection. |
| `loopGuard.remindAt` / `warnAt` / `stopAt` | `5` / `10` / `20` | Repeat counts for reminders and stop. |
| `loopGuard.exemptTools` | `[]` | Extra tools ignored (always `job_output`). |
| `truncationContinuation.enabled` | `true` | Continue after an output-limit cut. |
| `truncationContinuation.maxConsecutive` / `maxPerRun` | `2` / `5` | Continuation limits. |
| `repetitionGuard.enabled` / `mode` / `preset` | `true` / `"abort"` / `"omp"` | Repetition detection; individual thresholds may be set too. |
| `contextPrune.enabled` | `true` | Pruning. |
| `contextPrune.protectTurns` / `horizonTurns` | `5` / `20` | Protected recent turns; expected horizon. |
| `contextPrune.minBatchTokens` / `minResultTokens` | `10000` / `500` | Smallest paid prune; smallest large result. |
| `contextPrune.priceRatio` / `writeMultiplier` / `retentionSeconds` | from model information | Pricing and cache overrides. |
| `contextPrune.onCompaction` / `onIdle` / `staleReads` | `true` | Free moments and stale reads. |
| `contextPrune.maxImageBytes` | `8388608` | Image budget in the context. |
| `modelRequest.maxRetries` | `4` | Retries per model request. |

Flags: `--context-window`, `--compact-threshold`, `--compact-keep`, `--max-output-tokens`, `--wall-clock` (`pigeon run`).

## Known limitations

- Context overflow is recognised only from the provider's error text.
- With the default trigger point, the resend-style summary fits only while the context is at most about 3,000 tokens above the trigger point; beyond that a standalone summary, which cannot reuse the provider's cache, is used.
- Loop detection only catches rounds that repeat exactly.
- A cut reply that contains tool calls is not continued; the calls are reported as not run.
- The git status section reflects changes made outside Pigeon only after the next writing or command tool or run.
- The circuit-breaker threshold of three is not configurable.
- If a prune record cannot be written to the session file, the prune still applies until the session is closed but is not replayed when it is reopened.
