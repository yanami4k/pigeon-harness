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
// 决策 267：pigeon 不带子命令即启动本界面（命令行对话改由 pigeon --line 进入）。
// 决策 286：pigeon --continue 接本项目最近的主会话、--resume <id> 接指定会话（启动时直接打开，不另建空会话），
// --resume 不带会话号开壳后弹出会话选择器；运行期告警在壳接管终端期间落消息区（之前与之后照旧写标准错误输出）；
// 输入历史按项目存在 .pigeon/state/tui-history.json。
// 决策 301：编排面接上编排器的只读观察口、发消息与续做（编排面板、树形视图、进入 worker 会话），树形视图按任务清单标注。
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { createSessionAttemptRunner } from "../application/attempt-group.ts";
import type { CheckpointAttachment } from "../application/checkpoints.ts";
import { configView, setUserConfig } from "../application/config-options.ts";
import {
  EnterWorktreeSlot,
  recordWorktreeEntry,
  worktreeContinueNotice,
} from "../application/enter-worktree-tool.ts";
import { runForkCommand } from "../application/fork-command.ts";
import {
  type LaunchFlags,
  localRiskNotice,
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
  namedWorktreeOpenedLine,
  namedWorktreeRepoRoot,
  openNamedWorktree,
  reenterCommand,
  reopenNamedWorktree,
} from "../application/named-worktree.ts";
import { type PeerMessaging, validPeerName } from "../application/peer-messaging.ts";
import { openPeerInbox } from "../application/peer-session.ts";
import { PeerSlot } from "../application/peer-tools.ts";
import { restoreSessionWorkers } from "../application/previous-workers.ts";
import { promptHistoryStore } from "../application/prompt-history.ts";
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
import { wrapScriptApprovals } from "../application/script-approvals.ts";
import { type ScriptCommands, scriptCommands } from "../application/script-commands.ts";
import { createSessionScripts, modelPricing } from "../application/script-host.ts";
import type { ScriptGate } from "../application/script-naming.ts";
import type { ScriptRuns } from "../application/script-runner.ts";
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
import { memoryWriteNoticeLine } from "../memory/update-memory-tool.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import { probeUpstreamVersions } from "../pi-runtime/upstream-version.ts";
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
import { resolveStartTarget, takeContinueFlags } from "./continue-flags.ts";
import { findFdPath } from "./fd-path.ts";
import { guardTuiAgent } from "./loop-guard-view.ts";
import {
  type MainReloadContext,
  reopenMainSessionForReload,
  spawnWorkerOption,
} from "./main-reload.ts";
import { HeldPresenter } from "./peer-inbox.ts";
import { MainPeerRoute } from "./peer-route.ts";
import { PigeonTuiShell, type TuiShellOptions, type TuiWorkersFace } from "./shell.ts";
import { switchableWarn } from "./warn-sink.ts";
import { takeWorktreeFlag } from "./worktree-flag.ts";
import { createWorktreeSwitch } from "./worktree-switch.ts";

// 退出时等 worker 收尾记录落盘的上限（毫秒）：超时仍退出，缺 settled 由冷侧如实标注
const WORKER_SHUTDOWN_GRACE_MS = 5000;

// 参数解析与装配都在 application 层（决策 067）：启动参数在 launch-flags.ts（与 cli、headless 同一份、
// 同一批缺省），会话运行面在 session-runtime.ts（作用域、grant 种子、MCP 启动、装配失败关 server）
const USAGE =
  "用法：pigeon [--yolo] [--no-persist-thinking] [--no-pushed-memory] [--no-hooks] [--no-web] [--no-spawn-workers] [--worker-concurrency <n>] [--worker-limit <n>] [--history-limit <n>] [--root <dir>] --stream-fn <模块路径> " +
  "[--provider <名>] [--model <id>] [--thinking <档位>] [--max-output-tokens <n>] [--context-window <n>] [--compact-threshold <n>] [--compact-keep <n>] " +
  "[--sandbox [--sandbox-network on|off] [--sandbox-approval yolo|prompt] [--sandbox-from-head]] [--continue | --resume [sessionId]]（命令行对话用 pigeon --line；其余子命令见 pigeon --help）";

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
  // M7（ROADMAP §M7）：启动时探测上游版本，与已验证版本不一致时明确告警（壳接管终端前打到 stderr）
  for (const warning of probeUpstreamVersions().warnings) {
    console.error(warning);
  }
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
    if (flags.sandbox !== undefined) throw new Error("--worktree 不与 --sandbox 同用");
    if (continued.mode.kind !== "new") {
      throw new Error("--worktree 不与 --continue、--resume 同用：续接会话时它会回到原来的工作树");
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
          notice: (line) => console.error(line),
        })
      : undefined;
  if (namedWorktree !== undefined) {
    console.error(namedWorktreeOpenedLine(namedWorktree));
  }
  // 决策 446：会话移进工作树后换成工作树（worker 编排、取用、脚本等闭包按它取）
  let workspaceRoot = namedWorktree?.path ?? governanceRoot;
  // 决策 445、446：本会话当前所在的独立工作树（退出时按它清理）
  let activeWorktree: NamedWorktree | undefined = namedWorktree;
  // 决策 445、446：独立工作树开着期间持有它的在用锁（退出清理与 /worktrees clean 据此不删别人开着的）
  let releaseWorktreeUse: (() => void) | undefined =
    namedWorktree !== undefined ? holdWorktreeInUse(namedWorktree.path) : undefined;
  const enterWorktreeSlot = new EnterWorktreeSlot();
  // 决策 450：会话间通信的工具槽（收件口在壳就位后打开并绑定）；沙箱会话不给
  const peerSlot = new PeerSlot();
  let peerMessaging: PeerMessaging | undefined;
  let heldPresenter: HeldPresenter | undefined;
  // 决策 450：消息一律送主会话（查看 worker 会话期间先攒着，peer-route.ts）
  let peerRoute: MainPeerRoute | undefined;
  // 当前运行面是不是主会话（查看 worker 会话时为假）
  let slotIsMain = true;
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
    console.error(target.note);
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
  // 决策 331：有人对话，带记忆工具；写入后在消息区显示一行记下的内容与层级（壳晚于运行面构造，晚绑定）
  const memoryWrite: MemoryWriteConfig = {
    source: "tui",
    onWritten: (notice) => {
      shellHolder.current?.addSystem(memoryWriteNoticeLine(notice));
      shellHolder.current?.render();
    },
  };
  // 决策 331、332：/memory 的上下文（两层上限取本会话的设置快照）
  const memoryContext = { governanceRoot: governanceRoot, limits: memoryLimitsOf(settings) };
  // 决策 309–314：各会话的脚本编排（运行器、命令面与点名状态），按会话的运行面取
  const scriptsOf = new WeakMap<
    RuntimeBundle,
    { runs: ScriptRuns; commands: ScriptCommands; gate: ScriptGate }
  >();
  const workersFor = (
    opened: OpenedSessionRuntime,
    parentSessionId?: SessionId
  ): TuiWorkersFace => {
    const { bundle } = opened;
    // 决策 446：worker 编排、取用与脚本一律按这个运行面自己的工作区（移进独立工作树后即工作树），不读外层可变的工作区
    const workspaceRoot = opened.scope.workspaceRoot;
    const scriptHolder: { current?: ScriptRuns } = {};
    const deps = {
      governanceRoot: governanceRoot,
      workspaceRoot,
      bundle,
      // worker 请求自带其会话的放权落点；此处绑定的父会话存储只是缺省。
      // 决策 303（脚本部分）：脚本派出的 worker 的请求——同类已放行即批准，否则补上脚本名与同类交给人
      approvals: wrapScriptApprovals(createHandler(bundle.grantStore), () => scriptHolder.current),
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
        // 决策 297：完成通知进主 agent 的下一轮，空闲时叫醒它；通知同时显示在消息区
        target: bundle.adapter,
        wake: () => shellHolder.current?.runNotices(),
        onNotice: (text) => {
          shellHolder.current?.addSystem(text);
          shellHolder.current?.render();
        },
      });
      notices = bound.notices;
      // 决策 309–314：脚本编排的运行器——汇总与 worker 完成通知同一条队列；收回按写操作请示（放手模式或已放权即直接做）
      const scriptSlot = opened.scriptOrchestration;
      if (scriptSlot !== undefined) {
        const runs = createSessionScripts({
          orchestrator,
          governanceRoot: governanceRoot,
          workspaceRoot,
          sessionId: bundle.adapter.sessionId,
          flush: () => bundle.sessionStore.flush(),
          ...(bound.notices !== undefined ? { notices: bound.notices } : {}),
          approval: {
            yolo: flags.yolo,
            grants: bundle.grantStore,
            configGrants: bundle.configGrants,
            handler: createHandler(bundle.grantStore),
          },
          provider: flags.provider,
          // 决策 314：金额额度要模型有价格；决策 313：脚本卡住的判定时长
          pricing: () => modelPricing(flags.provider, bundle.adapter.transcript()),
          stallMs: orchestration.scriptStallMs,
          settings: bundle.settings,
          emit: (line) => {
            shellHolder.current?.addSystem(line);
            shellHolder.current?.render();
          },
          onChange: () => shellHolder.current?.render(),
        });
        scriptHolder.current = runs;
        scriptSlot.bind({ runs, workspaceRoot });
        scriptsOf.set(bundle, {
          runs,
          commands: scriptCommands(runs, orchestrator),
          gate: scriptSlot.gate,
        });
      }
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
              takeWorkerChanges({ orchestrator, workspaceRoot }, name).text,
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
    log: (line) => console.error(`[沙箱] ${line}`),
    // 决策 333：运行中的提示（命令超出内存上限）经告警出口：壳接管终端期间落消息区
    notice: (line) => warn(`[沙箱] ${line}`),
  });
  // 决策 340：/reload 重建主会话运行面时跨快照不变的部分（重建本身在 main-reload.ts）
  const reloadContext: MainReloadContext = {
    governanceRoot: governanceRoot,
    // 决策 445：独立工作树里的会话，/reload 重建时工作区仍是工作树（第一条消息之前会话文件还没建，推导不出）
    ...(namedWorktree !== undefined ? { workspaceRoot: namedWorktree.path } : {}),
    ...(sandbox === undefined ? { enterWorktree: enterWorktreeSlot, peers: peerSlot } : {}),
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
    hooksNotice: (line) => shellHolder.current?.addSystem(line),
    onMcpNote: (note) => shellHolder.current?.addSystem(`[mcp] ${note}`),
  };
  const mainOpened = await openSessionRuntime({
    governanceRoot: governanceRoot,
    ...(namedWorktree !== undefined ? { workspaceRoot: namedWorktree.path } : {}),
    ...(sandbox === undefined ? { enterWorktree: enterWorktreeSlot, peers: peerSlot } : {}),
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
    hooksNotice: (line) => shellHolder.current?.addSystem(line),
    onMcpNote: (note) => {
      console.error(`[mcp] ${note}`);
    },
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
  const shell = new PigeonTuiShell({
    terminal: new ProcessTerminal(),
    // 决策 439：键位（设置的 keybindings 一节）
    ...(keybindingsSectionOf(settings) !== undefined
      ? { keybindings: keybindingsSectionOf(settings) }
      : {}),
    // 决策 442：/config 设置面板——生效值取本会话当前的设置快照，改动写用户级设置（随后壳按 /reload 重建）
    config: {
      view: () => configView(settings),
      set: (id: string, value: string) => setUserConfig(governanceRoot, id, value),
    },
    // 决策 439：输入框补全，路径与 @ 引用以工作区为根
    autocomplete: { basePath: workspaceRoot, fdPath: findFdPath() },
    // 决策 441：Windows 上右键粘贴取系统剪贴板
    ...(process.platform === "win32" ? { readClipboard: readWindowsClipboard } : {}),
    runtime: slot.bundle.adapter,
    sessionId: slot.sessionId,
    // 决策 325：终端界面日志在程序状态目录下
    logDir: tuiLogDirOf(governanceRoot),
    // 决策 286：状态栏的模型与跨启动的输入历史
    model: `${flags.provider}/${flags.modelId}`,
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
    // S4：/sessions 会话列表（命令层在 application/session-list.ts，与 cli 同一份）
    sessions: { root: governanceRoot },
    // M5 S2（决策 038 / 045）：/search 命令上下文与 /resume 历史渲染上限
    search: { root: governanceRoot },
    ...(flags.historyLimit !== undefined ? { historyLimit: flags.historyLimit } : {}),
    // M5.5 S4：/spawn /cancel /workers（沙箱里不提供）
    ...(slot.workers !== undefined ? { workers: slot.workers } : {}),
    // 决策 245：沙箱会话的 /export 手动交回
    ...(sandbox !== undefined
      ? { sandbox: { exportChanges: () => exportSandbox(sandbox, slot.bundle.jobs) } }
      : {}),
    // S4：/resume <sessionId> 的换绑工厂——与 cli resume 的 enterRepl 同一配方：
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
          ? "有 worker 仍在运行：先 /cancel 或等其收尾，再 /reload"
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
    // 决策 309、301：脚本编排——点名只看人的输入、树形视图的脚本与阶段两层、/orchestrate（换绑后跟着当前会话）
    onHumanInput: (text) => scriptsOf.get(slot.bundle)?.gate.humanInput(text),
    scripts: () => scriptsOf.get(slot.bundle)?.runs.nodes() ?? [],
    scriptCommands: () => scriptsOf.get(slot.bundle)?.commands,
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
    // 决策 450：忙闲进会话名录，空闲时回告订了空闲通知的会话
    onBusyChange: (busy) => peerMessaging?.setBusy(busy),
    ...(sandbox === undefined
      ? {
          renamePeer: (name: string) => {
            if (peerMessaging === undefined) return "会话间通信的收件口没开，改不了名";
            if (!validPeerName(name)) {
              return "名字只能用字母、数字、下划线、连字符与点，最长 40 个字符";
            }
            peerMessaging.rename(name);
            return `本会话在本机会话名录里改名为 ${name}`;
          },
        }
      : {}),
    // 决策 448：/worktrees 列出与删除留下的 worker 工作树（git 仓库、不在沙箱里才有）
    ...(sandbox === undefined && isGitWorkspace(governanceRoot)
      ? {
          worktrees: createTuiWorktreesFace({
            workspaceRoot: governanceRoot,
            // 本进程里仍可能用到工作树的 worker：在跑、排队、等补批续做、脚本派出的（整次收回之前）
            liveWorkers: () =>
              new Set(
                (slot.workers?.status() ?? [])
                  .filter(
                    (status) =>
                      status.state === "running" ||
                      status.state === "queued" ||
                      status.outcome?.recoverable === true ||
                      (status.script !== undefined && status.worktreeRemoved === undefined)
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
    // 决策 365：后台作业结束的通知显示在消息区，主 agent 空闲时叫醒它（同 worker 完成通知）
    bundle.jobNotices?.bind({
      wake: () => shellHolder.current?.runNotices(),
      onNotice: (text) => {
        shellHolder.current?.addSystem(text);
        shellHolder.current?.render();
      },
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
          governanceRoot: governanceRoot,
          settings,
          sessionId: targetId,
          ...(sandbox === undefined ? { enterWorktree: enterWorktreeSlot, peers: peerSlot } : {}),
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
        // 决策 450：收件口跟着换到的主会话（名字不变）；查看 worker 会话期间名录里仍是原主会话
        if (opened.scope.parentSessionId === undefined) {
          peerMessaging?.moveTo({ sessionId: targetId, cwd: opened.scope.workspaceRoot });
        }
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
        // 决策 450：回到主会话时把查看 worker 期间攒下的消息递过去（换绑完成后再叫醒）
        slotIsMain = opened.scope.parentSessionId === undefined;
        peerRoute?.flush();
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
      // 决策 450：会话名录里的所在目录跟着换
      peerMessaging?.moveTo({ sessionId: slot.sessionId, cwd: worktree.path });
    },
    system: (line) => shellHolder.current?.addSystem(line),
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
      // 换到别的会话、离开了工作树：工作树留着，说明怎么回去
      if (next === undefined) {
        shellHolder.current?.addSystem(
          `离开工作树 ${activeWorktree.path}（保留，改动在那里；回去：${reenterCommand(activeWorktree.name)}）`
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
  // 决策 323、324：壳接管终端之前跑一次 SessionStart——续跑类入口（--continue / --resume <id>）为
  // "resume"，否则 "startup"；补的上下文存进壳、下一条输入带上
  await shell.beginSession(resumed ? "resume" : "startup");
  shell.start();
  // 决策 450：本机会话间通信的收件口（沙箱会话不开；开局即续接 worker 会话时不开，worker 不登记名录）。消息进当前主会话的
  // 通知队列，空闲时叫醒；扣住的逐条弹到审批面板
  if (sandbox === undefined && mainOpened.scope.parentSessionId === undefined) {
    const presenter = new HeldPresenter({
      ask: (request) => shell.askApproval(request),
      // 输入框里有字时不弹（不打断正在打字的人）
      ready: () => shell.inputIsEmpty(),
      approve: (id) => peerMessaging?.approveHeld(id),
      decline: (id) => peerMessaging?.dropHeld(id, "declined"),
    });
    heldPresenter = presenter;
    // 叫醒放到下一拍：换绑过程中递过去的，等壳换上新运行面再跑
    // 每次投递现取当下的主会话运行面（/reload、移进工作树重建之后即新的那个）
    const route = new MainPeerRoute(
      () => (slotIsMain ? slot.bundle.adapter : undefined),
      () => setTimeout(() => shellHolder.current?.runNotices(), 0)
    );
    peerRoute = route;
    peerMessaging = await openPeerInbox({
      sessionId: slot.sessionId,
      cwd: workspaceRoot,
      yolo: flags.yolo,
      settings,
      deliver: (text) => route.deliver(text),
      pendingCount: () => route.pendingCount(),
      onHeld: (held) => presenter.held(held),
      onHeldGone: (id) => presenter.gone(id),
      ui: (line) => {
        shellHolder.current?.addSystem(line);
        shellHolder.current?.render();
      },
    });
    if (peerMessaging !== undefined) {
      peerSlot.bind(peerMessaging);
      shell.addSystem(`本会话在本机会话名录里叫 ${peerMessaging.name}（/rename 改名）`);
    }
  }
  // 决策 330：人写的说明超出上限被截断时在消息区提示一行
  if (mainBundle.instructionsNotice !== undefined) shell.addSystem(mainBundle.instructionsNotice);
  if (mainBundle.toolsNotice !== undefined) shell.addSystem(mainBundle.toolsNotice);
  // 决策 379：本机放手且联网工具开着时提示一行风险
  const riskNotice = localRiskNotice(flags, webToolsOption.webTools !== undefined);
  if (riskNotice !== undefined) shell.addSystem(riskNotice);
  warnSink.attach((line) => shell.addWarning(line));
  if (target.kind === "resume") {
    shell.announceResumed(governanceRoot, target.report);
  } else if (target.picker) {
    shell.openSessionPicker();
  }
  // 进程级退出（283）：立即收尾——取消在跑的 worker 并等其收尾记录落盘（有上限），释放当前运行面，沙箱会话交回，退进程。
  // 壳已停止，worker 排队中的审批按拒绝处理，不会吊住取消
  function release(): void {
    const current = slot;
    // 壳已停：此后的告警写回标准错误输出
    warnSink.detach();
    void (async () => {
      // 决策 323、324：退出前跑一次 SessionEnd（reason "exit"）——必须在释放运行面之前，记录才落盘
      // （331：补做复盘记录已随复盘删除，退出不再等补做）
      await shellHolder.current?.endSession("exit");
      await closeTuiSession({
        governanceRoot: governanceRoot,
        sessionId: current.sessionId,
        bundle: current.bundle,
        ...(current.workers !== undefined ? { workers: current.workers } : {}),
        workerGraceMs: WORKER_SHUTDOWN_GRACE_MS,
        // 决策 245：会话结束时自动交回一次、删除容器；壳已停，分支名与查看命令打到标准输出
        ...(sandbox !== undefined ? { closeSandbox: () => closeSandbox(sandbox) } : {}),
        log: (line) => console.log(`[沙箱] ${line}`),
      });
      // 决策 445：独立工作树——没有改动即删；有改动在终端行内问保留还是删除（壳已停）
      if (activeWorktree !== undefined) {
        await closeNamedWorktree(activeWorktree, {
          ...(process.stdin.isTTY === true ? { ask: askOnStderr } : {}),
          write: (line) => console.error(line),
        });
      }
      releaseWorktreeUse?.();
      heldPresenter?.stop();
      await peerMessaging?.close().catch(() => {});
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
