// Pigeon 命令行入口。决策 267：pigeon 不带子命令即启动终端界面（以子进程运行 tui 入口，Actor 之间不互相 import）；
// 决策 461：命令行对话（pigeon --line 与它的 REPL）已去掉，交互一律用终端界面，无人值守用 pigeon run；pigeon resume 进终端
// 界面续接（等同 pigeon --resume）。本文件只做子命令的参数解析与 IO 接线：run、trace、replay、session list、sandbox、
// worktrees、migrate-config。

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { failureBadge, plural } from "../application/format.ts";
import { currentHarnessRef, describeHarness, pigeonVersion } from "../application/harness-ref.ts";
import { HEADLESS_EXIT_CODES, runHeadless } from "../application/headless-core.ts";
import {
  parseLaunchFlags,
  resolveStreamFnSpec,
  VALUELESS_FLAGS,
  webToolsOptionOf,
} from "../application/launch-flags.ts";
import { LOOP_GUARD_TEXTS } from "../application/loop-guard.ts";
import { MIGRATE_CONFIG_USAGE, runMigrateConfig } from "../application/migrate-config.ts";
import { loadStreamFn, resolvePackagedModelAccess } from "../application/runtime.ts";
import { runHeadlessInSandbox, runSandboxCommand } from "../application/sandbox-session.ts";
import { runSessionListCommand } from "../application/session-list.ts";
import { openSessionSettings, TRUST_CONFIG_FLAG } from "../application/session-settings.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import { runWorktreesCommand } from "../application/worktree-cleanup.ts";
import { installProxyFetch } from "../pi-runtime/model-access.ts";
import { newSessionId } from "../state/ids.ts";
import { BUNDLE_ROLE_ENV, FROM_BUNDLE } from "../state/package-paths.ts";
import { pigeonRel } from "../state/paths.ts";
import type { SessionListFilters } from "../state/session-summary.ts";
import { loopGuardSettingsOf, taskListEnabledOf, withHooksDisabled } from "../state/settings.ts";
import { EDIT_MODES, type EditMode, isEditMode } from "../tools/edit-mode.ts";
import { sanitizedWriter } from "./output.ts";
import { runReplayCommand } from "./replay.ts";
import { runTraceCommand } from "./trace.ts";

// 决策 036：cli 唯一 stdout 出口——帮助与只读视图（trace / replay / session list）等全部经同一净化写；半信任内容
//（模型文本、参数、错误消息）携带的终端控制序列在边界可见化（M2 审计 P2-1）
const writeOut = sanitizedWriter((text: string): void => {
  process.stdout.write(text);
});

// pigeon trace <sessionId> [--run <runId>] [--root <dir>]：只读关联视图（M4 S3）——
// 不需要模型接入，永不写会话文件/工作区（只经只读读取器读，见 trace.ts）
function traceMain(argv: string[]): void {
  let sessionId: string | undefined;
  let runId: string | undefined;
  let root = process.cwd();
  // M5 S2（决策 045）：--with-content 带正文（默认关）
  let withContent = false;
  const usage = "usage: pigeon trace <sessionId> [--run <runId>] [--with-content] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--run") {
      runId = argv[++i];
    } else if (flag === "--with-content") {
      withContent = true;
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else if (sessionId === undefined && flag !== undefined && !flag.startsWith("--")) {
      sessionId = flag;
    } else {
      throw new Error(`unknown option: ${flag} (${usage})`);
    }
  }
  if (sessionId === undefined || runId === "") {
    throw new Error(usage);
  }
  writeOut(
    runTraceCommand({
      root: realpathSync(root),
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
      withContent,
    })
  );
}

// pigeon replay <runId> [--session <sessionId>] [--root <dir>]：只读黑匣子时间线（M4 S4，
// D4 一次性渲染）——不需要模型接入，永不写会话文件/工作区，绝不重新执行真实副作用
// （只经只读读取器读，见 replay.ts）；与 trace 的按轮分组视图相区别
function replayMain(argv: string[]): void {
  let runId: string | undefined;
  let sessionId: string | undefined;
  let root = process.cwd();
  // M5 S2（决策 045）：--with-content 带正文（默认关）
  let withContent = false;
  const usage =
    "usage: pigeon replay <runId> [--session <sessionId>] [--with-content] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--session") {
      sessionId = argv[++i];
    } else if (flag === "--with-content") {
      withContent = true;
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else if (runId === undefined && flag !== undefined && !flag.startsWith("--")) {
      runId = flag;
    } else {
      throw new Error(`unknown option: ${flag} (${usage})`);
    }
  }
  if (runId === undefined || sessionId === "") {
    throw new Error(usage);
  }
  writeOut(
    runReplayCommand({
      root: realpathSync(root),
      runId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      withContent,
    })
  );
}

// pigeon session list [--tool <name>] [--class <cancelled|business|infrastructure|unknown>]
//   [--since <ISO 日期|epoch 毫秒>] [--until <...>] [--root <dir>]：会话投影列表（M4 S5，D5）——
// 只读渲染（派生不落库），不需要模型接入，永不写会话文件/工作区
const FAILURE_CLASSES = ["cancelled", "business", "infrastructure", "unknown"] as const;

// 时间边界解析：全数字 = epoch 毫秒；否则按 ISO 日期 Date.parse，解析不出响亮报错
function parseTimeBound(flag: string, value: string | undefined): number {
  if (value === undefined) {
    throw new Error(`${flag} needs a value (ISO date or epoch ms)`);
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} needs an ISO date or epoch ms: ${value}`);
  }
  return parsed;
}

function sessionListMain(argv: string[]): void {
  const filters: SessionListFilters = {};
  let root = process.cwd();
  const usage =
    "usage: pigeon session list [--tool <name>] [--class <cancelled|business|infrastructure|unknown>] " +
    "[--since <ISO date|epoch ms>] [--until <ISO date|epoch ms>] [--root <dir>]";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--tool") {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error("--tool needs a tool name");
      }
      filters.tool = value;
    } else if (flag === "--class") {
      const value = argv[++i];
      if (value === undefined || !(FAILURE_CLASSES as readonly string[]).includes(value)) {
        throw new Error(
          `unknown failure class: ${value ?? "(missing)"} (one of ${FAILURE_CLASSES.join("/")})`
        );
      }
      // 成员校验已在上面完成，此处收窄到联合类型
      filters.class = value as (typeof FAILURE_CLASSES)[number];
    } else if (flag === "--since") {
      filters.since = parseTimeBound(flag, argv[++i]);
    } else if (flag === "--until") {
      filters.until = parseTimeBound(flag, argv[++i]);
    } else if (flag === "--root") {
      root = argv[++i] ?? root;
    } else {
      throw new Error(`unknown option: ${flag} (${usage})`);
    }
  }
  writeOut(runSessionListCommand({ root: realpathSync(root), filters }));
}

// pigeon resume [sessionId] [参数]（决策 461）：在终端界面里续接，等同 pigeon --resume [sessionId]（不带会话号时弹出会话列表）
async function resumeMain(argv: string[]): Promise<void> {
  // 会话号可以写在参数之后（pigeon resume --yolo <会话号>）：挪到 --resume 后面
  const rest = [...argv];
  let at = -1;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? "";
    if (arg.startsWith("--")) {
      if (!VALUELESS_FLAGS.has(arg) && !arg.includes("=")) index++;
      continue;
    }
    at = index;
    break;
  }
  const sessionId = at >= 0 ? rest.splice(at, 1) : [];
  await launchTui(["--resume", ...sessionId, ...rest]);
}

// pigeon run [任务描述] [--root <dir>] [--governance-root <dir>] --stream-fn <模块路径> [--yolo] [--thinking <档位>] [--provider <p>]
//   [--model <m>] [--max-turns <N>] [--wall-clock <毫秒>] [--json]：headless 运行（M6.5 S1，决策 056）——
// 进程内 API runHeadless 的薄壳；任务描述缺省从 stdin 读；无审批通道，prompt 档 fail-closed；
// --json 退出时打印一行结构化结果；退出码按终态映射（HEADLESS_EXIT_CODES，1 为参数与装配错误）
async function runMain(argv: string[]): Promise<void> {
  const usage =
    "usage: pigeon run [task] [--root <dir>] [--governance-root <dir>] --stream-fn <module> [--yolo] [--thinking <level>] " +
    "[--max-turns <N>] [--wall-clock <ms>] [--no-hooks] [--no-web] [--no-pushed-memory] [--no-subagents] [--max-output-tokens <n>] [--context-window <n>] [--compact-threshold <n>] [--compact-keep <n>] " +
    "[--sandbox [--sandbox-network on|off] [--sandbox-approval yolo|prompt] [--sandbox-from-head]] [--trust-config] [--json]";
  let task: string | undefined;
  let json = false;
  let maxTurns: number | undefined;
  let wallClockMs: number | undefined;
  let editMode: EditMode | undefined;
  // 治理根（设置三层与 .pigeon/state 锚定的目录）：缺省与工作区根相同；指到工作区之外时，
  // 工作区自带的 .pigeon/ 设置不生效、程序状态不落工作区
  let governanceRootArg: string | undefined;
  // 决策 326 ③、341：只对本次运行放行未确认的会执行命令或放权的配置（不记下）
  let trustConfig = false;
  const modelArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--json") {
      json = true;
    } else if (arg === TRUST_CONFIG_FLAG) {
      trustConfig = true;
    } else if (arg === "--edit-mode") {
      editMode = parseEditMode(argv[++i], usage);
    } else if (arg === "--max-turns" || arg === "--wall-clock") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${arg} needs a positive integer (${usage})`);
      }
      if (arg === "--max-turns") {
        maxTurns = value;
      } else {
        wallClockMs = value;
      }
    } else if (arg === "--governance-root") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--governance-root needs a directory (${usage})`);
      }
      governanceRootArg = value;
    } else if (!arg.startsWith("--") && task === undefined) {
      task = arg;
    } else {
      modelArgv.push(arg);
      const next = argv[i + 1];
      if (!VALUELESS_FLAGS.has(arg) && next !== undefined && !next.startsWith("--")) {
        modelArgv.push(next);
        i++;
      }
    }
  }
  const flags = parseLaunchFlags(modelArgv, {
    usage,
    sessionSearch: true,
    pushedMemory: true,
    sandbox: true,
    subagents: true,
  });
  if (task === undefined) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    task = Buffer.concat(chunks).toString("utf8");
  }
  task = task.trim();
  if (task === "") {
    throw new Error(`task is empty (${usage})`);
  }
  const workspaceRoot = prepareWorkspace(flags.root);
  // 治理根缺省与工作区根相同；沙箱在一次性容器里重建工作区，分开的治理根进不去，同给即拒绝
  if (governanceRootArg !== undefined && flags.sandbox !== undefined) {
    throw new Error("--governance-root can't be used with --sandbox");
  }
  const governanceRoot =
    governanceRootArg !== undefined ? prepareWorkspace(governanceRootArg) : workspaceRoot;
  // 决策 325、326：旧布局检查与设置快照；未确认的会执行命令的配置在开跑前报错退出（--trust-config 只对本次放行）。
  // 设置与程序状态锚在治理根：--governance-root 分开时，工作区（题目仓库）自带的 .pigeon/ 与 .mcp.json 不生效
  let settings = await openSessionSettings(governanceRoot, {
    confirmation: { kind: "unattended", trustConfig },
  });
  // 决策 324：--no-hooks 只对本次运行停用全部钩子
  if (flags.noHooks) settings = withHooksDisabled(settings);
  // MODEL-030、MODEL-002…MODEL-019（决策 544）：给了 --stream-fn 时由插件提供模型、选择规则不介入；
  // 没给时按凭据、目录与上次选择定出型号（失败即抛规格原文）
  // 决策 548：代理变量非空时先装上代理 fetch（加载失败响亮报错）；pigeon run 只认环境变量凭据（决策 549）
  await installProxyFetch(process.env);
  const streamFn = await (async () => {
    if (flags.streamFnSpec !== undefined && flags.streamFnSpec !== "") {
      return loadStreamFn(resolveStreamFnSpec(flags, usage));
    }
    const access = await resolvePackagedModelAccess({
      settings,
      ...(flags.providerFlag !== undefined ? { provider: flags.providerFlag } : {}),
      ...(flags.modelFlag !== undefined ? { model: flags.modelFlag } : {}),
    });
    if (access.kind === "failed") throw new Error(access.text);
    flags.provider = access.provider;
    flags.modelId = access.modelId;
    return access.streamFn;
  })();
  // 决策 308：打转检测——设置的 loopGuard 一节（缺失取缺省即开着）
  const loopGuard = loopGuardSettingsOf(settings);
  const runOptions = {
    task,
    governanceRoot,
    settings,
    workspaceRoot,
    streamFn,
    yolo: flags.yolo,
    ...(editMode !== undefined ? { editMode } : {}),
    provider: flags.provider,
    modelId: flags.modelId,
    // MODEL-013：显式指定的型号在续接时优先于会话记录
    ...(flags.providerFlag !== undefined ? { providerFlag: flags.providerFlag } : {}),
    ...(flags.modelFlag !== undefined ? { modelFlag: flags.modelFlag } : {}),
    persistThinking: flags.persistThinking,
    ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    ...(flags.maxOutputTokens !== undefined ? { maxOutputTokens: flags.maxOutputTokens } : {}),
    ...(flags.compaction !== undefined ? { compaction: flags.compaction } : {}),
    // 决策 191、244：推送记忆缺省开着（--no-pushed-memory 关掉）；无人值守
    pushedMemory: flags.pushedMemory,
    // 决策 382：会话检索缺省开着（--no-session-search 关掉）
    sessionSearch: flags.sessionSearch,
    // 决策 294 B1：任务清单按设置的 tools.taskList（缺省开）
    taskList: taskListEnabledOf(settings),
    // 决策 287–291：联网工具缺省给出，--sandbox-network off 不给
    ...webToolsOptionOf(flags, settings),
    loopGuard,
    // 决策 457、481：主 agent 能派子 agent（--no-subagents 关掉；沙箱里第一段不提供）
    subagents: flags.subagents,
  };
  // 决策 237：--sandbox 在一次性容器里跑，返回前交回成分支并删除容器；提示行写标准错误，不混进 --json 的一行结果
  const result =
    flags.sandbox !== undefined
      ? await runHeadlessInSandbox(
          { ...runOptions, sessionId: newSessionId() },
          { flags, log: (line) => process.stderr.write(`[sandbox] ${line}\n`) }
        )
      : await runHeadless(runOptions);
  if (json) {
    // JSON.stringify 转义全部 C0 控制字符，一行输出不携带终端控制序列
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    writeOut(
      `session ${result.sessionId} | status ${result.status} | class: ${failureBadge(result.failure)} | ` +
        `${plural(result.turns, "turn")} | ${plural(result.toolCalls, "tool call")} | ` +
        `${plural(result.approvalsNeeded, "approval")} needed | ` +
        `${plural(result.usage.totalTokens, "token")} | label ${result.label}` +
        `${result.errorMessage !== undefined ? ` | ${result.errorMessage}` : ""}\n`
    );
  }
  // 决策 307：打转叫停的收尾说明（终态一行之后；--json 时已在结果里）
  if (!json && result.looping !== undefined) {
    writeOut(`${LOOP_GUARD_TEXTS.runStopped(result.looping)}\n`);
  }
  if ("sandboxNotice" in result && result.sandboxNotice !== undefined) {
    process.stderr.write(`[sandbox] ${result.sandboxNotice}\n`);
  }
  process.exitCode = HEADLESS_EXIT_CODES[result.status];
}

function parseEditMode(value: string | undefined, usage: string): EditMode {
  if (value === undefined || !isEditMode(value)) {
    throw new Error(`--edit-mode takes ${EDIT_MODES.join("/")} (${usage})`);
  }
  return value;
}

export async function main(argv: string[]): Promise<void> {
  const route = routeTopLevel(argv);
  if (route.kind === "help") {
    writeOut(`${TOP_LEVEL_HELP}\n`);
    return;
  }
  if (route.kind === "version") {
    writeOut(`pigeon ${pigeonVersion()} (${describeHarness(currentHarnessRef())})\n`);
    return;
  }
  if (route.kind === "tui") {
    await launchTui(route.argv);
    return;
  }
  if (argv[0] === "run") {
    await runMain(argv.slice(1));
    return;
  }
  if (argv[0] === "trace") {
    traceMain(argv.slice(1));
    return;
  }
  if (argv[0] === "replay") {
    replayMain(argv.slice(1));
    return;
  }
  if (argv[0] === "session" && argv[1] === "list") {
    sessionListMain(argv.slice(2));
    return;
  }
  if (argv[0] === "resume") {
    await resumeMain(argv.slice(1));
    return;
  }
  // pigeon sandbox list | clean：残留的沙箱容器
  if (argv[0] === "sandbox") {
    writeOut(await runSandboxCommand(argv.slice(1)));
    return;
  }
  // 决策 448：pigeon worktrees list | clean：留下的工作树与分支
  if (argv[0] === "worktrees") {
    writeOut(await worktreesMain(argv.slice(1)));
    return;
  }
  if (argv[0] === "migrate-config") {
    migrateConfigMain(argv.slice(1));
    return;
  }
  throw new Error(`unknown subcommand: ${argv[0]} (see pigeon --help)`);
}

// 顶层子命令：不带子命令即终端界面
const SUBCOMMANDS = new Set([
  "run",
  "trace",
  "replay",
  "session",
  "resume",
  "sandbox",
  "worktrees",
  "migrate-config",
]);

// 决策 448：在当前目录所在的仓库上列出或删除留下的工作树；终端里删除前问一次，没有终端须带 --yes
async function worktreesMain(argv: string[]): Promise<string> {
  const scope = { workspaceRoot: realpathSync(process.cwd()) };
  const confirm =
    process.stdin.isTTY === true
      ? async (question: string): Promise<boolean> => {
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/i.test((await rl.question(question)).trim());
          } finally {
            rl.close();
          }
        }
      : undefined;
  return runWorktreesCommand(argv, scope, confirm);
}

// pigeon migrate-config [--root <dir>]（决策 325）：旧配置并入三层设置、旧位置的程序状态移入 .pigeon/state/；可重复执行
function migrateConfigMain(argv: string[]): void {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root" && argv[i + 1] !== undefined) {
      root = argv[++i] ?? root;
    } else {
      throw new Error(`unknown option: ${flag} (${MIGRATE_CONFIG_USAGE})`);
    }
  }
  const result = runMigrateConfig(realpathSync(root));
  writeOut(`${result.lines.join("\n")}\n`);
}

export type TopLevelRoute =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "tui"; argv: string[] }
  | { kind: "subcommand" };

// 决策 267：pigeon 不带子命令即启动终端界面
export function routeTopLevel(argv: readonly string[]): TopLevelRoute {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === "help") {
    return { kind: "help" };
  }
  if (first === "--version") {
    return { kind: "version" };
  }
  if (first !== undefined && SUBCOMMANDS.has(first)) {
    return { kind: "subcommand" };
  }
  return { kind: "tui", argv: [...argv] };
}

// 终端界面入口（tui/main.ts）：与本文件同在 src 下
export const TUI_ENTRY = fileURLToPath(new URL("../tui/main.ts", import.meta.url));

// 终端界面子进程的参数（node 之后的部分）与附加环境变量（决策 351）：由入口决定。从源码启动的，子进程跑源码的 tui 入口；
// 从打包产物启动的，子进程跑同一个产物（moduleUrl 即产物地址），开 source map，经环境变量由产物入口分派到终端界面
export function tuiChildCommand(
  fromBundle: boolean,
  moduleUrl: string,
  execArgv: readonly string[],
  argv: readonly string[]
): { args: string[]; env?: Record<string, string> } {
  if (!fromBundle) {
    return { args: [...execArgv, fileURLToPath(new URL("../tui/main.ts", moduleUrl)), ...argv] };
  }
  return {
    args: [...execArgv, "--enable-source-maps", fileURLToPath(moduleUrl), ...argv],
    env: { [BUNDLE_ROLE_ENV]: "tui" },
  };
}

// 以子进程启动终端界面：继承终端，退出码原样带回。Ctrl+C 由界面自己处理（双击退出），本进程在其运行期间不响应
async function launchTui(argv: readonly string[]): Promise<void> {
  const ignore = (): void => {};
  process.on("SIGINT", ignore);
  const command = tuiChildCommand(FROM_BUNDLE, import.meta.url, process.execArgv, argv);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, command.args, {
        stdio: "inherit",
        ...(command.env !== undefined ? { env: { ...process.env, ...command.env } } : {}),
      });
      child.on("error", reject);
      child.on("exit", (exitCode, signal) => {
        resolve(exitCode ?? (signal !== null ? 1 : 0));
      });
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", ignore);
  }
}

// 顶层帮助（pigeon --help）与未知子命令提示
export const TOP_LEVEL_HELP = [
  "usage:",
  "  pigeon [options]              start the terminal UI",
  "  pigeon --continue [options]   resume the most recent session in this project",
  "  pigeon --resume [sessionId]   resume a session in the terminal UI",
  "  pigeon run [task] [options]   run a task unattended",
  "  pigeon resume [sessionId]     same as pigeon --resume [sessionId]",
  "  pigeon trace <sessionId>      show a session's trace",
  "  pigeon replay <runId>         replay a run",
  "  pigeon session list           list this project's sessions",
  "  pigeon sandbox list|clean     list or clean leftover sandbox containers",
  "  pigeon worktrees list|clean   list or delete leftover worktrees and branches",
  `  pigeon migrate-config         merge old config into settings.json; move old state into ${pigeonRel("state")}/`,
  "  pigeon sandbox cache|clear-cache  show or clear the shared sandbox download cache",
].join("\n");

// 仅作为入口直接运行时执行；被 import 时不启动。打包产物里由产物入口（src/bundle-entry.ts）分派，这里不判断
if (
  !FROM_BUNDLE &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
