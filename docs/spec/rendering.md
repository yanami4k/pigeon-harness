# Rendering

Purpose: how the terminal UI's message area displays content — the welcome header, Markdown replies,
formulas, links, images, thinking, tool calls and their results, user echoes and program lines,
replayed history and the transcript printed on exit — and how text Pigeon did not write is made
safe for the terminal.

## Markdown

- **RENDERING-001** Pigeon shall render the model's reply text as Markdown, re-rendering the reply so far as each chunk streams in.
- **RENDERING-002** Bold, italic, strikethrough and inline code shall be shown styled (inline code in cyan) without their `**`, `*`, `~~` or backtick markers.
- **RENDERING-003** Level-1 headings shall be bold and underlined and level-2 headings bold, without `#` marks; deeper headings are bold with their `### ` prefix kept.
- **RENDERING-004** Fenced code blocks shall show their fence lines ("```<language>" and "```"), with the code indented two spaces, uncoloured and without syntax highlighting.
- **RENDERING-005** Lines wider than the message area, code included, shall wrap rather than be cut; tabs are shown as three spaces. Approval conclusion lines and the welcome header are cut instead (RENDERING-055, RENDERING-058).
- **RENDERING-006** Block quotes shall be italic with each line prefixed "| ", and horizontal rules a line of "-" as wide as the area, at most 80.
- **RENDERING-007** List items shall show their bullet ("- ") or number, indented one level per nesting depth.
- **RENDERING-008** Tables shall be drawn with box-drawing borders ("┌─┬─┐", "│", "├─┼─┤", "└─┴─┘") and wrapped cells; when the area has fewer than 4 columns per table column plus 1, the table's Markdown text is shown instead.
- **RENDERING-009** HTML in a reply shall be shown as literal text.
- **RENDERING-010** A Markdown image in a reply shall show only its alt text; the image is not loaded.
- **RENDERING-011** Each text entry in the message area shall have one blank line above and one below, giving two blank lines between adjacent entries, and be indented one column from both edges; images in tool results have no blank lines or indent.
- **RENDERING-012** A model turn with only tool calls shall add no reply entry and no extra blank line.

## Formulas

- **RENDERING-013** Inline formulas written `$…$` shall be rendered as Unicode text (for example `$n\times n$` as "n × n", `$\alpha$` as "α"), without dollar signs or LaTeX commands.
- **RENDERING-014** Display formulas between `$$` delimiters shall be rendered as Unicode text, on their own lines or spanning several, also inside quotes and list items, with the following content formatted normally.
- **RENDERING-015** A formula that cannot be converted shall be shown as written.
- **RENDERING-016** Dollar signs in money amounts and upper-case environment variables ("$5 to $10", "$HOME", "$PATH") shall be shown as written.
- **RENDERING-017** Shell-style variables such as "cp $src/$dest", "$i/$n" or "${a}${b}" shall be shown literally rather than as a formula.
- **RENDERING-018** An unpaired `$`, a `$` followed by whitespace, and a mid-line `$$` shall be shown literally, and shall not stop later bold text or inline code in the paragraph from being formatted.
- **RENDERING-019** Dollar-delimited text without a variable-style separator (for example "the $i$th", "$x<y$") shall be rendered as a formula.
- **RENDERING-020** Dollar signs inside code blocks, inline code, URLs, autolinks, link targets, image alt text and HTML shall never be changed.

## Links

- **RENDERING-021** When a Markdown link's text differs from its target, the target shall appear once after the link text as " (<target>)", with no angle brackets added around a target without a scheme (for example "notes (./a.md)"), whether or not the terminal supports hyperlinks; link text equal to the target, or to the address of a `mailto:` target, shows no target.
- **RENDERING-022** In terminals that support hyperlinks, Markdown links and bare URLs in replies shall be clickable.
- **RENDERING-023** In user echoes, program lines and tool entries, URLs starting with "http://" or "https://" and absolute file paths ending in a file extension shall be clickable in terminals that support hyperlinks, with surrounding quotes, brackets and trailing punctuation left outside the link; end lines and approval conclusions get no links, and thinking gets none except for the absolute file paths of RENDERING-024.
- **RENDERING-024** Absolute file paths in model replies and thinking, outside code, shall also be clickable in terminals that support hyperlinks.
- **RENDERING-025** When the user clicks a link, Pigeon shall open it with the system's default handler only if it is an http, https or file URL, without a shell; other links are ignored.
- **RENDERING-026** Hyperlinks shall be emitted only in terminals detected as supporting them; `PI_HYPERLINKS=1` forces them on and `PI_HYPERLINKS=0` off.

## Images

- **RENDERING-027** When a tool result carries images, Pigeon shall display each after the tool entry, in terminals supporting the Kitty or iTerm2 image protocol, scaled to at most 60 columns by 20 rows.
- **RENDERING-028** Terminals that cannot display images shall show a placeholder "[Image: [<type>] <width>x<height>]", with the size given as 800x600 when it cannot be read from the image.
- **RENDERING-029** Only PNG, JPEG, GIF and WebP images with valid base64 data shall be displayed; any other image is shown as "[image: can't display]", without writing the supplied type or data to the terminal.

## Thinking

- **RENDERING-030** Streamed thinking shall be shown in full as its own dimmed plain-text entry beginning with "~ "; reply text that follows starts a new entry.
- **RENDERING-031** In replayed history, thinking shall be shown dimmed as "~ <text>", as "~ thinking (redacted by provider)" when redacted, and as "~ thinking (not persisted, <N> bytes)" ("1 byte" for one) when it was not saved.

## Tool calls and results

- **RENDERING-032** A proposed tool call shall add an entry "$ <tool> <arguments as one-line JSON>"; arguments over 160 characters are cut and followed by "… (<N> chars)" with the full length, and arguments that cannot be serialised show "<unserializable arguments>".
- **RENDERING-033** When the call finishes, Pigeon shall append " -> ok" to that line, or " -> error" with " [<error kind>]" when known.
- **RENDERING-034** The whole tool entry shall be dimmed; for a failed call the leading "$" becomes a red "✗".
- **RENDERING-035** A tool result shall be shown under its call, collapsed: the first 3 lines prefixed "  | " and cut at 200 characters with "...", then "  | ... +<N> lines" when more remain.
- **RENDERING-036** For editing tools that return a diff, the diff shall be shown instead of the receipt text.
- **RENDERING-037** "Ctrl+O" shall expand or collapse every tool result in the view being looked at (the main view, a subagent view or the read-only view of another session), and later results in that view follow its current state; while the settings view, a selection list, the message list of the rewind view, the completion list or the find box is open, or while an approval is shown (APPROVALS-038), the key goes to that part or does nothing instead.
- **RENDERING-038** A subagent view or the read-only view of another session shall open in the main view's current expand state, not that of the view looked at just before.
- **RENDERING-039** Expanded results shall show at most 200 lines and 20,000 characters each; when lines are left out, "  | ... truncated, <N> more lines" follows, and when the character limit cuts a line, that line ends with "..." and the note reads "  | ... truncated, <N> more characters".
- **RENDERING-040** An empty result shall show nothing under the call; Windows line endings and trailing empty lines are not shown.
- **RENDERING-041** In the main view, reply text, thinking and tool results from a run other than the session's active run shall not appear in the message area.
- **RENDERING-042** When a result arrives before its call line, Pigeon shall create the entry as "$ <tool>" and attach the result.
- **RENDERING-043** For web search, web fetch and MCP tool results that begin with the external-content line (see TOOLS-107; a web fetch that only reports a redirect to another site has none), the collapsed preview shall skip that line and start with the line after it.

## Command echo

- **RENDERING-044** `run_command` results begin with the echoed command: see TOOLS-054.
- **RENDERING-045** Long and multi-line commands are echoed by their first line with a note on what was left out: see TOOLS-054.
- **RENDERING-046** A command given by short name is echoed expanded with "(short name <name>)": see TOOLS-054.
- **RENDERING-047** Background jobs shall be identified in lists and notices by the command's first line up to 80 characters, with "(<N> lines)" for multi-line commands.

## Untrusted text

- **RENDERING-048** Pigeon shall neutralise terminal control characters in text it did not write itself — replies, thinking, tool arguments and results, echoed input, warnings, history, approval conclusions, file names and directory names — before showing it in the message area, the approval box, the session and subagent panels, the settings view, selection lists, the input box's completion menu, the welcome header's directory line, the read-only history view's title and the queued-input list.
- **RENDERING-049** The escape character shall be shown as "␛", other C0 controls except line feed and tab as control pictures (carriage return as "␍"), DEL as "␡", and C1 controls as "�".
- **RENDERING-050** No colour or styling from model or tool content shall reach the terminal; all styling comes from Pigeon's own fixed styles.
- **RENDERING-051** Wherever Pigeon neutralises control characters, it shall also show the Unicode bidirectional controls U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and U+061C as visible marks instead of letting them reorder the text; the zero-width joiner (U+200D) is shown as it is.

## User and program lines

- **RENDERING-052** A submitted message or command shall be echoed as "> <text>" in plain text in the message area of the view it was submitted in before it is run, an unknown command included; only the first line of multi-line input carries "> ". Input that is only whitespace, a rejection reason, a message or command refused in the read-only view or in a subagent view (VIEWS-037, or a message the subagent does not accept), and input typed in the session panel is not echoed.
- **RENDERING-053** Informational lines Pigeon writes shall be dimmed; errors and warnings shall be at normal brightness.
- **RENDERING-054** While the terminal UI holds the screen, Pigeon's warnings (for example about compaction, the session file or workspace snapshots) shall go to the message area instead of standard error; before the UI starts and after it exits they go to standard error.
- **RENDERING-055** The dimmed conclusion line left by an answered approval (see APPROVALS-047) shall be cut to the area's width, with " …" when the conclusion had more lines.
- **RENDERING-056** When a piece of work in the main view finishes, Pigeon shall add one dimmed line: "done · <elapsed>", "interrupted · <elapsed>", "error · <elapsed>" (followed by " · <first line of the reason>" when there is one), "stopped: output limit · <elapsed>", "stopped: <turn limit|time limit|token limit|looping|stop hook limit> · <elapsed>", "stopped · <elapsed>", or "ended · <elapsed>" when the outcome is unknown, with elapsed like "12s", "1m 23s" or "1h 5m". In history each run ends with the same line, without the elapsed time when the run's start is not recorded.
- **RENDERING-057** In a subagent's view, a turn ending with an error shall add the line "error · <first line of the error>" at normal brightness; apart from the end lines of the history shown there (RENDERING-056), subagent views get no other end lines.
- **RENDERING-058** The message area shall start with a welcome header: a small pigeon picture with, beside it, "Pigeon v<version>" (bold), "<model> · <provider>" (dimmed, left out when no model name is known beyond the default "custom") and the directory with the home directory written as `~` (dimmed). The header scrolls with the area and stays at the top after the area is cleared; when the terminal is too narrow for the picture, only the text is shown, each line cut with "..." (which directory: see VIEWS-053).

## History

- **RENDERING-059** When a session is resumed, at start-up or with "/resume", Pigeon shall render its saved history in order — user messages, program lines, replies, thinking, tool entries, approval conclusions and run end lines — followed by "--- resumed ---"; every other view that shows a session's history renders it the same way.
- **RENDERING-060** In history, a tool call shall be shown as "$ <tool> <arguments> -> ok" or "-> error" (a failed call starts with a red "✗" instead of "$") with its result under it, collapsed, and "Ctrl+O" shall expand and collapse these results as it does live ones; images in history results are not displayed.
- **RENDERING-061** History shall show at most the last 500 history lines by default (`--history-limit <n>`), each message line, thinking, tool line, result, approval conclusion, end line and notice line counting as one however many screen lines it takes; earlier ones are folded into "[<N> earlier lines not shown]" ("[1 earlier line not shown]" for one).
- **RENDERING-062** In history, a message's text or thinking longer than 4000 characters shall be cut with "… (<N> chars)", where N is the full length.
- **RENDERING-063** In history, program input stored as user messages shall be shown as dimmed program lines, not as "> " messages: loop reminders, background-job notices and "[Pigeon] " notes as written, agent messages as "agent <kind> from <sender>: <body>", status blocks as "[status] <section names>" or "[status update] <section names>", and continuation prompts as "continuation prompt: <text>".
- **RENDERING-064** When no record of the session can be found, history shall show the dimmed line "[no record of this session in the session store; history not shown]"; when only a session file in a format Pigeon does not read exists, it shows "[old-format session; history not shown; readable with legacy code <commit>]".
- **RENDERING-065** In history, an image block shall be shown as "[image <type> <N> bytes]" ("1 byte" for one) and an unknown block as "[unknown block <type>]", after "> " in a user message.
- **RENDERING-069** In history, a tool call that a person approved or rejected in the approval box shall be followed by one dimmed line "✓ approved <tool> <arguments>" or "✗ rejected <tool> <arguments>"; calls allowed by the approval mode, a grant or a rule get no such line.

## Layout

- **RENDERING-066** Message-area text shall wrap by display width, wide characters counting two columns, and re-wrap without loss when the terminal is resized.
- **RENDERING-067** Message-area styles shall be fixed: dim for secondary information, bold for headings, strong text and the name in the welcome header, underline for links, level-1 headings and search matches, bold reverse for the current search match, reverse for a drag selection, italic for emphasis and quotes, strikethrough for struck text, cyan for inline code, red for failure marks.
- **RENDERING-068** When the terminal UI exits normally, Pigeon shall leave full screen and print the main session's message area, welcome header included and without input box or status bar, to the normal screen without trailing spaces on its lines, also when another view was showing (leaving full screen for an external editor: see VIEWS-046).

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `keybindings."pigeon.toggleToolOutput"` | `ctrl+o` | Expand or collapse tool results. |

Flags: `--history-limit <n>` (default 500). Environment: `PI_HYPERLINKS` (`1` or `0`) forces hyperlinks on or off; `PI_IMAGE_PROTOCOL` forces `kitty` or `iterm2`, or `none` (or `0`) to disable images.

## Known limitations

- Table borders use characters that some terminals draw two columns wide, which misaligns tables there.
- The welcome header's pigeon picture uses block characters that some terminals draw two columns wide, which misaligns the header there.
- Telling formulas from shell variables is heuristic; unusual text (such as `/^a$|^b$/`) may be misread.
- Images show only in terminals with the Kitty or iTerm2 protocol; Windows Terminal, VS Code and tmux get the placeholder.
- There is no colour theme setting, and `NO_COLOR` is not honoured.
- The collapsed preview limits each line by characters, not columns; a line of wide characters may wrap.
- A history message cut at 4000 characters may break a code block or formula after the cut.
