# Sandbox

Purpose: running a session's tools in a disposable Docker container instead of on the host.
The container starts from the repository's current state, the host stays untouched, and
the changes come back as a branch. Covers flags, images, resource limits, what the
container sees, delivering changes, resuming, confirmation and leftover containers.

## Starting

- **SANDBOX-001** Pigeon shall accept `--sandbox` in the terminal UI and in `pigeon run`; the session's tools then run inside a disposable Docker container instead of on the host.
- **SANDBOX-002** The container shall have network access unless `--sandbox-network off` is given, which starts it with no network.
- **SANDBOX-003** A `--sandbox-network` value other than `on` or `off` shall fail with "--sandbox-network takes on/off (<usage>)".
- **SANDBOX-004** The approval mode of a sandbox session (bypass by default, `--sandbox-approval prompt` to ask): see APPROVALS-002.
- **SANDBOX-005** A `--sandbox-approval` value other than `yolo` or `prompt` shall fail with "--sandbox-approval takes yolo/prompt (<usage>)".
- **SANDBOX-006** `--sandbox-network`, `--sandbox-approval` or `--sandbox-from-head` without `--sandbox` shall fail with "--sandbox-network, --sandbox-approval and --sandbox-from-head need --sandbox (<usage>)".
- **SANDBOX-007** `--worktree` and, in `pigeon run`, `--governance-root` are refused together with `--sandbox`: see WORKTREES-021, CLI-035.
- **SANDBOX-008** When Docker cannot be reached, Pigeon shall fail before starting with "Docker unavailable: <detail>".
- **SANDBOX-009** Outside a git repository Pigeon shall refuse with "sandbox needs a git repository: <dir> is not one"; in a repository without commits with "sandbox needs a repository with at least one commit".
- **SANDBOX-010** When started from a subdirectory, the container shall hold the whole repository, not just that subdirectory, and the working directory is the matching subdirectory of `/workspace`.
- **SANDBOX-011** Flag conflicts and start-up failures shall be reported before the terminal UI takes the screen; when start-up fails after the container was created, whether or not it started, Pigeon removes the container.

## Images

- **SANDBOX-012** By default the sandbox shall use Pigeon's bundled generic image (Ubuntu 24.04 with git, Python 3, Node 24, ripgrep, fd, jq and build tools; non-root user, working directory `/workspace`), built on first use and reused afterwards.
- **SANDBOX-013** When the image has to be built (no local image with that tag exists), Pigeon shall print "building sandbox image <tag> (first use, may take a few minutes)" before the full-screen UI starts.
- **SANDBOX-014** Pigeon shall build a new generic image when the bundled Dockerfile, the base image, the pip index or the npm registry changes; after a change of the apt or Node mirror it keeps using the existing image.
- **SANDBOX-015** The generic image's build parameters (base image, apt mirror, Node download URL, pip index, npm registry) shall come from `sandbox.build.*`, falling back to the environment variables `PIGEON_SANDBOX_BASE_IMAGE`, `PIGEON_SANDBOX_APT_MIRROR`, `PIGEON_SANDBOX_NODE_MIRROR`, `PIGEON_SANDBOX_PIP_INDEX` and `PIGEON_SANDBOX_NPM_REGISTRY`; empty environment variables are ignored, and neither source is used with `sandbox.image` or `sandbox.dockerfile`.
- **SANDBOX-016** When the build fails, Pigeon shall fail with "building sandbox image <tag> failed (exit code <n>):", the last 15 lines of build output, and a line naming the build parameters (or the project Dockerfile).
- **SANDBOX-017** With `sandbox.image`, Pigeon shall use that image; when it is not present locally Pigeon prints "image <name> not found locally; pulling" and pulls it, failing with "pulling sandbox image <name> failed: <detail>".
- **SANDBOX-018** With `sandbox.dockerfile` (relative to the project root), Pigeon shall build it with `sandbox.context` or the Dockerfile's directory as context, building a new image when the Dockerfile text or any file in the build context changes; a missing file fails with "sandbox Dockerfile not found: <path>".
- **SANDBOX-019** Settings shall reject, in each layer, unknown keys in the `sandbox` section and empty or blank strings; after the layers are merged, a section with both `image` and `dockerfile`, or with `context` but no `dockerfile`, fails with "merged settings invalid: sandbox: image and dockerfile can't both be set" or "… sandbox: context requires dockerfile".
- **SANDBOX-020** When the image has no working git, Pigeon shall fail with "image <image> has no usable git: git --version failed: <detail>" and remove the container.
- **SANDBOX-021** When the image runs as root (no user, `root` or `0`, with group `root` or `0` if given), Pigeon shall run the container as user `1000:1000` with `HOME=/tmp`; otherwise as the image's user.

## Resource limits

- **SANDBOX-022** Unless configured, the container shall get a memory limit of half the Docker host's memory (whole MiB) with no extra swap, a process limit of 4096 and no CPU limit.
- **SANDBOX-023** `sandbox.memory`, `sandbox.pids` and `sandbox.cpus` shall override the defaults, `0` meaning no limit; the keys merge one by one across settings layers.
- **SANDBOX-024** `sandbox.memory` shall be `0` or a number with unit k, m, g or t (1024-based, decimals allowed, any case); other forms are rejected, and a value below 6m fails with "sandbox: memory must be at least 6m, got <value>"; `pids` is a non-negative integer and `cpus` a non-negative number.
- **SANDBOX-025** When the Docker host's memory cannot be read and no limit is set, Pigeon shall start without a memory limit and say "can't read the Docker host's total memory; sandbox runs without a memory limit".
- **SANDBOX-026** When a memory limit applies and the container's out-of-memory kill count rises during a foreground command that runs to completion, the result shall say "Exceeded the sandbox memory limit of <limit>" with advice to reduce parallelism or memory use, whatever the exit code.
- **SANDBOX-027** When the count cannot be read and a foreground command exits with 137, the result shall say "Possibly exceeded the sandbox memory limit of <limit>"; other exit codes are not reported, and a command that timed out or was interrupted gets its timeout or abort error instead.
- **SANDBOX-028** With such a message Pigeon shall also show the person "[sandbox] <message> (<command>)".
- **SANDBOX-029** When such a message is given and background jobs were running meanwhile, the result shall also name them: "Background jobs running meanwhile: <job> (<command>), …; they may also account for the memory use".

## What the container sees

- **SANDBOX-030** For a new session, by default the container shall start from HEAD plus the uncommitted changes, including new files not ignored by git (with the exceptions in SANDBOX-031 and SANDBOX-032), without changing the host's working directory, index, branch or HEAD; for a resumed session see SANDBOX-064.
- **SANDBOX-031** The start snapshot shall leave out uncommitted changes to `.pigeon/state/`, `.pigeon/settings.local.json` and `.pigeon/worktrees/` (the container gets them only as committed in HEAD) and an untracked `.pigeon/.gitignore`; a tracked `.pigeon/settings.json` is included with its changes.
- **SANDBOX-032** Untracked files over `snapshot.untrackedFileMaxBytes`, or beyond `snapshot.untrackedTotalMaxBytes` in total (largest left out first), shall not be copied in; tracked files are copied whatever their size.
- **SANDBOX-033** When files were left out, Pigeon shall print "large untracked files skipped (<n>): <path> (<size>), …" (the model is told in its Environment section, see CONTEXT-087).
- **SANDBOX-034** Pigeon shall not report how many uncommitted files were brought in.
- **SANDBOX-035** With `--sandbox-from-head`, the container shall start from the current branch's latest commit, and when there are uncommitted changes Pigeon prints "uncommitted changes left out of the sandbox; base: <branch> (<commit>)".
- **SANDBOX-036** Inside the container the repository shall be at `/workspace` on branch `pigeon/sandbox-<session ID>`, byte-identical to the snapshot; host git configuration, hooks and filters (such as LFS) are not applied.
- **SANDBOX-037** The host project directory shall not be mounted; the only mount Pigeon adds is the shared download cache at `/pigeon-cache`, in both network modes.
- **SANDBOX-038** The download caches of npm, pnpm, yarn, pip, uv, cargo and go shall point into `/pigeon-cache`; installed dependency directories are not cached.
- **SANDBOX-039** Host environment variables shall not reach commands or hooks in the container; only variables Pigeon sets itself are passed in, such as the download-cache locations and `PIGEON_PROJECT_DIR` for hooks (see HOOKS-031).
- **SANDBOX-040** Session records, learned memory and settings shall stay on the host, and `update_memory` writes the host's memory file (see MEMORY-009, TOOLS-021).
- **SANDBOX-041** In a sandbox session the model's Environment section shall give the working directory under `/workspace`, "Linux (in a container)" with commands run through `/bin/sh -c`, "Sandbox: container sandbox (network on|off)" and, with the network off, "Network: not available (the sandbox has no network)"; outside a sandbox it reads "Sandbox: not in a sandbox (commands run directly on this machine)" (see CONTEXT-087).

## Tools in the sandbox

- **SANDBOX-042** `read_file`, `write_file`, `edit_file`, `grep`, `glob` and `run_command` shall act on the container's file system, resolving paths inside the container relative to `/workspace`.
- **SANDBOX-043** `run_command` shall run the program in the container and pass exit codes through unchanged (see TOOLS-050).
- **SANDBOX-044** A sandboxed command that times out or is interrupted (its process group is killed, the container is not restarted): see TOOLS-060.
- **SANDBOX-045** When one of Pigeon's own helper operations hangs in the container, Pigeon shall end that operation inside the container ("A helper command ran longer than <n>s and was terminated inside the container"); when the image has no `timeout` command or the operation still does not end, Pigeon restarts the container and the error says "A helper command did not finish within <n>s, so the container was restarted", or, when the restart itself fails, "A helper command did not finish within <n>s; Restarting the container failed: <detail>".
- **SANDBOX-046** Background jobs shall run in the container; jobs kept after the session ends still end when the container is removed, and `pigeon run --sandbox` does not report them as kept (see CLI-044).
- **SANDBOX-047** Where hooks run in a sandbox session (in the container, or on the host with `host: true`): see HOOKS-067.
- **SANDBOX-048** A sandbox session shall start no MCP servers, printing "MCP servers don't run in the sandbox: <names> unavailable" when some are configured.
- **SANDBOX-049** With the network on, `web_search` and `web_fetch` shall run from the host (see TOOLS-096).
- **SANDBOX-050** Subagents, `enter_worktree`, the session panel and work list, and file checkpoints are not offered in a sandbox session: see SUBAGENTS-004, WORKTREES-029, PANEL-002, PANEL-066, SESSIONS-062.

## Approvals

- **SANDBOX-051** The approval panel of a sandbox session offers no "[d]": see APPROVALS-037.
- **SANDBOX-052** When the settings contain grant rules limited to a path, a sandbox session shall refuse to start with "path-scoped grant rules are not supported in a container workspace: <tool> (<path>), …"; a "/reload" that brings such rules in fails with "reloading settings failed: path-scoped grant rules …".

## Delivering changes

- **SANDBOX-053** When a sandbox session ends, Pigeon shall commit the container's changes and deliver them to the host repository as branch `pigeon/sandbox-<session ID>`, without touching the host's current branch, working directory or uncommitted changes and without pushing, then remove the container.
- **SANDBOX-054** The delivered branch shall consist of the start snapshot commit (when uncommitted changes were brought in), any commits the agent made in the container, and one commit "Pigeon sandbox changes (<session ID>)" for each delivery ("/deliver" or session end) at which the container's working tree held uncommitted changes, each building on the previous one.
- **SANDBOX-055** After delivering, Pigeon shall print "delivered sandbox changes to branch <branch> (<commit>); diff: git diff <base>..<branch>", or "no sandbox changes; branch <branch> points to base <commit>".
- **SANDBOX-056** In `pigeon run --sandbox`, sandbox notices shall be written as lines on standard error prefixed "[sandbox] ", not as lines on standard output; the delivery line comes after the result line (the `--json` fields: see CLI-044).
- **SANDBOX-057** In the terminal UI, sandbox warnings at start and during the session shall appear as "[sandbox] <warning>" alerts in the message area; image build and pull progress is printed before the UI takes the screen, and at session end the delivery line is printed as "[sandbox] <line>" after leaving full screen.
- **SANDBOX-058** When a sandbox opens normally, Pigeon shall print no "sandbox ready" line and not name the container; the delivery-failure, existing-container, leftover-container, `pigeon sandbox clean` and `pigeon sandbox deliver` messages do name it.
- **SANDBOX-059** In a sandbox session "/deliver" shall deliver the current changes mid-session and can be repeated; it is refused with "can't use /deliver while running" while the session is busy (as in VIEWS-038); outside a sandbox it is "unknown command: /deliver" and is not listed when typing "/".
- **SANDBOX-060** A failed "/deliver" shall show "deliver failed: <reason>"; whenever "/deliver" is used with background jobs running, whether or not it succeeds, it first shows "background jobs still running during deliver: <job> (<command>), …".
- **SANDBOX-061** At session end in the terminal UI with background jobs running, Pigeon shall first say "stopped background jobs before deliver: …" and "kept background jobs still running during deliver: …" for the jobs concerned, then deliver.
- **SANDBOX-062** When the host repository's current branch is `pigeon/sandbox-<session ID>`, delivery shall fail with "can't deliver while <branch> is checked out in the host repository".
- **SANDBOX-063** When delivery fails at session end, Pigeon shall keep the container with the changes and report "deliver failed; container <name> kept with the changes: <reason>".

## Resuming and commands

- **SANDBOX-064** `pigeon --sandbox --resume <session ID>` shall start a new container from that session's delivered branch and continue the conversation; `--sandbox-from-head` has no effect on it (errors: see SESSIONS-022, SESSIONS-081).
- **SANDBOX-065** `--sandbox --continue` and `--sandbox --resume` without a session ID: see SESSIONS-017, SESSIONS-018, SESSIONS-081.
- **SANDBOX-066** Resuming a sandbox session without `--sandbox`, or a local session with it, is refused: see SESSIONS-022.
- **SANDBOX-067** Whether a session is a sandbox session shall be decided by the sandbox mark its session record carries from the start; a session record without the mark counts as one only while its delivered branch `pigeon/sandbox-<session ID>` or its start reference exists in the host repository.
- **SANDBOX-068** The "[sandbox]" mark in the "/resume" list and what picking such a session does: see SESSIONS-036, SESSIONS-022.
- **SANDBOX-069** "/fork", "/take", "/resume", "/new", "/clear", "/worktrees" and "/panel" are unavailable in a sandbox session: see SESSIONS-022, SESSIONS-078, WORKTREES-078, WORKTREES-063, PANEL-002.
- **SANDBOX-070** The `sandbox` line of "/status" (image, network and approval mode): see VIEWS-031.

## Settings and confirmation

- **SANDBOX-071** In a sandbox session "/reload" shall apply the new settings and keep the same container running; when the `sandbox` section changed, it adds "sandbox settings changed; takes effect after: pigeon --sandbox --resume <session ID>" (see SETTINGS-028).
- **SANDBOX-072** The `sandbox` section shall take part in confirmation only in sessions that open a sandbox (`pigeon --sandbox` in the terminal UI, `pigeon run --sandbox`) (see SETTINGS-031); in the terminal UI, skipping it at start drops the section for that session, and "/reload skip" keeps the section the session already had; in `pigeon run --sandbox` an unconfirmed section stops the run unless `--trust-config` is given.

## Leftover containers

- **SANDBOX-073** Sandbox containers shall be named `pigeon-sandbox-<session ID>` and kept, not auto-removed, when Pigeon crashes.
- **SANDBOX-074** When opening a sandbox, Pigeon shall list leftover containers of other sessions (stopped ones, and running ones whose Pigeon process on this machine is gone) with "<n> leftover sandbox container(s) from crashed processes, may hold undelivered changes: …; cleanup: pigeon sandbox clean", without removing them.
- **SANDBOX-075** When a container for the same session already exists, opening shall fail with "sandbox container pigeon-sandbox-<id> already exists and may hold undelivered changes; cleanup: pigeon sandbox clean".
- **SANDBOX-076** `pigeon sandbox list` shall print the leftover notice or "no leftover sandbox containers"; `pigeon sandbox clean` shall remove only leftover containers: in a terminal it first lists the containers to remove and asks once "remove these leftover sandbox containers? [y/N]", where "y" or "yes" in any case removes and any other answer prints "cancelled" and removes nothing; without a terminal it removes nothing and fails with "no terminal to confirm; rerun with --yes" unless `--yes` is given, and with `--yes` it removes without asking; with none it says "no leftover sandbox containers" and asks nothing, and after removal it prints "removed <n> leftover sandbox container(s): <names>".
- **SANDBOX-077** `pigeon sandbox cache` shall print the cache volume's size (and how many containers use it) or that it does not exist; `pigeon sandbox clear-cache` deletes it ("sandbox cache cleared" or "sandbox cache already empty") and refuses while a container uses it.
- **SANDBOX-078** `pigeon sandbox` shall take exactly one of `list`, `clean`, `deliver <session ID>`, `cache` and `clear-cache`, failing otherwise with "usage: pigeon sandbox list | clean [--yes] | deliver <session ID> | cache | clear-cache".
- **SANDBOX-079** Outside the sandbox, commands shall run directly as the user on the host without isolation, and Pigeon prints no risk warning at start-up.
- **SANDBOX-080** `pigeon sandbox deliver <session ID>` shall deliver the changes in that session's leftover container to the host repository as branch `pigeon/sandbox-<session ID>` as at session end (SANDBOX-053 to SANDBOX-055), starting the container first when it is stopped, then remove the container so that `pigeon --sandbox --resume <session ID>` can open the session again; a container a running Pigeon on this machine is using is refused with "sandbox container pigeon-sandbox-<id> is in use by a running Pigeon; not delivered", a session without a leftover container fails with "no leftover sandbox container for session <id>", and a failed delivery keeps the container (SANDBOX-063).
- **SANDBOX-081** When Pigeon creates a sandbox container, it shall record the commit the container starts from, for `pigeon sandbox deliver` to hand back its changes.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `sandbox.image` | unset | Image to use instead of the generic one. |
| `sandbox.dockerfile` | unset | Project Dockerfile, relative to the project root. |
| `sandbox.context` | Dockerfile's directory | Build context, relative to the project root. |
| `sandbox.build.baseImage` | `ubuntu:24.04` | Base of the generic image. |
| `sandbox.build.aptMirror` / `nodeMirror` / `pipIndex` / `npmRegistry` | unset | Download sources for building the generic image. |
| `sandbox.memory` | half the Docker host's memory | Memory limit; `0` = none. |
| `sandbox.pids` | `4096` | Process limit; `0` = none. |
| `sandbox.cpus` | `0` | CPU limit; `0` = none. |
| `snapshot.untrackedFileMaxBytes` | `10485760` | Largest untracked file copied into the container. |
| `snapshot.untrackedTotalMaxBytes` | `209715200` | Total untracked bytes copied into the container. |

Flags: `--sandbox`, `--sandbox-network on|off`, `--sandbox-approval yolo|prompt`, `--sandbox-from-head`. Commands: `pigeon sandbox list | clean [--yes] | deliver <session ID> | cache | clear-cache`.

## Known limitations

- The sandbox needs the `docker` command and a reachable daemon; other container engines are not configurable.
- Memory-limit detection covers foreground commands, not background jobs.
- The container runs with Docker's default capabilities and a writable root file system.
- A running container started from another machine is never counted as a leftover, even when the Pigeon process that started it is gone.
