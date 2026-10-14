// Pigeon TUI 入口（M2 S2 壳 + S3 审批面板与 /grants 视图 + S4 会话列表与恢复入口）。
// 用法：pigeon [--yolo] [--root <工作区根>] --stream-fn <模块路径>（亦可 node src/tui/main.ts 直接启动）
//   [--provider <名>] [--model <id>]
// 审批 handler（决策 025 的注入点）：面板版——prompt 档在消息区渲染审批块，四键
// [y/n/a/d] 决议（S3）；deny/grant/固化配置/yolo/read 五档在 Adapter 排律内求值，
// 不经过 handler（src/tools/policy.ts 六档排律）。
// 恢复入口（S4）：/resume <sessionId> 的对账流程在 application/resume.ts；本入口提供
// rebind 工厂——按 cli resume 同一配方（restoredGrants 种子 + buildRuntime + 旧运行面
// 释放）装配目标会话运行面，壳换绑后同 sessionId 续跑（重启 TUI 恢复已有会话的路径：
// 重启后进 /resume）。
// M5.5 S4（决策 040）：主会话与各 worker 的审批经同一队列汇聚到面板（一次一个）；每个会话运行面
// 配一个编排器（/spawn /cancel /workers）；恢复 worker 会话时回到它自己的工作树与委派策略，
// 且其编排器按深度 1 拒绝再派。一个窗口一个进程：退出时先取消在跑的 worker 并等其收尾记录落盘。
// 决策 264–268：主会话另给主 agent 注册 spawn_worker（--no-spawn-workers 关掉；沙箱里不派 worker），与 /spawn 共用同一个
// 编排器——同时在跑的上限对人派的与 agent 派的一并计算；agent 派出的个数按每条输入（一次运行）计。
// 决策 267：pigeon 不带子命令即启动本界面（决策 461：命令行对话已去掉）。
// 决策 286：pigeon --continue 接本项目最近的主会话、--resume <id> 接指定会话（启动时直接打开，不另建空会话），
// --resume 不带会话号开壳后弹出会话选择器；运行期告警在壳接管终端期间落消息区（之前与之后照旧写标准错误输出）；
// 输入历史按项目存在 .pigeon/state/tui-history.json。
// 决策 301：编排面接上编排器的只读观察口、发消息与续做（编排面板、树形视图、进入 worker 会话），树形视图按任务清单标注。

import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createSessionAttemptRunner } from "../application/attempt-group.ts";
import type { CheckpointAttachment } from "../application/checkpoints.ts";
import {
  configView,
  setUserConfig,
  setUserKeybinding,
  userKeybindings,
} from "../application/config-options.ts";
import {
  EnterWorktreeSlot,
  recordWorktreeEntry,
  worktreeContinueNotice,
} from "../application/enter-worktree-tool.ts";
import { runForkCommand } from "../application/fork-command.ts";
import { pigeonVersion } from "../application/harness-ref.ts";
import {
  type LaunchFlags,
  orchestrationSettingsOf,
  parseLaunchFlags,
  resolveStreamFnSpec,
  webToolsOptionOf,
} from "../application/launch-flags.ts";
import {
  editMemoryLayer,
  memoryViewText,
  resolveEditor,
  spawnEditor,
} from "../application/memory-command.ts";
import {
  closeNamedWorktree,
  type NamedWorktree,
  namedWorktreeRepoRoot,
  openNamedWorktree,
  reopenNamedWorktree,
} from "../application/named-worktree.ts";
import { restoreSessionWorkers } from "../application/previous-workers.ts";
import { promptHistoryStore } from "../application/prompt-history.ts";
import {
  applyRewind,
  checkCode,
  loadRewindTree,
  type PreparedRewind,
  prepareRewind,
  prepareUndo,
  type RewindHost,
} from "../application/rewind.ts";
import type { ApprovalModeCell } from "../application/runtime.ts";
import {
  disposeRuntime,
  loadStreamFn,
  type MemoryWriteConfig,
  type RuntimeBundle,
} from "../application/runtime.ts";
import {
  closeSandbox,
  exportSandbox,
  type Sandbox,
  sandboxStatusFacts,
  startSandbox,
} from "../application/sandbox-session.ts";
import { sessionNameOf, validSessionName } from "../application/session-name.ts";
import {
  type OpenedSessionRuntime,
  openSessionRuntime,
  pushedMemoryRunOptions,
} from "../application/session-runtime.ts";
import {
  openSessionSettings,
  parseTrustAnswer,
  type TrustChoice,
  trustPromptText,
} from "../application/session-settings.ts";
import { createSettingsReloader } from "../application/settings-reload.ts";
import { bindSpawnWorkers } from "../application/spawn-worker-host.ts";
import { takeWorkerChanges } from "../application/take-worker-tool.ts";
import { renderTaskList } from "../application/task-list-tool.ts";
import { closeTuiSession } from "../application/tui-exit.ts";
import type { WorkerNotices } from "../application/worker-notices.ts";
import { createSessionWorkers } from "../application/workers.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import { createTuiWorktreesFace, isGitWorkspace } from "../application/worktree-cleanup.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { createApprovalQueue } from "../approvals/queue.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import type { TrustEntry } from "../state/config-trust.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import { FROM_BUNDLE } from "../state/package-paths.ts";
import { tuiLogDirOf } from "../state/paths.ts";
import {
  keybindingsSectionOf,
  loopGuardSettingsOf,
  memoryLimitsOf,
  withHooksDisabled,
  worktreeSectionOf,
} from "../state/settings.ts";
import { worktreeBaseModeOf } from "../state/worktree-config.ts";
import { createTuiApprovalHandler, type TuiApprovalFace } from "./approval.ts";
import { readWindowsClipboard } from "./clipboard.ts";
import { KEYBINDING_ID_PREFIX } from "./config-panel.ts";
import { resolveStartTarget, takeContinueFlags } from "./continue-flags.ts";
import { findFdPath } from "./fd-path.ts";
import { keybindingRows } from "./keybindings.ts";
import { guardTuiAgent } from "./loop-guard-view.ts";
import { createSessionPool } from "./main-pool.ts";
import {
  type MainReloadContext,
  reopenMainSessionForReload,
  spawnWorkerOption,
} from "./main-reload.ts";
import { PigeonTuiShell, type TuiShellOptions, type TuiWorkersFace } from "./shell.ts";
import { installTerminalReset } from "./terminal-reset.ts";
import { switchableWarn } from "./warn-sink.ts";
import { modelLabelOf, tildePath } from "./welcome.ts";
import { takeWorktreeFlag } from "./worktree-flag.ts";
import { createWorktreeSwitch } from "./worktree-switch.ts";

// 退出时等 worker 收尾记录落盘的上限（毫秒）：超时仍退出，缺 settled 由冷侧如实标注
const WORKER_SHUTDOWN_GRACE_MS = 5000;

// 参数解析与装配都在 application 层（决策 067）：启动参数在 launch-flags.ts（与 cli、headless 同一份、
// 同一批缺省），会话运行面在 session-runtime.ts（作用域、grant 种子、MCP 启动、装配失败关 server）
const USAGE =
  "usage: pigeon [--yolo] [--no-persist-thinking] [--no-pushed-memory] [--no-hooks] [--no-web] [--no-spawn-workers] [--worker-concurrency <n>] [--worker-limit <n>] [--history-limit <n>] [--root <dir>] --stream-fn <module> " +
  "[--provider <name>] [--model <id>] [--thinking <level>] [--max-output-tokens <n>] [--context-window <n>] [--compact-threshold <n>] [--compact-keep <n>] " +
  "[--sandbox [--sandbox-network on|off] [--sandbox-approval yolo|prompt] [--sandbox-from-head]] [--continue | --resume [sessionId]]";

// 决策 445：壳退出之后在标准错误输出上问一句（EOF 为 null）
async function askOnStderr(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

// 决策 326 ③：壳接管终端之前，在标准错误输出上逐行问答确认会执行命令的配置
async function askTrustOnStderr(entries: readonly TrustEntry[]): Promise<TrustChoice> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = await rl.question(`${trustPromptText(entries)}\n> `);
      const choice = parseTrustAnswer(answer);
      if (choice !== undefined) return choice;
    }
  } finally {
    rl.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  // 壳接管终端之前的提示与报错先存着，壳起来后落消息区（全屏之前写到标准错误输出的会被备用屏盖住，看不见）
  const early: Array<{ line: string; alert: boolean }> = [];
  process.once("exit", () => {
    for (const item of early.splice(0)) process.stderr.write(`${item.line}\n`);
  });
  const continued = takeContinueFlags(argv);
  // 决策 445：--worktree <名字> 在独立工作树里开会话
  const worktreeFlag = takeWorktreeFlag(continued.argv);
  const flags: LaunchFlags = parseLaunchFlags(worktreeFlag.argv, {
    usage: USAGE,
    historyLimit: true,
    pushedMemory: true,
    sessionSearch: true,
    sandbox: true,
    spawnWorkers: true,
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, USAGE));
  // 工作区准备（决策 034）：realpath 规范化，与 cli 入口同一份；
  // 它同时是治理根（.pigeon/ 恒在主仓库根，决策 040）。决策 445：--worktree 时治理根为主仓库根，工作区为独立工作树
  const launchRoot = prepareWorkspace(flags.root);
  if (worktreeFlag.name !== undefined) {
    if (flags.sandbox !== undefined) throw new Error("--worktree can't be used with --sandbox");
    if (continued.mode.kind !== "new") {
      throw new Error("--worktree can't be used with --continue or --resume");
    }
  }
  const governanceRoot =
    worktreeFlag.name !== undefined ? namedWorktreeRepoRoot(launchRoot) : launchRoot;
  // 决策 325、326：旧布局检查、读三层设置成本会话快照、确认会执行命令的条目（壳接管终端之前，行内问答）。
  // 本进程内的会话（含 /resume 换绑、worker、沙箱会话）都用这一份快照，直到 /reload 换上新快照（决策 340）
  let settings = await openSessionSettings(governanceRoot, {
    confirmation: { kind: "interactive", ask: askTrustOnStderr },
    notice: (line) => console.error(line),
  });
  // 决策 324：--no-hooks 只对本次运行停用全部钩子（清单清空 + disableAllHooks，随快照冻进运行面）
  if (flags.noHooks) settings = withHooksDisabled(settings);
  // 决策 445：建立或打开独立工作树（壳接管终端之前，提示打到 stderr）；起点档位取设置的 worktree 一节
  const namedWorktree =
    worktreeFlag.name !== undefined
      ? openNamedWorktree({
          cwd: governanceRoot,
          name: worktreeFlag.name,
          baseMode: worktreeBaseModeOf(worktreeSectionOf(settings)),
          notice: (line) => early.push({ line, alert: true }),
        })
      : undefined;
  // 取远端默认分支失败、退回了 HEAD：报一行（没有远端默认分支不算报错）
  if (namedWorktree?.created === true && namedWorktree.fetchFailed === true) {
    early.push({ line: `worktree base: ${namedWorktree.baseLabel}`, alert: true });
  }
  // 决策 446：会话移进工作树后换成工作树（worker 编排、取用等闭包按它取）
  let workspaceRoot = namedWorktree?.path ?? governanceRoot;
  // 决策 445、446：本会话当前所在的独立工作树（退出时按它清理）
  let activeWorktree: NamedWorktree | undefined = namedWorktree;
  // 决策 445、446：独立工作树开着期间持有它的在用锁（退出清理与 /worktrees clean 据此不删别人开着的）
  let releaseWorktreeUse: (() => void) | undefined =
    namedWorktree !== undefined ? holdWorktreeInUse(namedWorktree.path) : undefined;
  const enterWorktreeSlot = new EnterWorktreeSlot();
  // 决策 297–303：编排设定——设置的 orchestration 一节（缺失取缺省），--worker-concurrency 与 --worker-limit 优先
  let orchestration = orchestrationSettingsOf(flags, settings);
  // 决策 308：打转检测——设置的 loopGuard 一节（缺失取缺省即开着）
  let loopGuard = loopGuardSettingsOf(settings);
  // 决策 287–291、346：联网工具——--no-web、web.enabled 为 false、沙箱断网档任一成立就不给；配置畸形在此响亮失败。
  // /reload 换上新快照后经同一函数重算
  const webToolsFor = (snapshot: typeof settings) => webToolsOptionOf(flags, snapshot);
  let webToolsOption = webToolsFor(settings);
  // 决策 286：启动时打开哪个会话（新会话，或 --continue / --resume <id> 直接续接）；会话不存在等在接管终端前报错
  const target = resolveStartTarget(governanceRoot, continued.mode, flags.sandbox !== undefined);
  if (target.kind === "new" && target.note !== undefined) {
    early.push({ line: target.note, alert: false });
  }
  const resumed = target.kind === "resume";
  const sessionId = target.kind === "resume" ? asSessionId(target.sessionId) : newSessionId();
  // 决策 286：运行期告警的出口——壳接管终端期间落消息区，之前与之后写标准错误输出（去重与文案由告警方负责）
  const warnSink = switchableWarn();
  const warn = warnSink.warn;
  // S3 面板版审批 handler：face 晚绑定——buildRuntime 收 handler 工厂时壳尚未构造；
  // 壳未就位即收到审批请求属装配级故障，工厂内 fail-closed 按拒绝处理
  const faceHolder: { current: TuiApprovalFace | undefined } = { current: undefined };
  // M5.5 S3：主会话与各 worker 的审批经同一队列，一次一个
  const approvalQueue = createApprovalQueue();
  const createHandler = (grants: SessionGrantStore) =>
    approvalQueue.wrap(createTuiApprovalHandler(grants, () => faceHolder.current));
  // 决策 297：worker 完成通知显示在消息区、空闲时叫醒主 agent——壳晚于编排器构造，晚绑定
  const shellHolder: { current: PigeonTuiShell | undefined } = { current: undefined };
  // 决策 331：有人对话，带记忆工具（写入的内容在工具调用行里，消息区不另写一行）
  const memoryWrite: MemoryWriteConfig = { source: "tui" };
  // 壳起来之前的放进 early，起来之后直接落消息区（报错醒目，其余弱化）
  const say = (line: string, alert: boolean): void => {
    const shell = shellHolder.current;
    if (shell === undefined) early.push({ line, alert });
    else if (alert) shell.addAlert(line);
    else shell.addSystem(line);
  };
  // 决策 331、332：/memory 的上下文（两层上限取本会话的设置快照）
  const memoryContext = { governanceRoot: governanceRoot, limits: memoryLimitsOf(settings) };
  const workersFor = (
    opened: OpenedSessionRuntime,
    parentSessionId?: SessionId
  ): TuiWorkersFace => {
    const { bundle } = opened;
    // 决策 446：worker 编排与取用一律按这个运行面自己的工作区（移进独立工作树后即工作树），不读外层可变的工作区
    const workspaceRoot = opened.scope.workspaceRoot;
    const deps = {
      governanceRoot: governanceRoot,
      workspaceRoot,
      bundle,
      // worker 请求自带其会话的放权落点；此处绑定的父会话存储只是缺省
      approvals: createHandler(bundle.grantStore),
      streamFn,
      provider: flags.provider,
      modelId: flags.modelId,
      persistThinking: flags.persistThinking,
      ...(flags.thinkingLevel !== undefined ? { thinkingLevel: flags.thinkingLevel } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      // 决策 297–303：编排设定；同时在跑的上限对人用 /spawn 派的与 agent 派的一并计算
      settings: orchestration,
      // 决策 287–291：worker 与主会话同样拿到联网工具
      ...webToolsOption,
      storeWarn: warn,
      // 决策 307：worker 打转以 looping 失败交回并通知主 agent
      loopGuard,
    };
    const orchestrator = createSessionWorkers(deps);
    // 权威链审计 ②、③：续接的主会话从会话记录找回之前运行的 worker，补递没递出的完成通知（有通知队列时）
    let notices: WorkerNotices | undefined;
    // 决策 264：主会话注册了 spawn_worker 时绑定编排器；agent 派出的个数按一次运行（每条输入）计
    if (opened.spawnWorker !== undefined && parentSessionId === undefined) {
      let runKey: string | undefined;
      bundle.adapter.subscribe((event) => {
        runKey = event.runId;
      });
      const bound = bindSpawnWorkers({
        slot: opened.spawnWorker,
        orchestrator,
        workspaceRoot,
        hostSessionId: bundle.adapter.sessionId,
        runKey: () => runKey,
        // 决策 297：完成通知进主 agent 的下一轮，空闲时叫醒它（通知是给模型的原文，不显示在消息区）
        target: bundle.adapter,
        wake: () => shellHolder.current?.runNotices(),
        onNotice: () => shellHolder.current?.render(),
      });
      notices = bound.notices;
    }
    if (opened.restored !== undefined && parentSessionId === undefined) {
      restoreSessionWorkers({
        orchestrator,
        governanceRoot: governanceRoot,
        sessionId: bundle.adapter.sessionId,
        ...(notices !== undefined ? { notices } : {}),
        ...(opened.spawnWorker !== undefined ? { settings: opened.spawnWorker.settings } : {}),
      });
    }
    return {
      // 人用 /spawn 派出的：收尾显示在消息区，不另发完成通知
      spawn: (request) => orchestrator.spawn({ ...request, origin: "human" }),
      // 决策 294、301：生命周期事件驱动编排面板；只读观察口给面板、树形视图与进入的 worker 会话
      subscribe: (listener) => orchestrator.subscribe((event) => listener(event)),
      observe: (listener) => orchestrator.observe(listener),
      // 决策 301：进入 worker 会话后发消息、补批续做
      send: (id, text) => orchestrator.send(id, text),
      resume: (id, options) => orchestrator.resume(id, options),
      cancel: (id) => orchestrator.cancel(id),
      status: () => orchestrator.status(),
      awaitResult: (id) => orchestrator.awaitResult(id),
      // M7（决策 069）：并行同任务派发只在主会话提供（worker 会话按深度 1 不能再派）
      ...(parentSessionId === undefined
        ? {
            // 决策 279：/take 与 take_worker 同一套逻辑与文字
            take: async (name: string) =>
              takeWorkerChanges({ orchestrator, workspaceRoot }, name, "human").text,
            spawnAttempts: createSessionAttemptRunner({ orchestrator }),
            // M7（决策 079）：/fork 手动分叉
            fork: (args: string) =>
              runForkCommand({
                governanceRoot: governanceRoot,
                opened,
                args,
                run: {
                  streamFn,
                  provider: flags.provider,
                  modelId: flags.modelId,
                  yolo: flags.yolo,
                  persistThinking: flags.persistThinking,
                  ...(flags.thinkingLevel !== undefined ? { thinking: flags.thinkingLevel } : {}),
                  ...(flags.compaction !== undefined ? { compaction: flags.compaction } : {}),
                  ...pushedMemoryRunOptions(flags),
                },
              }),
          }
        : {}),
    };
  };
  // 壳尚未接管终端：启动问题（单个 server 起不来不挡会话）与注解配置冲突（052）直接打到 stderr，
  // 冷侧另见 Run 开始条目 的工具集摘要与 server 状态
  // 决策 237：--sandbox 先开容器（壳尚未接管终端，提示打到 stderr）；与沙箱不相容的参数在起容器之前报错
  const sandbox: Sandbox | undefined = await startSandbox({
    flags,
    governanceRoot: governanceRoot,
    settings,
    sessionId,
    ...(resumed ? { resume: true } : {}),
    log: (line, progress) => {
      if (progress === true) console.error(`[sandbox] ${line}`);
      else say(`[sandbox] ${line}`, true);
    },
    // 决策 333：运行中的提示（命令超出内存上限）经告警出口：壳接管终端期间落消息区
    notice: (line) => warn(`[sandbox] ${line}`),
  });
  // 决策 469：主会话的审批模式单元——开局按启动参数（--yolo、沙箱的审批参数），Shift+Tab 切换；/reload、换工作树、
  // /resume 换会话都沿用（续接按启动参数，指重新启动程序）
  const mainModeCell: ApprovalModeCell = { current: flags.yolo ? "yolo" : "prompt" };
  // 决策 340：/reload 重建主会话运行面时跨快照不变的部分（重建本身在 main-reload.ts）
  const reloadContext: MainReloadContext = {
    approvalModeCell: mainModeCell,
    governanceRoot: governanceRoot,
    // 决策 445：独立工作树里的会话，/reload 重建时工作区仍是工作树（第一条消息之前会话文件还没建，推导不出）
    ...(namedWorktree !== undefined ? { workspaceRoot: namedWorktree.path } : {}),
    ...(sandbox === undefined
      ? {
          enterWorktree: enterWorktreeSlot,
        }
      : {}),
    streamFn,
    flags,
    ...(sandbox !== undefined
      ? { workspaceHost: sandbox.host, statusFacts: sandboxStatusFacts(sandbox) }
      : {}),
    warn,
    createApprovalHandler: createHandler,
    memoryWrite,
    memoryContext,
    webToolsFor,
    hooksNotice: (line) => say(line, true),
    onMcpNote: (note) => say(`[mcp] ${note}`, true),
  };
  const mainOpened = await openSessionRuntime({
    approvalModeCell: mainModeCell,
    governanceRoot: governanceRoot,
    // 决策 436：会话回退要用发消息时的快照
    turnSnapshots: true,
    ...(namedWorktree !== undefined ? { workspaceRoot: namedWorktree.path } : {}),
    ...(sandbox === undefined
      ? {
          enterWorktree: enterWorktreeSlot,
        }
      : {}),
    settings,
    sessionId,
    streamFn,
    flags,
    ...(sandbox !== undefined
      ? { workspaceHost: sandbox.host, statusFacts: sandboxStatusFacts(sandbox) }
      : {}),
    ...spawnWorkerOption(flags, orchestration),
    taskList: orchestration.taskList,
    ...webToolsOption,
    warn,
    memoryWrite,
    createApprovalHandler: createHandler,
    // 决策 183、286：--continue / --resume <id> 直接续接——还原对话上下文；
    // 决策 432：新开的会话等第一次真要落盘时才建会话文件
    ...(resumed ? { resume: true } : { deferSessionFile: true }),
    // 决策 324：钩子拦下或出错的一行提示落消息区（壳尚未接管终端时落壳持有格，接管后进消息区）
    hooksNotice: (line) => say(line, true),
    onMcpNote: (note) => say(`[mcp] ${note}`, true),
  }).catch(async (error: unknown) => {
    await sandbox?.discard().catch(() => {});
    throw error;
  });
  const mainBundle = mainOpened.bundle;
  // 决策 445、446：续接的会话开在独立工作树里（--continue、--resume）：工作区与退出清理跟着它
  adoptWorkspace(mainOpened.scope.workspaceRoot);
  guardMainAgent(mainBundle);
  // 当前运行面持有格（S4）：/resume 换绑整体替换；进程退出只释放当前格。沙箱里不派 worker（会越出容器）
  // 决策 350：checkpoints 为本格的快照挂载，换走本格之前先等它未完成的快照
  let slot: {
    sessionId: SessionId;
    bundle: RuntimeBundle;
    workers?: TuiWorkersFace;
    checkpoints?: CheckpointAttachment;
  } = {
    sessionId,
    bundle: mainBundle,
    ...(mainOpened.checkpoints !== undefined ? { checkpoints: mainOpened.checkpoints } : {}),
    ...(sandbox === undefined
      ? { workers: workersFor(mainOpened, mainOpened.scope.parentSessionId) }
      : {}),
  };
  // 决策 456：当前会话的名字（会话记录里记的，没改过名为缺省名）；/rename 改它并记进会话记录，换会话时换成目标会话自己的
  let sessionName = sessionNameOf(governanceRoot, slot.sessionId, workspaceRoot);
  // 决策 433–438：会话回退的运行面（每次按当前的 slot 现取）
  // 决策 443：会话面板（进程内版）：派出的会话进各自的工作树；沙箱会话不开。退出时全部停止
  let poolExiting = false;
  const sessionPool =
    sandbox === undefined
      ? createSessionPool({
          governanceRoot,
          streamFn,
          flags,
          settings: () => settings,
          warn,
          createApprovalHandler: createHandler,
          memoryWrite,
          webToolsFor,
          mainWorkspace: () => workspaceRoot,
          // 决策 469：派出的会话沿用主会话当时的审批模式
          approvalMode: () => mainModeCell.current,
          notice: (line, alert) => {
            if (poolExiting) console.error(line);
            else if (alert === true) shellHolder.current?.addAlert(line);
            else shellHolder.current?.addSystem(line);
          },
        })
      : undefined;
  const rewindHost = (): RewindHost => {
    const bundle = slot.bundle;
    return {
      workspaceRoot,
      sessionStore: bundle.sessionStore,
      ...(slot.checkpoints !== undefined ? { checkpoints: slot.checkpoints } : {}),
      adapter: bundle.adapter,
      status: bundle.status,
      prune: bundle.prune,
      ...(bundle.taskList !== undefined ? { taskList: bundle.taskList } : {}),
      grants: bundle.grantStore,
    };
  };
  // 决策 453：状态栏与欢迎头的模型名
  const modelLabel = modelLabelOf(slot.bundle.modelInfo);
  const shell = new PigeonTuiShell({
    terminal: new ProcessTerminal(),
    // 决策 439：键位（设置的 keybindings 一节）
    ...(keybindingsSectionOf(settings) !== undefined
      ? { keybindings: keybindingsSectionOf(settings) }
      : {}),
    // 决策 433–438：会话回退——按当前运行面现取（/reload、/resume 换了运行面之后照样对）；没有快照的会话只退对话
    ...(sessionPool !== undefined ? { pool: sessionPool.face } : {}),
    rewind: {
      tree: () => loadRewindTree(rewindHost()),
      prepare: (to: string | null) => prepareRewind(rewindHost(), to),
      prepareUndo: () => prepareUndo(rewindHost()),
      check: (prepared: PreparedRewind) => checkCode(rewindHost(), prepared),
      apply: (prepared: PreparedRewind, options: Parameters<typeof applyRewind>[2]) =>
        applyRewind(rewindHost(), prepared, options),
    },
    // 决策 442：/config 设置面板——生效值取本会话当前的设置快照，改动写用户级设置（随后壳按 /reload 重建）
    config: {
      view: () => configView(settings),
      // 决策 465：键位组的改动名字带 keybindings: 前缀（值为键，空串 = 清空，default = 恢复缺省）
      set: (id: string, value: string) =>
        id.startsWith(KEYBINDING_ID_PREFIX)
          ? setUserKeybinding(
              governanceRoot,
              id.slice(KEYBINDING_ID_PREFIX.length),
              value === "default" ? undefined : value === "" ? [] : [value]
            )
          : setUserConfig(governanceRoot, id, value),
      keys: () => keybindingRows(userKeybindings(governanceRoot)),
      // 有 worker 在跑或排队时重建不了运行面（与 /reload 同一口径）：先不改，免得写了不生效
      busy: () =>
        slot.workers
          ?.status()
          .some((worker) => worker.state === "running" || worker.state === "queued") === true
          ? "workers are running; wait for them to finish or /cancel them"
          : undefined,
    },
    // 决策 439：输入框补全，路径与 @ 引用以工作区为根
    autocomplete: { basePath: workspaceRoot, fdPath: findFdPath() },
    // 决策 441：Windows 上右键粘贴取系统剪贴板
    ...(process.platform === "win32" ? { readClipboard: readWindowsClipboard } : {}),
    runtime: slot.bundle.adapter,
    // 决策 469：主会话的审批模式（状态栏显示、Shift+Tab 切换）；重建运行面后取新的
    approvalMode: () => slot.bundle.approvalMode,
    // 决策 470：输入框为空时按两下 ← 打开会话面板（设置可关；/reload 后取新的）
    leftArrowOpensPanel: () => settings.merged.tui?.leftArrowOpensPanel !== false,
    sessionId: slot.sessionId,
    // 决策 325：终端界面日志在程序状态目录下
    logDir: tuiLogDirOf(governanceRoot),
    // 决策 451：欢迎头（版本、模型、当前目录）；决策 453：模型名取运行面的模型信息（接入模块声明的优先，其次启动参数），
    // 只有占位标签时不显示。决策 468：状态栏不写模型名
    welcome: {
      version: pigeonVersion(),
      ...(modelLabel !== undefined ? { model: modelLabel } : {}),
      cwd: tildePath(workspaceRoot, homedir()),
    },
    provider: flags.provider,
    promptHistory: promptHistoryStore(governanceRoot),
    // S3：/grants /revoke /grants save 的命令上下文（命令层在 application/grants.ts）
    grants: {
      root: governanceRoot,
      store: slot.bundle.grantStore,
      configRules: slot.bundle.configGrants,
      layeredRules: slot.bundle.settings.grants,
    },
    // 决策 323、324：本会话的钩子面（会话级事件与 /hooks；清单随开局快照冻结，/reload 换新的）
    hooks: mainBundle.hooks,
    // 决策 323：收尾钩子的连续拦截上限取设置快照（/reload 后跟着变）
    stopHookCap: () => settings.merged.stopHookBlockCap,
    // 会话目录所在的根（花费累计用）
    sessions: { root: governanceRoot },
    // M5 S2（决策 045）：/resume 历史渲染上限
    ...(flags.historyLimit !== undefined ? { historyLimit: flags.historyLimit } : {}),
    // M5.5 S4：/spawn /cancel /workers（沙箱里不提供）
    ...(slot.workers !== undefined ? { workers: slot.workers } : {}),
    // 决策 245：沙箱会话的 /export 手动交回
    ...(sandbox !== undefined
      ? { sandbox: { exportChanges: () => exportSandbox(sandbox, slot.bundle.jobs) } }
      : {}),
    // S4：/resume <sessionId> 的换绑工厂——续会话入口同一配方：
    // restoredGrants 种子（决策 3b，还原目标会话的生效 grant，静默继续有效）+
    // buildRuntime + 旧运行面释放。先建后换：装配失败（如 grants.json 畸形）时
    // 旧运行面不受影响，壳继续留在原会话
    // 沙箱会话里不提供换绑（命令给出原因）
    ...(sandbox !== undefined ? {} : { resume: resumeOptions() }),
    // 决策 340：/reload 重读设置，新快照自下一轮起生效
    reload: createSettingsReloader({
      current: () => settings,
      // 决策 324：--no-hooks 是本次运行的进程级开关，/reload 重读出的新快照同样停用钩子
      ...(flags.noHooks ? { hooksDisabled: true } : {}),
      busy: () =>
        slot.workers
          ?.status()
          .some((worker) => worker.state === "running" || worker.state === "queued") === true
          ? "workers are running; wait for them to finish or /cancel them"
          : undefined,
      sandboxSessionId: () => (sandbox !== undefined ? slot.sessionId : undefined),
      apply: (snapshot) => rebuildMain(snapshot),
    }),
    // 决策 294 B1：/tasks 查看当前会话的任务清单（换绑后跟着当前会话）
    tasks: () => {
      const list = slot.bundle.taskList;
      return list !== undefined ? renderTaskList(list.items()) : undefined;
    },
    // 决策 301：树形视图按标签标出清单项（换绑后跟着当前会话）
    taskItems: () => slot.bundle.taskList?.items(),
    // 决策 331：/memory 查看与编辑两层记忆（编辑时暂停界面打开 $VISUAL / $EDITOR）
    memory: {
      view: () => memoryViewText(memoryContext),
      edit: (layer, hooks) =>
        editMemoryLayer(memoryContext, layer, {
          ...editorOption(),
          ...(hooks?.signal !== undefined ? { signal: hooks.signal } : {}),
          ...(hooks?.onWaiting !== undefined ? { onWaiting: hooks.onWaiting } : {}),
          // 壳晚于选项构造：经持有格取
          run: (editor, file) =>
            shellHolder.current?.suspendFor(() => spawnEditor(editor, file)) ??
            spawnEditor(editor, file),
        }),
    },
    // 决策 446：模型调了 enter_worktree 的那一轮收尾后，按 /reload 的先建后换移进工作树，再递一条通知让 agent 接着做
    afterTurn: (info) => worktreeSwitch.afterTurn(info),
    // 决策 456：/rename 改当前会话的名字——记进会话记录（续接后还在）；沙箱里照样能改。改成了回一行简短结果（会话名不在
    // 主视图上，看不到别处变化）
    renameSession: (name: string) => {
      if (!validSessionName(name)) {
        return "invalid name: use letters, digits, _, - and . (max 40)";
      }
      slot.bundle.sessionStore.setName(name);
      sessionName = name;
      return `renamed to ${name}`;
    },
    // 决策 456：会话名（面板上当前会话的卡片、/take 的说明用）
    sessionName: (id: string) =>
      id === slot.sessionId ? sessionName : sessionNameOf(governanceRoot, id, workspaceRoot),
    // 决策 448：/worktrees 列出与删除留下的 worker 工作树（git 仓库、不在沙箱里才有）
    ...(sandbox === undefined && isGitWorkspace(governanceRoot)
      ? {
          worktrees: createTuiWorktreesFace({
            workspaceRoot: governanceRoot,
            // 本进程里仍可能用到工作树的 worker：在跑、排队、等补批续做
            liveWorkers: () =>
              new Set(
                (slot.workers?.status() ?? [])
                  .filter(
                    (status) =>
                      status.state === "running" ||
                      status.state === "queued" ||
                      status.outcome?.recoverable === true
                  )
                  .map((status) => status.sessionId)
              ),
          }),
        }
      : {}),
    // S5+（裁决 033）：双击 Ctrl+C / /quit 的真实退出路径——壳内已先 stop()
    //（dispose 对称、挂起审批 fail-closed），此处只释放当前运行面并退进程
    onExit: release,
  });
  // 决策 305–307：主 agent 的打转检测（见 loop-guard-view.ts）。换绑后的会话同样挂上；运行面释放时一并摘掉。
  // 后台作业的结束通知同在这里接到壳上
  function guardMainAgent(bundle: RuntimeBundle): void {
    const detach = guardTuiAgent({
      runtime: bundle.adapter,
      settings: loopGuard,
      shell: () => shellHolder.current,
    });
    bundle.disposers = [...(bundle.disposers ?? []), async () => detach()];
    // 决策 365：后台作业结束时主 agent 空闲即叫醒它（同 worker 完成通知；通知是给模型的原文，不显示在消息区）。
    // 消息区另写一行简短结果（作业号、结束状态与命令）：界面上没有别处列后台作业
    bundle.jobNotices?.bind({
      wake: () => shellHolder.current?.runNotices(),
      onNotice: () => shellHolder.current?.render(),
      onEnded: (line) => shellHolder.current?.addSystem(line),
    });
  }
  // 决策 340：/reload 的先建后换；决策 446：会话移进工作树时同样按这条路重建（reloadContext.workspaceRoot 先换成工作树）
  async function rebuildMain(snapshot: typeof settings): Promise<void> {
    // 先建后换（复审 P2）：重建成功才换上这些闭包变量；重建失败时旧快照、旧编排设定与旧运行面都保持不变，
    // /reload 会照当前快照重新列出待确认条目、可重试
    const reloaded = await reopenMainSessionForReload(reloadContext, snapshot, slot);
    const opened = reloaded.opened;
    settings = snapshot;
    // 决策 439：键位随新快照重装
    shellHolder.current?.applyKeybindings(keybindingsSectionOf(snapshot));
    orchestration = reloaded.orchestration;
    loopGuard = reloaded.loopGuard;
    webToolsOption = reloaded.webTools;
    const bundle = opened.bundle;
    guardMainAgent(bundle);
    const workers =
      sandbox === undefined ? workersFor(opened, opened.scope.parentSessionId) : undefined;
    const previous = slot;
    // 决策 350：换走旧运行面之前先等它未完成的快照拍完（新运行面在同一工作区上接着改文件）
    await previous.checkpoints?.settle();
    slot = {
      sessionId: previous.sessionId,
      bundle,
      ...(workers !== undefined ? { workers } : {}),
      ...(opened.checkpoints !== undefined ? { checkpoints: opened.checkpoints } : {}),
    };
    // 决策 323、324：换走旧运行面前跑旧会话的 SessionEnd（reason "switch"），记录落在本会话文件；
    // 壳 rebindSession 随后会为重建后的会话跑 SessionStart（source "resume"）
    await shellHolder.current?.endSession("switch");
    await disposeRuntime(previous.bundle).catch(() => {});
    shellHolder.current?.rebindSession(slot.sessionId, {
      runtime: bundle.adapter,
      grants: {
        root: governanceRoot,
        store: bundle.grantStore,
        configRules: bundle.configGrants,
        layeredRules: bundle.settings.grants,
      },
      ...(workers !== undefined ? { workers } : {}),
      hooks: bundle.hooks,
    });
  }

  function resumeOptions(): NonNullable<TuiShellOptions["resume"]> {
    return {
      root: governanceRoot,
      rebind: async (targetId) => {
        // M5.5 S4：worker 会话回到它自己的工作树与委派策略（父会话或工作树缺失时响亮失败）；
        // 决策 3b：会话 grant 种子还原。两者与 MCP 启动一并在 session-runtime.ts（与 cli resume 同一份）
        const opened = await openSessionRuntime({
          approvalModeCell: mainModeCell,
          governanceRoot: governanceRoot,
          turnSnapshots: true,
          settings,
          sessionId: targetId,
          ...(sandbox === undefined
            ? {
                enterWorktree: enterWorktreeSlot,
              }
            : {}),
          streamFn,
          flags,
          ...spawnWorkerOption(flags, orchestration),
          taskList: orchestration.taskList,
          ...webToolsOption,
          warn,
          memoryWrite,
          createApprovalHandler: createHandler,
          // 决策 183：还原对话上下文，悬空的工具调用补"结果未知"的工具结果
          resume: true,
          hooksNotice: (line) => shellHolder.current?.addSystem(line),
        });
        const bundle = opened.bundle;
        // 决策 445、446：换到的会话开在独立工作树里时，工作区与退出清理跟着它
        adoptWorkspace(opened.scope.workspaceRoot);
        const targetName = sessionNameOf(governanceRoot, targetId, opened.scope.workspaceRoot);
        if (bundle.instructionsNotice !== undefined) {
          shellHolder.current?.addSystem(bundle.instructionsNotice);
        }
        if (bundle.toolsNotice !== undefined) shellHolder.current?.addSystem(bundle.toolsNotice);
        guardMainAgent(bundle);
        const workers = workersFor(opened, opened.scope.parentSessionId);
        const previous = slot;
        // 决策 350：换走旧会话之前先等它未完成的快照拍完（新会话在同一工作区上接着改文件）
        await previous.checkpoints?.settle();
        slot = {
          sessionId: targetId,
          bundle,
          workers,
          ...(opened.checkpoints !== undefined ? { checkpoints: opened.checkpoints } : {}),
        };
        sessionName = targetName;
        // 决策 323、324：换走旧会话前跑它的 SessionEnd（reason "switch"）——记录要落在旧会话文件，
        // 必须在释放旧运行面之前；壳 rebindSession 随后会为新会话跑 SessionStart（source "resume"）
        await shellHolder.current?.endSession("switch");
        // 换走的会话在本进程里到此结束（331：补做复盘记录已随复盘删除）
        void disposeRuntime(previous.bundle).catch(() => {});
        return {
          runtime: bundle.adapter,
          grants: {
            root: governanceRoot,
            store: bundle.grantStore,
            configRules: bundle.configGrants,
            layeredRules: bundle.settings.grants,
          },
          workers,
          hooks: bundle.hooks,
        };
      },
    };
  }
  // 有 worker 在跑、排队或等补批续做时不换运行面（与 /reload 同一口径）
  const workersBusy = (): string | undefined =>
    slot.workers
      ?.status()
      .some(
        (worker) =>
          worker.state === "running" ||
          worker.state === "queued" ||
          worker.outcome?.recoverable === true
      ) === true
      ? "workers are still running or waiting for approval"
      : undefined;
  const worktreeSwitch = createWorktreeSwitch({
    workspace: () => workspaceRoot,
    setWorkspace: (root) => {
      workspaceRoot = root;
      reloadContext.workspaceRoot = root === governanceRoot ? undefined : root;
    },
    workersBusy,
    rebuild: () => rebuildMain(settings),
    adopt: (worktree) => {
      setActiveWorktree(worktree);
      recordWorktreeEntry(slot.bundle.sessionStore, worktree);
    },
    system: (line, alert) =>
      alert === true ? shellHolder.current?.addAlert(line) : shellHolder.current?.addSystem(line),
    notify: (text) => slot.bundle.adapter.notify(text),
    noteForNextInput: (text) => shellHolder.current?.addNextInputNote(text),
    continueNotice: worktreeContinueNotice,
  });
  // 决策 446：enter_worktree 的宿主——当前工作区、起点档位、能否移入、建好后记下待移入（本轮结束后换运行面）
  enterWorktreeSlot.bind({
    governanceRoot,
    workspaceRoot: () => workspaceRoot,
    baseMode: () => worktreeBaseModeOf(worktreeSectionOf(settings)),
    blocked: worktreeSwitch.blocked,
    onEntered: worktreeSwitch.entered,
  });
  function setActiveWorktree(next: NamedWorktree | undefined): void {
    if (activeWorktree !== undefined && next?.path !== activeWorktree.path) {
      releaseWorktreeUse?.();
      releaseWorktreeUse = undefined;
      // 换到别的会话、离开了工作树：工作树留着，写一行
      if (next === undefined) {
        shellHolder.current?.addSystem(
          `left worktree ${activeWorktree.path} (kept; changes are there)`
        );
      }
    }
    if (next !== undefined && next.path !== activeWorktree?.path) {
      releaseWorktreeUse = holdWorktreeInUse(next.path);
    }
    activeWorktree = next;
  }
  // 决策 445、446：当前会话的工作区（主会话为治理根或独立工作树）；独立工作树记为退出时要清理的那个
  function adoptWorkspace(root: string): void {
    workspaceRoot = root;
    reloadContext.workspaceRoot = root === governanceRoot ? undefined : root;
    setActiveWorktree(
      root === governanceRoot
        ? undefined
        : (reopenNamedWorktree(governanceRoot, root) ?? activeWorktree)
    );
  }
  faceHolder.current = shell;
  shellHolder.current = shell;
  // 壳接管终端之前存下的提示与报错先落消息区（发生得更早，排在前面）
  for (const item of early.splice(0)) {
    if (item.alert) shell.addAlert(item.line);
    else shell.addSystem(item.line);
  }
  // 决策 323、324：壳接管终端之前跑一次 SessionStart——续跑类入口（--continue / --resume <id>）为
  // "resume"，否则 "startup"；补的上下文存进壳、下一条输入带上
  await shell.beginSession(resumed ? "resume" : "startup");
  shell.start();
  // 决策 441：未捕获的异常、未处理的拒绝与其余退出路径上把终端复位（离开全屏、关鼠标上报、开自动换行、显示光标）
  const terminalReset = installTerminalReset(
    (data) => process.stdout.write(data),
    (error) =>
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    (code) => process.exit(code)
  );
  // 决策 439：项目共享层（或被 git 跟踪的 settings.local.json）写的键位不采用——仓库不能改审批键
  if (settings.merged.keybindingsIgnored !== undefined) {
    shell.addSystem("keybindings in project settings are ignored");
  }
  // 决策 330：人写的说明超出上限被截断时在消息区提示一行
  if (mainBundle.instructionsNotice !== undefined) shell.addSystem(mainBundle.instructionsNotice);
  if (mainBundle.toolsNotice !== undefined) shell.addSystem(mainBundle.toolsNotice);
  warnSink.attach((line) => shell.addWarning(line));
  if (target.kind === "resume") {
    shell.announceResumed(governanceRoot, target.report);
  } else if (target.picker) {
    shell.openSessionPicker();
  }
  // 进程级退出（283）：立即收尾——取消在跑的 worker 并等其收尾记录落盘（有上限），释放当前运行面，沙箱会话交回，退进程。
  // 壳已停止，worker 排队中的审批按拒绝处理，不会吊住取消
  function release(): void {
    // 壳已正常停下（pi-tui 已复位终端）：之后的退出不再写复位序列
    terminalReset.markClean();
    const current = slot;
    // 壳已停：此后的告警写回标准错误输出
    warnSink.detach();
    void (async () => {
      // 决策 323、324：退出前跑一次 SessionEnd（reason "exit"）——必须在释放运行面之前，记录才落盘
      // （331：补做复盘记录已随复盘删除，退出不再等补做）
      await shellHolder.current?.endSession("exit");
      // 决策 443：关掉 Pigeon，会话面板里的会话全部停止（工作树没有改动即删，有改动保留）
      poolExiting = true;
      const poolProblems = (await sessionPool?.pool.closeAll().catch(() => [])) ?? [];
      for (const line of poolProblems) console.error(line);
      await closeTuiSession({
        governanceRoot: governanceRoot,
        sessionId: current.sessionId,
        bundle: current.bundle,
        ...(current.workers !== undefined ? { workers: current.workers } : {}),
        workerGraceMs: WORKER_SHUTDOWN_GRACE_MS,
        // 决策 245：会话结束时自动交回一次、删除容器；壳已停，分支名与查看命令打到标准输出
        ...(sandbox !== undefined ? { closeSandbox: () => closeSandbox(sandbox) } : {}),
        log: (line) => console.log(`[sandbox] ${line}`),
      });
      // 决策 445：独立工作树——没有改动即删；有改动在终端行内问保留还是删除（壳已停）
      if (activeWorktree !== undefined) {
        await closeNamedWorktree(activeWorktree, {
          ...(process.stdin.isTTY === true ? { ask: askOnStderr } : {}),
          write: (line) => console.error(line),
        });
      }
      releaseWorktreeUse?.();
    })().finally(() => {
      process.exit(0);
    });
  }
  const shutdown = (): void => {
    shell.stop();
    release();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 仅作为入口直接运行时执行；被 import 时不启动 TUI。打包产物里由产物入口（src/bundle-entry.ts）分派，这里不判断
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

// 决策 331：/memory edit 用的编辑器（$VISUAL 优先，其次 $EDITOR；都没有即不给，命令给出文件路径）
function editorOption(): { editor?: string } {
  const editor = resolveEditor();
  return editor !== undefined ? { editor } : {};
}
