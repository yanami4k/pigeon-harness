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
// M5.5 S4（决策 040）：主会话与面板会话的审批经同一队列汇聚到面板（一次一个）。
// 决策 267：pigeon 不带子命令即启动本界面（决策 461：命令行对话已去掉）。
// 决策 286：pigeon --continue 接本项目最近的主会话、--resume <id> 接指定会话（启动时直接打开，不另建空会话），
// --resume 不带会话号开壳后弹出会话选择器；运行期告警在壳接管终端期间落消息区（之前与之后照旧写标准错误输出）；
// 输入历史按项目存在 .pigeon/state/tui-history.json。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { MailGate } from "../application/agent-mail.ts";
import { type AgentTypeCatalog, loadAgentTypes } from "../application/agent-types.ts";
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
  namedWorktreeRepoRoot,
  openNamedWorktree,
  reopenNamedWorktree,
} from "../application/named-worktree.ts";
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
import { subagentSessionsDirFor } from "../application/session-cost.ts";
import { sessionOpenElsewhere } from "../application/session-holder.ts";
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
import {
  applySettingsReload,
  createSettingsReloader,
  planSettingsReload,
} from "../application/settings-reload.ts";
import { restoredAgentsOf } from "../application/subagent-runtime.ts";
import { AgentHub, type SubagentRecord } from "../application/subagents.ts";
import { renderTaskList } from "../application/task-list-tool.ts";
import { closeTuiSession } from "../application/tui-exit.ts";
import {
  createTuiWorktreesFace,
  isGitWorkspace,
  type TuiWorktreesFace,
} from "../application/worktree-cleanup.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { createApprovalQueue } from "../approvals/queue.ts";
import { describeHead, treesHomeOf } from "../orchestration/worktree.ts";
import { recordTrustedEntries } from "../persistence/config-trust-store.ts";
import {
  addToSessionIndex,
  type ListedSession,
  removeFromSessionIndex,
} from "../persistence/session-index.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import type { TrustEntry } from "../state/config-trust.ts";
import { asSessionId, newSessionId, type SessionId } from "../state/ids.ts";
import { FROM_BUNDLE } from "../state/package-paths.ts";
import {
  projectLocalSettingsPath,
  projectSettingsPath,
  sessionsDirOf,
  tuiLogDirOf,
  userSettingsPath,
} from "../state/paths.ts";
import {
  keybindingsSectionOf,
  loopGuardSettingsOf,
  memoryLimitsOf,
  type SettingsSnapshot,
  taskListEnabledOf,
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
import {
  attachCoreRuntime,
  closeCore,
  coreApprovalHandler,
  coreBundle,
  createSessionPool,
  pooledRuntimeOf,
  registerCoreAgents,
  type SessionCore,
  type SessionPoolContext,
  sayOf,
  setCoreRole,
  settingsOf,
} from "./main-pool.ts";
import { type MainReloadContext, reopenMainSessionForReload } from "./main-reload.ts";
import { askTrustPanel } from "./modal.ts";
import { launchPlaceOf, newSessionPlace } from "./new-session-dir.ts";
import {
  type NewSessionRequest,
  PigeonTuiShell,
  type TuiHandOff,
  type TuiSessionBinding,
  type TuiShellOptions,
} from "./shell.ts";
import { type StatusReport, statusCwd } from "./status-report.ts";
import { installTerminalReset } from "./terminal-reset.ts";
import { switchableWarn } from "./warn-sink.ts";
import { modelLabelOf, tildePath } from "./welcome.ts";
import { WorkList } from "./work-list.ts";
import { takeWorktreeFlag } from "./worktree-flag.ts";
import { createWorktreeSwitch } from "./worktree-switch.ts";

// 参数解析与装配都在 application 层（决策 067）：启动参数在 launch-flags.ts（与 cli、headless 同一份、
// 同一批缺省），会话运行面在 session-runtime.ts（作用域、grant 种子、MCP 启动、装配失败关 server）
const USAGE =
  "usage: pigeon [--yolo] [--no-persist-thinking] [--no-pushed-memory] [--no-hooks] [--no-web] [--no-subagents] [--history-limit <n>] [--root <dir>] --stream-fn <module> " +
  "[--provider <name>] [--model <id>] [--thinking <level>] [--max-output-tokens <n>] [--context-window <n>] [--compact-threshold <n>] [--compact-keep <n>] " +
  "[--sandbox [--sandbox-network on|off] [--sandbox-approval yolo|prompt] [--sandbox-from-head]] [--continue | --resume [sessionId]]";

// 决策 484：/reload 时面板里的会话还有子 agent 在干活，隔多久再看一次
const POOLED_RELOAD_RETRY_MS = 1000;

// 决策 485：比较项目与工作区路径用的键（Windows 上不分大小写）
function rootKey(path: string): string {
  const resolved = resolvePath(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
    subagents: true,
  });
  const streamFn = await loadStreamFn(resolveStreamFnSpec(flags, USAGE));
  // 工作区准备（决策 034）：realpath 规范化，与 cli 入口同一份；
  // 它同时是治理根（.pigeon/ 恒在主仓库根，决策 040）。决策 445：--worktree 时治理根为主仓库根，工作区为独立工作树。
  // 决策 495、496：与 /new <path> 同一套认法——在某棵工作树里启动即归它所在仓库的主检出，工作目录是启动的目录
  //（沙箱会话照旧以启动目录为项目）
  const launchPlace = launchPlaceOf(flags.root, { trees: flags.sandbox === undefined });
  const launchRoot = launchPlace.root;
  if (worktreeFlag.name !== undefined) {
    if (flags.sandbox !== undefined) throw new Error("--worktree can't be used with --sandbox");
    if (continued.mode.kind !== "new") {
      throw new Error("--worktree can't be used with --continue or --resume");
    }
  }
  const governanceRoot =
    worktreeFlag.name !== undefined ? namedWorktreeRepoRoot(launchRoot) : launchRoot;
  // 决策 325、326：旧布局检查、读三层设置成本会话快照、确认会执行命令的条目（壳接管终端之前，行内问答）。
  // 本进程内的会话（含 /resume 换绑、沙箱会话）都用这一份快照，直到 /reload 换上新快照（决策 340）
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
  const enterWorktreeOf = (): EnterWorktreeSlot | undefined =>
    sandbox === undefined ? new EnterWorktreeSlot() : undefined;
  // 决策 308：打转检测——设置的 loopGuard 一节（缺失取缺省即开着）；/reload 换上新快照后重算
  let loopGuard = loopGuardSettingsOf(settings);
  // 决策 287–291、346：联网工具——--no-web、web.enabled 为 false、沙箱断网档任一成立就不给；配置畸形在此响亮失败。
  // /reload 换上新快照后经同一函数重算
  const webToolsFor = (snapshot: typeof settings) => webToolsOptionOf(flags, snapshot);
  webToolsFor(settings);
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
  // M5.5 S3：所有会话（含子 agent）的审批经同一队列，一次一个
  const approvalQueue = createApprovalQueue();
  const createHandler = (grants: SessionGrantStore) =>
    approvalQueue.wrap(createTuiApprovalHandler(grants, () => faceHolder.current));
  // 壳晚于运行面构造，晚绑定
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
  // 决策 485：跟着当前会话所在的项目（换会话时换）
  const memoryContext = { governanceRoot: governanceRoot, limits: memoryLimitsOf(settings) };
  // M7（决策 079）：/fork 手动分叉——分支在独立工作树里续跑，跑完回报（按这个运行面）
  const forkFor =
    (opened: OpenedSessionRuntime) =>
    (args: string): Promise<string> =>
      runForkCommand({
        governanceRoot: current.governanceRoot,
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
      });
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
  // 决策 457、480：本进程的通讯录与子 agent（沙箱会话与 --no-subagents 不开）。类型开局读一次，/reload 重读；
  // 读不成的类型文件开局报一行
  const agentHub =
    sandbox === undefined && flags.subagents
      ? new AgentHub({ mail: new MailGate(), onChange: () => shellHolder.current?.agentsChanged() })
      : undefined;
  // 决策 485：子 agent 的类型按项目读（别的工作区的会话用它那个项目的）；/reload 重读
  const catalogs = new Map<string, AgentTypeCatalog>();
  const catalogOf = (root: string): AgentTypeCatalog => {
    const key = rootKey(root);
    const known = catalogs.get(key);
    if (known !== undefined) return known;
    const loaded = loadAgentTypes({ governanceRoot: root });
    catalogs.set(key, loaded);
    return loaded;
  };
  const agentCatalog = catalogOf(governanceRoot);
  // 决策 482：在等审批的子 agent（路径），子 agent 面板据此标出
  const waitingCounts = new Map<string, number>();
  const waitingAgents = new Set<string>();
  const agentWaiting = (path: string, on: boolean): void => {
    const count = (waitingCounts.get(path) ?? 0) + (on ? 1 : -1);
    if (count > 0) {
      waitingCounts.set(path, count);
      waitingAgents.add(path);
    } else {
      waitingCounts.delete(path);
      waitingAgents.delete(path);
    }
    shellHolder.current?.agentsChanged();
  };
  if (agentHub !== undefined) {
    for (const problem of agentCatalog.problems) say(`[agents] ${problem}`, true);
  }
  // 决策 484：当前会话（会话核；进入面板里的会话、/resume 换会话时换）
  let current: SessionCore;
  // 关掉 Pigeon 时壳已停：说明写标准错误输出
  let poolExiting = false;
  // 决策 484：会话核的共用上下文——当前会话与面板里的会话同一份（审批、叫醒、打转检测按会话此刻的角色走）
  const coreContext: SessionPoolContext = {
    governanceRoot,
    streamFn,
    flags,
    ...(agentHub !== undefined
      ? { agents: { hub: agentHub, catalog: catalogOf, waiting: agentWaiting } }
      : {}),
    settings: () => settings,
    warn,
    createApprovalHandler: createHandler,
    memoryWrite,
    webToolsFor,
    mainWorkspace: () => current.workspaceRoot,
    // 决策 469：派出的会话沿用当前会话当时的审批模式
    approvalMode: () => current.modeCell.current,
    notice: (line, alert) => {
      if (poolExiting) console.error(line);
      else say(line, alert === true);
    },
    // 决策 485：面板里新派的会话开在当前会话所在的项目；/take 不跨仓库；清单里的会话释放时工作树留着
    // 启动的项目里的不带快照（用本进程的，/reload 换新的）
    spawnTarget: () => ({
      governanceRoot: current.governanceRoot,
      settings: current.settings,
    }),
    currentRoot: () => current.governanceRoot,
    onListed: (core) => listCore(core),
    // 决策 486、490：会话的主 agent 用 take_changes 取面板里同一仓库的会话（按全量会话号找；在干活的不取）
    panelTake: (caller, id, into) => {
      const pool = sessionPool?.pool;
      // 工作清单里的（本进程没开的也在面板上）
      const card = (workList ?? pool)
        ?.list()
        .find((item) => item.id === id && item.id !== caller.sessionId);
      if (pool === undefined || card === undefined) return undefined;
      if (card.state === "running" || card.state === "waiting" || card.state === "preparing") {
        return `Error: session ${id} is still working; take its changes after it finishes`;
      }
      const target = pool.runtimeOf(card.id)?.live?.core;
      if (target === undefined) return `Error: session ${id} isn't open`;
      if (rootKey(target.governanceRoot) !== rootKey(caller.governanceRoot)) {
        return `Error: ${id} is in another repository; nothing to take`;
      }
      return pool.takeInto(card.id, { workspace: into, root: caller.governanceRoot });
    },
    onUnlisted: (id) => {
      try {
        removeFromSessionIndex(id);
      } catch (error) {
        say(
          `updating the work list failed: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    },
    current: {
      wake: () => shellHolder.current?.runNotices(),
      render: () => shellHolder.current?.render(),
      // 决策 365：消息区另写一行后台作业的简短结果（作业号、结束状态与命令）
      jobEnded: (line) => shellHolder.current?.addSystem(line),
      // 决策 305–307：当前会话的打转检测挂到壳上（见 loop-guard-view.ts）
      guard: (bundle) =>
        guardTuiAgent({
          runtime: bundle.adapter,
          settings: loopGuard,
          shell: () => shellHolder.current,
        }),
    },
  };
  // 决策 485：会话用的设置快照（别的项目的会话用它那个项目的）
  const settingsOfCore = (core: SessionCore) => settingsOf(coreContext, core);
  // 决策 484：从当前会话这边开的会话核（启动、/resume、打开工作清单里的）：带 enter_worktree 的工具槽（沙箱里没有）。
  // 决策 485：别的项目的会话带着那个项目的治理根与设置快照
  function newCore(
    id: SessionId,
    root: string,
    workspaceRoot: string,
    mode: "prompt" | "yolo",
    snapshot?: SettingsSnapshot
  ): SessionCore {
    const enterWorktree = enterWorktreeOf();
    const core: SessionCore = {
      sessionId: id,
      governanceRoot: root,
      ...(snapshot !== undefined ? { settings: snapshot } : {}),
      name: "",
      task: "",
      modeCell: { current: mode },
      workspaceRoot,
      current: false,
      approvals: new AbortController(),
      startContexts: [],
      ...(enterWorktree !== undefined ? { enterWorktree } : {}),
    };
    // 决策 446：enter_worktree 的宿主——当前工作区、起点档位、能否移入、建好后记下待移入（本轮结束后换运行面）。
    // 只有当前会话能移（面板里的会话在后台）
    enterWorktree?.bind({
      governanceRoot: root,
      workspaceRoot: () => core.workspaceRoot,
      baseMode: () => worktreeBaseModeOf(worktreeSectionOf(settingsOfCore(core))),
      blocked: () =>
        core.current
          ? (agentsBusy() ?? worktreeSwitch.blocked())
          : "the session is in the background (session panel)",
      onEntered: (worktree, uncommitted) => worktreeSwitch.entered(worktree, uncommitted),
    });
    return core;
  }
  // 开会话核的运行面：先在通讯录里登记（它的工具接口要交给运行面），开不成即注销
  async function openCore(
    core: SessionCore,
    extra: { workspaceRoot?: string; resume?: true; deferSessionFile?: true }
  ): Promise<OpenedSessionRuntime> {
    const agentsHost = registerCoreAgents(coreContext, core);
    const notice = sayOf(coreContext, core);
    const snapshot = settingsOfCore(core);
    try {
      return await openSessionRuntime({
        approvalModeCell: core.modeCell,
        governanceRoot: core.governanceRoot,
        // 决策 436：会话回退要用发消息时的快照
        turnSnapshots: true,
        ...(core.enterWorktree !== undefined ? { enterWorktree: core.enterWorktree } : {}),
        settings: snapshot,
        sessionId: core.sessionId,
        streamFn,
        flags,
        ...(sandbox !== undefined
          ? { workspaceHost: sandbox.host, statusFacts: sandboxStatusFacts(sandbox) }
          : {}),
        taskList: taskListEnabledOf(snapshot),
        ...webToolsFor(snapshot),
        warn,
        memoryWrite,
        createApprovalHandler: coreApprovalHandler(coreContext, core),
        ...(agentsHost !== undefined ? { agents: agentsHost } : {}),
        ...extra,
        // 决策 324：钩子拦下或出错的一行提示落消息区（壳尚未接管终端时落壳持有格，接管后进消息区）
        hooksNotice: (line) => notice(line, true),
        onMcpNote: (note) => notice(`[mcp] ${note}`, true),
      });
    } catch (error) {
      await core.registration?.unregister();
      core.registration = undefined;
      throw error;
    }
  }
  // 决策 480：续接的会话把它的子 agent 认回通讯录（没干完的标已中断，发消息即接着干）
  async function restoreAgents(core: SessionCore): Promise<void> {
    if (agentHub === undefined) return;
    const file = await coreBundle(core).sessionStore.filePath();
    if (file === undefined) return;
    try {
      agentHub.restoreAgents(core.sessionId, restoredAgentsOf(file, core.sessionId));
    } catch (error) {
      say(`[agents] ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
  // 决策 445、446：会话核的工作区（治理根或独立工作树）；独立工作树开着期间持有它的在用锁
  function adoptWorkspace(core: SessionCore, root: string): void {
    core.workspaceRoot = root;
    const next =
      rootKey(root) === rootKey(core.governanceRoot)
        ? undefined
        : (reopenNamedWorktree(core.governanceRoot, root) ?? core.worktree);
    if (next?.path !== core.worktree?.path || core.releaseInUse === undefined) {
      core.releaseInUse?.();
      core.releaseInUse = next !== undefined ? holdWorktreeInUse(next.path) : undefined;
    }
    core.worktree = next;
  }
  // 决策 480：当前会话还有子 agent 在跑时不能改设置、重读设置、移进工作树
  const agentsBusy = (): string | undefined =>
    agentHub !== undefined && agentHub.runningUnder(current.sessionId) > 0
      ? "sub-agents are running"
      : undefined;
  // 决策 445：--worktree 时会话开在独立工作树里
  const startCore = newCore(
    sessionId,
    governanceRoot,
    namedWorktree?.path ?? (resumed ? governanceRoot : launchPlace.workspace),
    flags.yolo ? "yolo" : "prompt"
  );
  current = startCore;
  startCore.current = true;
  if (namedWorktree !== undefined) {
    startCore.worktree = namedWorktree;
    startCore.releaseInUse = holdWorktreeInUse(namedWorktree.path);
  }
  startCore.opened = await openCore(startCore, {
    ...(namedWorktree !== undefined
      ? { workspaceRoot: namedWorktree.path }
      : !resumed && rootKey(launchPlace.workspace) !== rootKey(governanceRoot)
        ? { workspaceRoot: launchPlace.workspace }
        : {}),
    // 决策 183、286：--continue / --resume <id> 直接续接——还原对话上下文；
    // 决策 432：新开的会话等第一次真要落盘时才建会话文件
    ...(resumed ? { resume: true as const } : { deferSessionFile: true as const }),
  }).catch(async (error: unknown) => {
    await sandbox?.discard().catch(() => {});
    throw error;
  });
  const startBundle = startCore.opened.bundle;
  if (resumed) await restoreAgents(startCore);
  // 决策 445、446：续接的会话开在独立工作树里（--continue、--resume）：工作区与退出清理跟着它
  adoptWorkspace(startCore, startCore.opened.scope.workspaceRoot);
  // 决策 456：会话的名字（会话记录里记的，没改过名为缺省名）；/rename 改它并记进会话记录
  startCore.name = sessionNameOf(governanceRoot, sessionId, startCore.workspaceRoot);
  attachCoreRuntime(coreContext, startCore);
  // 决策 443：会话面板（进程内版）：派出的会话进各自的工作树；沙箱会话不开。退出时全部停止
  const sessionPool = sandbox === undefined ? createSessionPool(coreContext) : undefined;
  // 决策 485：面板的工作清单——会话池里开着的加上用户级清单里本进程没开的（沙箱会话没有面板，也不进清单）
  const workList =
    sessionPool !== undefined
      ? new WorkList({
          pool: sessionPool.pool,
          currentId: () => current.sessionId,
          open: (entry, task) => openListed(entry, task),
          // 开着的别的项目的会话同样标目录
          placeOf: (id) => {
            const core = sessionPool.pool.runtimeOf(id)?.live?.core;
            return core !== undefined &&
              rootKey(core.governanceRoot) !== rootKey(current.governanceRoot)
              ? tildePath(core.workspaceRoot, homedir())
              : undefined;
          },
          notice: (line) => say(line, true),
        })
      : undefined;
  // 决策 485：会话进工作清单（进过面板的：在面板里新开的、从主视图离开的、退到面板的）；还没建会话文件的不记（没东西可接）
  function listCore(core: SessionCore): void {
    if (sandbox !== undefined) return;
    void (async () => {
      const file = await core.opened?.bundle.sessionStore.filePath();
      if (file !== undefined) addListed(core);
    })().catch(() => {});
  }
  function addListed(core: SessionCore): void {
    try {
      addToSessionIndex({
        sessionId: core.sessionId,
        governanceRoot: core.governanceRoot,
        workspaceRoot: core.workspaceRoot,
      });
    } catch (error) {
      say(
        `updating the work list failed: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
  }
  // 会话号所属项目的治理根（当前会话或面板里开着的；不认识的按启动时的）
  function rootOfSession(id: string): string {
    if (id === current.sessionId) return current.governanceRoot;
    return sessionPool?.pool.runtimeOf(id)?.live?.core.governanceRoot ?? governanceRoot;
  }
  // 决策 485：/worktrees 跟着当前会话所在的仓库（各仓库一份，记着待确认的清理）
  const worktreesFaces = new Map<string, TuiWorktreesFace>();
  function worktreesFaceOf(core: SessionCore): TuiWorktreesFace {
    const key = rootKey(core.governanceRoot);
    const known = worktreesFaces.get(key);
    if (known !== undefined) return known;
    const face = createTuiWorktreesFace({ workspaceRoot: core.governanceRoot });
    worktreesFaces.set(key, face);
    return face;
  }
  // 决策 485：别的项目的设置快照（打开那边的会话时读，没确认过的会执行命令的条目在界面里确认）；启动时的项目用 settings
  const projectSettings = new Map<string, SettingsSnapshot>();
  function setProjectSettings(root: string, snapshot: SettingsSnapshot): void {
    const launch = rootKey(root) === rootKey(governanceRoot);
    if (launch) settings = snapshot;
    else projectSettings.set(rootKey(root), snapshot);
    // 带着这个项目快照的会话一并换上（启动项目里的会话一般不带快照，直接用 settings）
    for (const core of openCores()) {
      if (rootKey(core.governanceRoot) !== rootKey(root)) continue;
      if (!launch || core.settings !== undefined) core.settings = snapshot;
    }
  }
  function openCores(): SessionCore[] {
    const pooled = (sessionPool?.pool.runtimes() ?? []).flatMap((runtime) =>
      runtime.live?.core !== undefined ? [runtime.live.core] : []
    );
    return [current, ...pooled];
  }
  // 界面里确认别的项目的设置（与审批同一个排队；同启动时的确认，记在同一处）
  const askTrust = (root: string) => (entries: readonly TrustEntry[]) =>
    approvalQueue.serial(() => askTrustPanel(shell, root, entries));
  // 同一个项目的设置同时只读一次（两个会话同时打开不弹两次确认）
  const readingSettings = new Map<string, Promise<SettingsSnapshot>>();
  async function settingsForProject(root: string): Promise<SettingsSnapshot | undefined> {
    const key = rootKey(root);
    if (key === rootKey(governanceRoot)) return undefined;
    const known = projectSettings.get(key);
    if (known !== undefined) return known;
    const reading =
      readingSettings.get(key) ??
      (async () => {
        let snapshot = await openSessionSettings(root, {
          confirmation: { kind: "interactive", ask: askTrust(root) },
        });
        if (flags.noHooks) snapshot = withHooksDisabled(snapshot);
        projectSettings.set(key, snapshot);
        return snapshot;
      })().finally(() => readingSettings.delete(key));
    readingSettings.set(key, reading);
    return reading;
  }
  // 决策 485：在本进程里开起工作清单里没开的会话（按它自己的治理根与工作区续接），收进会话池；开不成写明原因（卡片留着）。
  // 同一个会话同时只开一次
  const openingListed = new Map<string, Promise<string | undefined>>();
  function openListed(entry: ListedSession, task = ""): Promise<string | undefined> {
    const running = openingListed.get(entry.sessionId);
    if (running !== undefined) return running;
    const opening = openListedOnce(entry, task).finally(() =>
      openingListed.delete(entry.sessionId)
    );
    openingListed.set(entry.sessionId, opening);
    return opening;
  }
  async function openListedOnce(entry: ListedSession, task: string): Promise<string | undefined> {
    const pool = sessionPool?.pool;
    if (pool === undefined || pool.runtimeOf(entry.sessionId) !== undefined) return undefined;
    const name = sessionNameOf(entry.governanceRoot, entry.sessionId, entry.workspaceRoot);
    if (sessionOpenElsewhere(entry.sessionFile)) return `session ${name} is open elsewhere`;
    let snapshot: SettingsSnapshot | undefined;
    try {
      snapshot = await settingsForProject(entry.governanceRoot);
    } catch (error) {
      return `can't open ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const core = newCore(
      asSessionId(entry.sessionId),
      entry.governanceRoot,
      entry.workspaceRoot,
      current.modeCell.current,
      snapshot
    );
    core.name = name;
    if (poolExiting) return "Pigeon is closing";
    try {
      core.opened = await openCore(core, { resume: true });
    } catch (error) {
      return `can't open ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
    await restoreAgents(core);
    adoptWorkspace(core, core.opened.scope.workspaceRoot);
    attachCoreRuntime(coreContext, core);
    // 开的途中关掉了 Pigeon：释放，不收进面板（工作树留着，它还在清单里）
    if (poolExiting) {
      await closeCore(core, { reason: "exit" });
      return "Pigeon is closing";
    }
    core.task = task;
    pool.adopt(pooledRuntimeOf(coreContext, core), {
      name: core.name,
      task,
      ...(core.worktree !== undefined
        ? { worktree: { path: core.worktree.path, branch: core.worktree.branch } }
        : {}),
      workspace: tildePath(core.workspaceRoot, homedir()),
    });
    return undefined;
  }
  // 决策 485：/reload、/config 对别的项目的会话：各按自己项目重读再重建（空闲时）；有新的没确认过的会执行命令的条目，在界面里
  // 确认（拒绝则这次不用）
  async function reloadOtherProjects(currentRoot: string): Promise<string[]> {
    const roots = new Map<string, string>();
    for (const core of openCores()) {
      const key = rootKey(core.governanceRoot);
      if (key !== rootKey(currentRoot) && !roots.has(key)) roots.set(key, core.governanceRoot);
    }
    // 没有开着会话的别的项目：快照作废，下次打开那边的会话时重读
    for (const key of [...projectSettings.keys()]) {
      if (!roots.has(key) && key !== rootKey(currentRoot)) projectSettings.delete(key);
    }
    for (const [key, root] of roots) {
      const before = key === rootKey(governanceRoot) ? settings : projectSettings.get(key);
      if (before === undefined) continue;
      try {
        const plan = planSettingsReload(before, flags.noHooks ? { hooksDisabled: true } : {});
        const choice = plan.pending.length > 0 ? await askTrust(root)(plan.pending) : "trust";
        const result = applySettingsReload(plan, choice);
        if (choice === "trust" && plan.pending.length > 0) recordTrustedEntries(root, plan.pending);
        setProjectSettings(root, result.snapshot);
        catalogs.delete(key);
        rebuildPooled(root);
      } catch (error) {
        say(
          `reloading settings in ${root} failed: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }
    return [];
  }
  // 决策 485：/memory 跟着当前会话所在的项目；打转检测按它的设置
  function followCurrent(): void {
    const snapshot = settingsOfCore(current);
    memoryContext.governanceRoot = current.governanceRoot;
    memoryContext.limits = memoryLimitsOf(snapshot);
    loopGuard = loopGuardSettingsOf(snapshot);
    // 键位跟着当前会话所在项目的设置
    shellHolder.current?.applyKeybindings(keybindingsSectionOf(snapshot));
  }
  const bundleOf = (): RuntimeBundle => coreBundle(current);
  const bindingOf = (core: SessionCore) => {
    const bundle = coreBundle(core);
    return {
      runtime: bundle.adapter,
      grants: {
        root: core.governanceRoot,
        store: bundle.grantStore,
        configRules: bundle.configGrants,
        layeredRules: bundle.settings.grants,
      },
      hooks: bundle.hooks,
      workspaceRoot: core.workspaceRoot,
      root: core.governanceRoot,
    };
  };
  // 决策 433–438：会话回退的运行面（每次按当前会话现取）
  const rewindHost = (): RewindHost => {
    const bundle = bundleOf();
    const checkpoints = current.opened?.checkpoints;
    return {
      workspaceRoot: current.workspaceRoot,
      sessionStore: bundle.sessionStore,
      ...(checkpoints !== undefined ? { checkpoints } : {}),
      adapter: bundle.adapter,
      status: bundle.status,
      prune: bundle.prune,
      ...(bundle.taskList !== undefined ? { taskList: bundle.taskList } : {}),
      grants: bundle.grantStore,
    };
  };
  // 决策 453：状态栏与欢迎头的模型名
  const modelLabel = modelLabelOf(startBundle.modelInfo);
  // 决策 491：/status 的数据（现取；读会话记录这类异步工作在这里做）
  async function statusReport(): Promise<StatusReport> {
    const core = current;
    let record: string | undefined;
    try {
      record = await coreBundle(core).sessionStore.filePath();
    } catch {
      record = undefined;
    }
    const layers = [
      { layer: "user" as const, path: userSettingsPath(homedir()) },
      { layer: "project" as const, path: projectSettingsPath(core.governanceRoot) },
      { layer: "local" as const, path: projectLocalSettingsPath(core.governanceRoot) },
    ].map((entry) => ({ ...entry, present: existsSync(entry.path) }));
    let git: { commit: string; dirty: boolean } | undefined;
    try {
      git = describeHead(core.workspaceRoot);
    } catch {
      git = undefined;
    }
    const running = agentHub?.runningUnder(core.sessionId) ?? 0;
    return {
      sessionId: core.sessionId,
      ...(core.name !== "" ? { name: core.name } : {}),
      activity: shellHolder.current?.isRunning() === true ? "running" : "idle",
      project: tildePath(core.governanceRoot, homedir()),
      cwd: statusCwd(
        core.governanceRoot,
        core.workspaceRoot,
        homedir(),
        treesHomeOf(core.governanceRoot)
      ),
      ...(record !== undefined ? { record: tildePath(record, homedir()) } : {}),
      settings: layers,
      mode: core.modeCell.current,
      ...(git !== undefined ? { git } : {}),
      ...(sandbox !== undefined
        ? {
            sandbox: {
              ...(flags.sandbox?.network !== undefined ? { network: flags.sandbox.network } : {}),
              ...(flags.sandbox?.approval !== undefined
                ? { approval: flags.sandbox.approval }
                : {}),
            },
          }
        : {}),
      agents: { count: running },
    };
  }
  // 换会话的守卫（换手开始时与等待之后各看一次）：移进工作树排着、正在进入面板里的会话、当前这一轮在收尾等（壳的判断，
  // 不含"正在换手"本身）
  const switchRefused = (): boolean =>
    worktreeSwitch.pending() || entering || shell.switchBlocked() !== undefined;
  // 开好新会话核之后、换手之前：认领工作目录等（prepare），等旧会话未完成的快照拍完（决策 350），再看一次守卫——等待期间
  // （别的项目的设置确认、开运行面、拍快照）旧会话可能已调了 enter_worktree 或进了收尾。哪一步不成即释放新会话核再报错
  async function settleBeforeSwitch(
    next: SessionCore,
    previous: SessionCore,
    prepare: () => void
  ): Promise<void> {
    try {
      prepare();
      await previous.opened?.checkpoints?.settle();
      if (switchRefused()) throw new Error("can't switch sessions right now");
    } catch (error) {
      await closeCore(next, { reason: "switch" }).catch(() => {});
      throw error;
    }
  }
  // 决策 496：/clear 与 /new [path] 的新会话核——运行面、绑定、/status 与在用标记都按同一个工作目录（开核时显式给出，再认领）
  async function createNewSession(
    request: NewSessionRequest
  ): Promise<{ sessionId: SessionId; binding: TuiSessionBinding }> {
    if (switchRefused()) throw new Error("can't switch sessions right now");
    const previous = current;
    const place = newSessionPlace(
      request,
      { root: previous.governanceRoot, workspace: previous.workspaceRoot },
      homedir()
    );
    const snapshot =
      rootKey(place.root) === rootKey(previous.governanceRoot)
        ? previous.settings
        : await settingsForProject(place.root);
    const id = newSessionId();
    const next = newCore(id, place.root, place.workspace, previous.modeCell.current, snapshot);
    // 决策 432：新会话等第一次真要落盘时才建会话文件
    next.opened = await openCore(next, { workspaceRoot: place.workspace, deferSessionFile: true });
    await settleBeforeSwitch(next, previous, () => {
      adoptWorkspace(next, next.opened?.scope.workspaceRoot ?? place.workspace);
      // 决策 456：会话名（还没改过即缺省名——面板卡片与 trace 都用它）
      next.name = sessionNameOf(place.root, id, next.workspaceRoot);
    });
    const bundle = coreBundle(next);
    if (bundle.instructionsNotice !== undefined) shell.addSystem(bundle.instructionsNotice);
    if (bundle.toolsNotice !== undefined) shell.addSystem(bundle.toolsNotice);
    // 决策 484：还在干活（这一轮没完，或它的子 agent 在跑）就退到面板接着跑
    const working =
      shell.isRunning() || (agentHub !== undefined && agentHub.busyUnder(previous.sessionId) > 0);
    if (working) {
      retireToPanel(previous, shell.handOff());
    } else {
      await closeCore(previous, { reason: "switch" });
      const left = previous.worktree;
      if (left !== undefined && left.path !== next.worktree?.path) {
        shell.addSystem(`left worktree ${left.path} (kept; changes are there)`);
      }
    }
    current = next;
    next.current = true;
    followCurrent();
    attachCoreRuntime(coreContext, next);
    return { sessionId: id, binding: bindingOf(next) };
  }

  const shell = new PigeonTuiShell({
    terminal: new ProcessTerminal(),
    // 决策 482：子 agent 面板与进入子 agent（沙箱、--no-subagents 没有）
    ...(agentHub !== undefined
      ? {
          agents: {
            list: (id: string) => agentHub.agentsOf(id),
            running: () => agentHub.runningTotal(),
            waiting: () => waitingAgents,
            stop: (record: SubagentRecord) => agentHub.stop(record),
            send: (record: SubagentRecord, text: string) => agentHub.sendFromUser(record, text),
            live: (record: SubagentRecord) => record.runtime?.live,
            historyDir: (record: SubagentRecord) =>
              subagentSessionsDirFor(
                sessionsDirOf(rootOfSession(record.top.endpoint.sessionId)),
                record.top.endpoint.sessionId
              ),
          },
        }
      : {}),
    // 决策 439：键位（设置的 keybindings 一节）
    ...(keybindingsSectionOf(settings) !== undefined
      ? { keybindings: keybindingsSectionOf(settings) }
      : {}),
    // 决策 443、484：会话面板；进入面板里的会话即与当前会话换手
    ...(sessionPool !== undefined
      ? {
          pool: {
            source: workList ?? sessionPool.pool,
            enter: (id: string) => enterPooled(id),
            // 决策 485：从主视图离开（← ← 或 /panel）的当前会话进工作清单
            left: () => listCore(current),
            currentWorkspace: () => tildePath(current.workspaceRoot, homedir()),
          },
        }
      : {}),
    // 决策 433–438：会话回退——按当前运行面现取（/reload、换会话之后照样对）；没有快照的会话只退对话
    rewind: {
      tree: () => loadRewindTree(rewindHost()),
      prepare: (to: string | null) => prepareRewind(rewindHost(), to),
      prepareUndo: () => prepareUndo(rewindHost()),
      check: (prepared: PreparedRewind) => checkCode(rewindHost(), prepared),
      apply: (prepared: PreparedRewind, options: Parameters<typeof applyRewind>[2]) =>
        applyRewind(rewindHost(), prepared, options),
    },
    // 决策 442：/config 设置面板——生效值取本进程当前的设置快照，改动写用户级设置（随后壳按 /reload 重建，决策 484：所有会话）
    config: {
      view: () => configView(settingsOfCore(current)),
      busy: agentsBusy,
      // 决策 465：键位组的改动名字带 keybindings: 前缀（值为键，空串 = 清空，default = 恢复缺省）
      set: (id: string, value: string) =>
        id.startsWith(KEYBINDING_ID_PREFIX)
          ? setUserKeybinding(
              current.governanceRoot,
              id.slice(KEYBINDING_ID_PREFIX.length),
              value === "default" ? undefined : value === "" ? [] : [value]
            )
          : setUserConfig(current.governanceRoot, id, value),
      keys: () => keybindingRows(userKeybindings(current.governanceRoot)),
    },
    // 决策 439：输入框补全，路径与 @ 引用以工作区为根
    autocomplete: { basePath: startCore.workspaceRoot, fdPath: findFdPath() },
    // 决策 441：Windows 上右键粘贴取系统剪贴板
    ...(process.platform === "win32" ? { readClipboard: readWindowsClipboard } : {}),
    runtime: startBundle.adapter,
    // 决策 469：当前会话的审批模式（状态栏显示、Shift+Tab 切换）；重建运行面、换会话后取新的
    approvalMode: () => current.opened?.bundle.approvalMode,
    // 决策 470：输入框为空时按两下 ← 打开会话面板（设置可关；/reload 后取新的）
    leftArrowOpensPanel: () => settingsOfCore(current).merged.tui?.leftArrowOpensPanel !== false,
    sessionId: startCore.sessionId,
    // 决策 325：终端界面日志在程序状态目录下
    logDir: tuiLogDirOf(governanceRoot),
    // 决策 451：欢迎头（版本、模型、当前目录）；决策 453：模型名取运行面的模型信息（接入模块声明的优先，其次启动参数），
    // 只有占位标签时不显示。决策 468：状态栏不写模型名
    welcome: {
      version: pigeonVersion(),
      ...(modelLabel !== undefined ? { model: modelLabel } : {}),
      cwd: tildePath(startCore.workspaceRoot, homedir()),
    },
    provider: flags.provider,
    promptHistory: promptHistoryStore(governanceRoot),
    // S3：/grants /revoke /grants save 的命令上下文（命令层在 application/grants.ts）
    grants: bindingOf(startCore).grants,
    // 决策 323、324：本会话的钩子面（会话级事件与 /hooks；清单随开局快照冻结，/reload 换新的）
    hooks: startBundle.hooks,
    // 决策 323：收尾钩子的连续拦截上限取设置快照（/reload 后跟着变）
    stopHookCap: () => settingsOfCore(current).merged.stopHookBlockCap,
    // 会话目录所在的根（花费累计用）
    sessions: { root: governanceRoot },
    // M5 S2（决策 045）：/resume 历史渲染上限
    ...(flags.historyLimit !== undefined ? { historyLimit: flags.historyLimit } : {}),
    // M7（决策 079）：/fork（沙箱里不提供；取当前会话的）
    ...(sandbox === undefined
      ? {
          fork: (args: string) => {
            const opened = current.opened;
            return opened !== undefined ? forkFor(opened)(args) : Promise.resolve("");
          },
        }
      : {}),
    // 决策 245：沙箱会话的 /export 手动交回
    ...(sandbox !== undefined
      ? { sandbox: { exportChanges: () => exportSandbox(sandbox, bundleOf().jobs) } }
      : {}),
    // S4：/resume <sessionId> 的换绑工厂——续会话入口同一配方：
    // restoredGrants 种子（决策 3b，还原目标会话的生效 grant，静默继续有效）+
    // buildRuntime + 旧运行面释放。先建后换：装配失败（如 grants.json 畸形）时
    // 旧运行面不受影响，壳继续留在原会话
    // 沙箱会话里不提供换绑（命令给出原因）
    ...(sandbox !== undefined ? {} : { resume: resumeOptions() }),
    status: statusReport,
    // 决策 496：/clear 原地换新对话（工作目录不变）；/new [path] 在 path 开新会话（不给即项目根），项目与工作目录的认法与
    // 在那里启动 pigeon 相同（别的项目的设置在界面里确认）。沿用当前的审批模式；当前会话还在干活就退到面板接着跑，闲着的关掉
    //（与 /resume 换走时同一套）。沙箱里不提供（旧会话无处可去）
    ...(sandbox === undefined ? { newSession: { create: createNewSession } } : {}),
    // 决策 340、484：/reload 重读设置，新快照自下一轮起生效：当前会话马上重建，面板里的会话空闲时重建
    // 决策 485：当前会话所在的项目照 /reload 的确认流程；别的项目的会话各按自己项目重读（新的没确认过的条目在界面里确认）
    reload: createSettingsReloader({
      current: () => settingsOfCore(current),
      // 决策 324：--no-hooks 是本次运行的进程级开关，/reload 重读出的新快照同样停用钩子
      ...(flags.noHooks ? { hooksDisabled: true } : {}),
      sandboxSessionId: () => (sandbox !== undefined ? current.sessionId : undefined),
      busy: agentsBusy,
      apply: async (snapshot) => {
        await rebuildMain(snapshot);
        rebuildPooled(current.governanceRoot);
      },
      // 当前项目有没有变化都重读别的项目
      after: () => reloadOtherProjects(current.governanceRoot),
    }),
    // 决策 294 B1：/tasks 查看当前会话的任务清单（换会话后跟着当前会话）
    tasks: () => {
      const list = bundleOf().taskList;
      return list !== undefined ? renderTaskList(list.items()) : undefined;
    },
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
    // 决策 484：面板里排着重建、还没重建就成了当前会话的，在这一轮收尾时按新快照重建
    afterTurn: (info) => worktreeSwitch.afterTurn(info) ?? rebuildIfStale(),
    // 决策 456：/rename 改当前会话的名字——记进会话记录（续接后还在）；沙箱里照样能改。改成了回一行简短结果（会话名不在
    // 主视图上，看不到别处变化）
    renameSession: (name: string) => {
      if (!validSessionName(name)) {
        return "invalid name: use letters, digits, _, - and . (max 40)";
      }
      bundleOf().sessionStore.setName(name);
      current.name = name;
      return `renamed to ${name}`;
    },
    // 决策 456：会话名（面板上当前会话的卡片、/take 的说明用）
    sessionName: (id: string) =>
      id === current.sessionId
        ? current.name
        : (sessionPool?.pool.runtimeOf(id)?.live?.core.name ??
          sessionNameOf(current.governanceRoot, id, current.workspaceRoot)),
    // 决策 448：/worktrees 列出与删除留下的工作树（git 仓库、不在沙箱里才有）
    ...(sandbox === undefined
      ? {
          worktrees: {
            // 按当前会话所在的仓库现判断
            run: (args: readonly string[]) =>
              isGitWorkspace(current.governanceRoot)
                ? worktreesFaceOf(current).run(args)
                : "not a git repository",
            hasPending: () =>
              isGitWorkspace(current.governanceRoot) && worktreesFaceOf(current).hasPending(),
            confirmPending: () =>
              isGitWorkspace(current.governanceRoot)
                ? worktreesFaceOf(current).confirmPending()
                : "not a git repository",
            cancelPending: () => {
              if (isGitWorkspace(current.governanceRoot)) worktreesFaceOf(current).cancelPending();
            },
          },
        }
      : {}),
    // S5+（裁决 033）：双击 Ctrl+C / /quit 的真实退出路径——壳内已先 stop()
    //（dispose 对称、挂起审批 fail-closed），此处只释放当前运行面并退进程
    onExit: release,
  });
  // 决策 340：/reload 的先建后换（当前会话）；决策 446：会话移进工作树时同样按这条路重建（工作区先换成工作树）
  async function rebuildMain(snapshot: typeof settings): Promise<void> {
    // 先建后换（复审 P2）：重建成功才换上新快照；重建失败时旧快照与旧运行面都保持不变，
    // /reload 会照当前快照重新列出待确认条目、可重试
    const core = current;
    const previous = coreBundle(core);
    const reloaded = await reopenMainSessionForReload(reloadContextOf(core), snapshot, {
      sessionId: core.sessionId,
      bundle: previous,
    });
    core.settingsStale = false;
    setProjectSettings(core.governanceRoot, snapshot);
    // 决策 480：子 agent 的类型随 /reload 重读
    catalogs.delete(rootKey(core.governanceRoot));
    // 决策 439：键位随新快照重装
    shellHolder.current?.applyKeybindings(keybindingsSectionOf(snapshot));
    loopGuard = reloaded.loopGuard;
    // 决策 350：换走旧运行面之前先等它未完成的快照拍完（新运行面在同一工作区上接着改文件）
    await core.opened?.checkpoints?.settle();
    // 决策 323、324：换走旧运行面前跑旧会话的 SessionEnd（reason "switch"），记录落在本会话文件；
    // 壳 rebindSession 随后会为重建后的会话跑 SessionStart（source "resume"）
    await shellHolder.current?.endSession("switch");
    core.detachGuard?.();
    core.detachGuard = undefined;
    await disposeRuntime(previous).catch(() => {});
    core.opened = reloaded.opened;
    attachCoreRuntime(coreContext, core);
    shellHolder.current?.rebindSession(core.sessionId, bindingOf(core));
  }
  // 决策 484：/reload、/config 对面板里的会话同样生效——空闲的马上重建，在跑的这一轮跑完后重建；它的子 agent 在跑时等它们停下。
  // 重建在会话池里独占进行（期间不开跑、不叫醒、不能进入，发来的话排着）；同一个会话只排一次
  function rebuildPooled(root: string): void {
    for (const runtime of sessionPool?.pool.runtimes() ?? []) {
      const core = runtime.live?.core;
      if (core === undefined || rootKey(core.governanceRoot) !== rootKey(root)) continue;
      core.settingsStale = true;
      scheduleRebuild(core);
    }
  }
  function scheduleRebuild(core: SessionCore): void {
    const pool = sessionPool?.pool;
    if (pool === undefined || core.reloadQueued === true) return;
    core.reloadQueued = true;
    const retry = (): void => {
      setTimeout(() => {
        if (!pool.whenIdle(core.sessionId, apply)) core.reloadQueued = false;
      }, POOLED_RELOAD_RETRY_MS).unref();
    };
    const apply = (): void => {
      // 成了当前会话（在这一轮收尾时重建）、已去掉、已重建过：不再管
      if (core.closed === true || core.current || core.settingsStale !== true) {
        core.reloadQueued = false;
        return;
      }
      if (agentHub !== undefined && agentHub.busyUnder(core.sessionId) > 0) {
        retry();
        return;
      }
      const started = pool.exclusive(core.sessionId, async () => {
        try {
          await rebuildPooledCore(core);
        } catch (error) {
          sayOf(coreContext, core)(
            `reloading settings failed: ${error instanceof Error ? error.message : String(error)}`,
            true
          );
        } finally {
          core.reloadQueued = false;
        }
      });
      if (!started) retry();
    };
    if (!pool.whenIdle(core.sessionId, apply)) core.reloadQueued = false;
  }
  // 决策 484：成了当前会话、还没按新快照重建的：当前会话的子 agent 没在跑时重建
  function rebuildIfStale(): Promise<void> | undefined {
    const core = current;
    if (core.settingsStale !== true || agentsBusy() !== undefined) return undefined;
    return rebuildMain(settingsOfCore(core)).catch((error: unknown) => {
      shell.addAlert(
        `reloading settings failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  async function rebuildPooledCore(core: SessionCore): Promise<void> {
    const opened = core.opened;
    if (opened === undefined || core.closed === true) return;
    const reloaded = await reopenMainSessionForReload(reloadContextOf(core), settingsOfCore(core), {
      sessionId: core.sessionId,
      bundle: opened.bundle,
    });
    core.settingsStale = false;
    await opened.checkpoints?.settle();
    await runSessionEvent(opened.bundle, "SessionEnd", "switch", { reason: "switch" });
    core.detachGuard?.();
    core.detachGuard = undefined;
    await disposeRuntime(opened.bundle).catch(() => {});
    core.opened = reloaded.opened;
    attachCoreRuntime(coreContext, core);
    const report = await runSessionEvent(reloaded.opened.bundle, "SessionStart", "resume", {
      source: "resume",
    });
    if (report !== undefined) {
      for (const line of report.systemMessages) sayOf(coreContext, core)(line);
      core.startContexts.push(...report.additionalContext);
    }
  }
  // 会话级钩子（面板里的会话重建时用；当前会话的由壳跑）；出错不挡
  async function runSessionEvent(
    bundle: RuntimeBundle,
    event: "SessionStart" | "SessionEnd",
    matcher: string,
    input: Record<string, unknown>
  ) {
    const hooks = bundle.hooks;
    if (hooks === undefined || hooks.disabled) return undefined;
    return hooks.runEvent(event, matcher, input).catch(() => undefined);
  }
  // 决策 340：重建所需的、跨快照不变的部分（按会话核）
  function reloadContextOf(core: SessionCore): MainReloadContext {
    const notice = sayOf(coreContext, core);
    return {
      approvalModeCell: core.modeCell,
      governanceRoot: core.governanceRoot,
      // 决策 445：独立工作树里的会话，重建时工作区仍是工作树（第一条消息之前会话文件还没建，推导不出）
      ...(rootKey(core.workspaceRoot) !== rootKey(core.governanceRoot)
        ? { workspaceRoot: core.workspaceRoot }
        : {}),
      ...(core.enterWorktree !== undefined ? { enterWorktree: core.enterWorktree } : {}),
      streamFn,
      flags,
      ...(sandbox !== undefined
        ? { workspaceHost: sandbox.host, statusFacts: sandboxStatusFacts(sandbox) }
        : {}),
      warn,
      createApprovalHandler: coreApprovalHandler(coreContext, core),
      memoryWrite,
      // 面板里的会话重建不动当前会话 /memory 的上限
      memoryContext: core.current
        ? memoryContext
        : { limits: memoryLimitsOf(settingsOfCore(core)) },
      webToolsFor,
      hooksNotice: (line) => notice(line, true),
      onMcpNote: (note) => notice(`[mcp] ${note}`, true),
      ...(core.registration !== undefined ? { agents: core.registration.host } : {}),
    };
  }
  // 决策 484：会话核从当前会话退到面板（进入面板里的会话、/resume 换走还在干活的）：带上壳交出的这一轮与排着的输入
  function retireToPanel(core: SessionCore, handOff: TuiHandOff): void {
    const pool = sessionPool?.pool;
    if (pool === undefined) return;
    core.startContexts.push(...(handOff.contexts ?? []));
    core.heldInput = handOff.held !== undefined ? [...handOff.held] : undefined;
    core.cancelHandedOff = handOff.interrupt;
    // 决策 485：退到面板的进工作清单
    listCore(core);
    // 还没按新快照重建的（子 agent 在跑没能重建）：在面板里空闲时重建
    if (core.settingsStale === true) queueMicrotask(() => scheduleRebuild(core));
    if (core.task === "") core.task = shellHolder.current?.currentTask() ?? "";
    setCoreRole(coreContext, core, false);
    pool.adopt(
      pooledRuntimeOf(coreContext, core),
      {
        name: core.name,
        task: core.task,
        ...(core.worktree !== undefined
          ? { worktree: { path: core.worktree.path, branch: core.worktree.branch } }
          : {}),
        ...(core.sharedDir === true ? { sharedDir: true } : {}),
        // 决策 489：卡上写它干活的目录（与当前会话的工作区相同时面板不写）
        workspace: tildePath(core.workspaceRoot, homedir()),
      },
      {
        ...(handOff.inflight !== undefined ? { inflight: handOff.inflight } : {}),
        ...(handOff.queued !== undefined ? { queued: handOff.queued } : {}),
      }
    );
  }
  // 决策 484：进入面板里的会话——它成为当前会话（接过它在跑的这一轮与排着的输入），原来的当前会话退到面板接着跑；
  // 一次只进一个
  let entering = false;
  async function enterPooled(id: string): Promise<string | undefined> {
    const pool = sessionPool?.pool;
    if (pool === undefined) return undefined;
    if (
      entering ||
      shell.handOffBlocked() !== undefined ||
      worktreeSwitch.pending() ||
      pool.busy(id)
    ) {
      return "can't switch sessions right now";
    }
    entering = true;
    try {
      return await enterDetached(pool, id);
    } finally {
      entering = false;
    }
  }
  async function enterDetached(
    pool: NonNullable<typeof sessionPool>["pool"],
    id: string
  ): Promise<string | undefined> {
    // 决策 485：工作清单里本进程没开的：先开起来（开不成写明原因）
    const listed = workList?.dormant(id);
    if (listed !== undefined) {
      const refusal = await openListed(listed);
      if (refusal !== undefined) return refusal;
    }
    const card = pool.list().find((item) => item.id === id);
    const detached = pool.detach(id);
    const target = detached?.runtime.live?.core;
    if (detached === undefined || target === undefined) {
      if (card === undefined) return "no such session";
      return card.state === "stopped"
        ? `session ${card.name} is stopped`
        : `session ${card.name} isn't open`;
    }
    // 面板里排着的重建随取出作废；这一轮也没在跑的先按新快照重建再进入（在跑的在这一轮收尾时重建）
    target.reloadQueued = false;
    if (target.settingsStale === true && detached.inflight === undefined) {
      try {
        await rebuildPooledCore(target);
      } catch (error) {
        sayOf(coreContext, target)(
          `reloading settings failed: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }
    const previous = current;
    retireToPanel(previous, shell.handOff());
    current = target;
    followCurrent();
    setCoreRole(coreContext, target, true);
    // 面板里那一轮的结局：钩子拦下的算失败照写，等钩子时被停下的不算一轮
    const inflight = detached.inflight?.then((result) =>
      (result as { status?: unknown } | undefined)?.status === "interrupted" ? undefined : result
    );
    const held = target.heldInput;
    target.heldInput = undefined;
    target.cancelHandedOff = undefined;
    shell.switchSession(target.sessionId, bindingOf(target), {
      ...(inflight !== undefined
        ? {
            inflight,
            // 还在等 UserPromptSubmit 钩子时按 Esc：钩子之后不再开跑
            interrupt: () => {
              target.interrupted = true;
            },
          }
        : {}),
      ...(detached.queued !== undefined ? { queued: detached.queued } : {}),
      ...(held !== undefined ? { held } : {}),
      contexts: target.startContexts.splice(0),
    });
    return undefined;
  }

  function resumeOptions(): NonNullable<TuiShellOptions["resume"]> {
    return {
      root: governanceRoot,
      rebind: async (targetId) => {
        const previous = current;
        if (switchRefused()) throw new Error("can't switch sessions right now");
        // 决策 469：换到的会话沿用当前的审批模式
        // 决策 485：/resume 只管当前会话所在的项目
        const root = previous.governanceRoot;
        const next = newCore(targetId, root, root, previous.modeCell.current, previous.settings);
        // 分支会话回到它的工作树（工作树缺失时响亮失败）；决策 3b：会话 grant 种子还原。两者与 MCP 启动一并在 session-runtime.ts（与 cli resume 同一份）
        // 决策 183：还原对话上下文，悬空的工具调用补"结果未知"的工具结果
        next.opened = await openCore(next, { resume: true });
        // 决策 445、446：换到的会话开在独立工作树里时，工作区与退出清理跟着它；决策 350：等旧会话的快照拍完；再看一次守卫
        await settleBeforeSwitch(next, previous, () => {
          adoptWorkspace(next, next.opened?.scope.workspaceRoot ?? root);
          next.name = sessionNameOf(root, targetId, next.workspaceRoot);
        });
        await restoreAgents(next);
        const bundle = coreBundle(next);
        if (bundle.instructionsNotice !== undefined) shell.addSystem(bundle.instructionsNotice);
        if (bundle.toolsNotice !== undefined) shell.addSystem(bundle.toolsNotice);
        // 决策 484：原来的当前会话还在干活（这一轮没完，或还有子 agent 在干活，含停着但后台作业没收尾的）就退到面板接着跑，
        // 闲着的直接关掉（开好目标会话之后再看）
        const working =
          shell.isRunning() ||
          (agentHub !== undefined && agentHub.busyUnder(previous.sessionId) > 0);
        if (working) {
          retireToPanel(previous, shell.handOff());
        } else {
          // 换走的会话在本进程里到此结束：它派出的子 agent 停下并释放；决策 323、324：释放运行面之前跑它的 SessionEnd
          //（reason "switch"，记录落在旧会话文件）；壳 rebindSession 随后会为新会话跑 SessionStart（source "resume"）。
          // 离开的独立工作树留着
          await closeCore(previous, { reason: "switch" });
          const left = previous.worktree;
          if (left !== undefined && left.path !== next.worktree?.path) {
            shell.addSystem(`left worktree ${left.path} (kept; changes are there)`);
          }
        }
        current = next;
        next.current = true;
        followCurrent();
        attachCoreRuntime(coreContext, next);
        return bindingOf(next);
      },
    };
  }
  const worktreeSwitch = createWorktreeSwitch({
    workspace: () => current.workspaceRoot,
    setWorkspace: (root) => {
      current.workspaceRoot = root;
    },
    rebuild: () => rebuildMain(settingsOfCore(current)),
    adopt: (worktree) => {
      const core = current;
      if (core.worktree?.path !== worktree.path) {
        core.releaseInUse?.();
        core.releaseInUse = holdWorktreeInUse(worktree.path);
      }
      core.worktree = worktree;
      recordWorktreeEntry(coreBundle(core).sessionStore, worktree);
    },
    system: (line, alert) =>
      alert === true ? shellHolder.current?.addAlert(line) : shellHolder.current?.addSystem(line),
    notify: (text) => bundleOf().adapter.notify(text),
    noteForNextInput: (text) => shellHolder.current?.addNextInputNote(text),
    continueNotice: worktreeContinueNotice,
  });
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
  if (startBundle.instructionsNotice !== undefined) shell.addSystem(startBundle.instructionsNotice);
  if (startBundle.toolsNotice !== undefined) shell.addSystem(startBundle.toolsNotice);
  warnSink.attach((line) => shell.addWarning(line));
  if (target.kind === "resume") {
    shell.announceResumed(governanceRoot, target.report);
  } else if (target.picker) {
    shell.openSessionPicker();
  }
  // 进程级退出（283）：立即收尾——释放当前运行面，沙箱会话交回，退进程
  function release(): void {
    // 壳已正常停下（pi-tui 已复位终端）：之后的退出不再写复位序列
    terminalReset.markClean();
    const core = current;
    // 壳已停：此后的告警写回标准错误输出
    warnSink.detach();
    void (async () => {
      // 决策 323、324：退出前跑一次 SessionEnd（reason "exit"）——必须在释放运行面之前，记录才落盘
      // （331：补做复盘记录已随复盘删除，退出不再等补做）
      await shellHolder.current?.endSession("exit");
      // 决策 480：子 agent 先停下并释放（它们与所属会话共用 MCP 连接）
      await agentHub?.close().catch(() => {});
      // 决策 443：关掉 Pigeon，会话面板里的会话全部停止（工作树没有改动即删，有改动保留）
      poolExiting = true;
      const poolProblems = (await sessionPool?.pool.closeAll().catch(() => [])) ?? [];
      for (const line of poolProblems) console.error(line);
      core.detachGuard?.();
      await closeTuiSession({
        governanceRoot: core.governanceRoot,
        sessionId: core.sessionId,
        bundle: coreBundle(core),
        // 决策 245：会话结束时自动交回一次、删除容器；壳已停，分支名与查看命令打到标准输出
        ...(sandbox !== undefined ? { closeSandbox: () => closeSandbox(sandbox) } : {}),
        log: (line) => console.log(`[sandbox] ${line}`),
      });
      // 决策 445：独立工作树——没有改动（或完整取回之后再没有改动）即删；有改动在终端行内问保留还是删除（壳已停）。
      // 决策 494：退出时不删工作树、也不问；收尾统一交给 /worktrees clean
      core.releaseInUse?.();
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
