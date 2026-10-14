// headless 运行入口（M6.5 S1，决策 056）：进程内 API。装配内核在 detached-runtime.ts，
// 以无父会话方式装出完整运行面跑到收尾，带轮次、墙钟与可选 token 上限。每次运行是一个普通会话，
// 会话存储、trace、search 照旧。无人值守下没有审批通道：prompt 档一律 fail-closed 拒绝（006），
// yolo 是人的显式拨档，固化规则照常生效；不新增任何审批语义。
// 结果全部从会话记录算（046）：轮次、工具调用数、usage、失败分类，以及需审批次数——写档与命令档里需要人来批的调用数：
// 以 yolo 批发授权放行（有人在场时会被问）、由人批准或拒绝、因无审批通道而拒绝的；固化规则与会话放权放行的不计。
// 从会话存储现算（决策 180，state/session-judge.ts）。
// 决策 322：验证门、回炉与失败自动分叉重试已删除——本核心只跑一个 Run 到收尾；收尾检查由使用者自配的
// 收尾钩子承担（323），成败不再由程序贴"通过"标签
// 推送记忆（决策 191、193、331、363）：开着时把两层记忆整份放进开工状态块；无人值守，只推送、不注册 update_memory；
// 收尾复盘与压缩前复盘已随决策 331 删除
// 任务清单（294 B1）：开着时给主 agent 注册两件清单工具
// 决策 457、481：子 agent——开着时主 agent 能派子 agent（没有审批通道，与主 agent 一样要审批的一律拒绝）。主 agent 停下时
// 还有子 agent 在跑，照 Claude Code 的 -p 等它们干完、把结果交给主 agent 接着干，直到既没有子 agent 在跑、主 agent 也停下才
// 结束；连续干等超过上限（设置的 agents.runWaitMinutes，缺省 10 分钟，0 为不限）即停掉剩下的、丢下它们没交回的结果。撞到
// 本次运行的上限（轮数、墙钟、token、打转）或外部中止照上限停，子 agent 一并停下

import type { MemoryLayer } from "../memory/learned.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { BeforeCompaction, CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { PruneSeed } from "../pi-runtime/context-prune.ts";
import type { AgentMessage, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { FailureClass } from "../state/classification.ts";
import { DEFAULT_STOP_HOOK_BLOCK_CAP } from "../state/hooks.ts";
import { newSessionId, type RunId, type SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import type { OutcomeLabel } from "../state/outcome-label.ts";
import { sessionsDirOf } from "../state/paths.ts";
import type {
  RepetitionGuardSettings,
  TruncationContinuationSettings,
} from "../state/runaway-config.ts";
import type { ThinkingLevel, TurnUsage } from "../state/runtime-events.ts";
import { storeAttemptLabel, storeRunMetrics } from "../state/session-judge.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import {
  agentLimitsOfSettings,
  emptySettingsSnapshot,
  type SettingsSnapshot,
} from "../state/settings.ts";
import type { KeptJob } from "../tools/background-jobs.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { MailGate } from "./agent-mail.ts";
import { loadAgentTypes } from "./agent-types.ts";
import { settleBackgroundJobs } from "./background-jobs.ts";
import { attachCheckpoints } from "./checkpoints.ts";
import { compactionWarner } from "./compaction-text.ts";
import { createDetachedRuntime, type DetachedRuntimeRequest } from "./detached-runtime.ts";
import { DEFAULT_MODEL_PLACEHOLDER } from "./launch-flags.ts";
import { attachLoopGuard, type LoopStop } from "./loop-guard.ts";
import type { McpSession } from "./mcp.ts";
import type { ApprovalModeCell, LearnedMemoryConfig, RuntimeBundle } from "./runtime.ts";
import { defaultSessionName } from "./session-name.ts";
import { agentMessageEntry } from "./session-store.ts";
import type { StatusHashes } from "./status-block.ts";
import type { StatusFacts } from "./status-sources.ts";
import { createSubagentOpener } from "./subagent-runtime.ts";
import { AgentHub } from "./subagents.ts";
import type { WarnSink } from "./warnings.ts";
import type { WebToolsConfig } from "./web-tools.ts";

export type HeadlessStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "unknown"
  | "turn-limit"
  | "wall-clock-limit"
  | "token-limit"
  // 空回复异常结束（决策 170 ②）：模型的回复既无文字也无工具调用，重试一次仍是如此。不算模型服务故障
  | "empty-reply"
  // 打转叫停（决策 307）：成败算失败
  | "looping"
  // 收尾钩子连续拦截到上限（决策 322 / 323）：照常结束，不贴失败标签
  | "stop-hook-limit";

// 退出码按终态映射；1 留给参数与装配错误（cli 入口的异常出口）
export const HEADLESS_EXIT_CODES: Readonly<Record<HeadlessStatus, number>> = {
  completed: 0,
  failed: 2,
  aborted: 3,
  unknown: 4,
  "turn-limit": 5,
  "wall-clock-limit": 6,
  "token-limit": 7,
  "empty-reply": 8,
  looping: 9,
  "stop-hook-limit": 10,
};

export interface HeadlessRunOptions {
  task: string;
  governanceRoot: string;
  // 决策 325：本次运行的设置快照（pigeon run 由入口读好并确认过会执行命令的条目；缺省为空快照，跑批器如此）
  settings?: SettingsSnapshot;
  workspaceRoot: string;
  // 决策 098：执行端；缺省为 workspaceRoot 上的本地实现（容器工作区由调用方注入，workspaceRoot 为宿主侧占位目录）
  workspaceHost?: WorkspaceHost;
  // 决策 354：入口给出的确知事实（沙箱档位、网络能否用），写进开工状态块的环境一节
  statusFacts?: StatusFacts;
  streamFn: StreamFn;
  yolo: boolean;
  provider?: string;
  modelId?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  wallClockMs?: number;
  // 累计 totalTokens 达到即中止（usage 取自 turn.completed）
  maxTokens?: number;
  // 外部中止（调用方的限额看守等）：在途的运行立即中止、不再回炉，终态记 aborted，不写撞上限记录
  abortSignal?: AbortSignal;
  skillRoots?: readonly SkillRoot[];
  // 决策 330：读不读人写的说明（AGENTS.md）；缺省读，跑批器关掉
  agentsMd?: boolean;
  homeDir?: string;
  persistThinking?: boolean;
  sessionId?: SessionId;
  // 决策 061：编辑模式，缺省见 tools/edit-mode.ts 的 DEFAULT_EDIT_MODE（现为 replace）
  editMode?: EditMode;
  // 决策 063、347：单轮输出上限（缺省不设，跟模型）
  maxOutputTokens?: number;
  // 决策 367：撞上限续跑与流式重复检测（缺省取设置快照；跑批器显式给出）
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // 决策 365：收尾等后台作业的总时限（秒；缺省取设置快照；跑批器显式给出）
  backgroundCloseoutSeconds?: number;
  // M9：采样温度（缺省不设）；冻结进注入快照并随 Run 开始条目 落盘
  temperature?: number;
  // M9：任务源给的系统指令——追加进 system prompt 并随之冻结；任务说明（task）不受影响
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）；关掉时三件会话检索工具（339 加 list_sessions）不注册，系统提示不提它们
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（模型窗口、预留、保留量、触发点）；缺省为产品缺省，集成冒烟可调低触发点
  compaction?: CompactionConfigInput;
  // 决策 192、207：压缩前回调（通用挂点，尚无生产入口设置它）；缺省不挂
  beforeCompaction?: BeforeCompaction;
  // 运行时告警的出口（自动压缩没压成、压缩前回调失败；缺省标准错误输出，同一类只说一次；测试注入）
  warn?: WarnSink;
  // 决策 191、193、331、363：推送记忆（两层记忆整份放进开工状态块）；无人值守，只推送、不注册 update_memory。缺省关着
  pushedMemory?: boolean;
  // 学到的记忆的两层上限（字符，按码点计）；缺省取设置快照的 memory 一节
  memoryLimits?: MemoryLimits;
  // 推送哪几层；缺省两层（跑批器只推项目级）
  memoryLayers?: readonly MemoryLayer[];
  // 决策 294 B1：任务清单工具；缺省关着——pigeon run 按设置的 tools.taskList 缺省打开，跑批器各条件不给
  taskList?: boolean;
  // 决策 287–291：联网工具的配置——在场即注册两件工具；缺省不注册（pigeon run 由启动参数缺省给出，
  // --sandbox-network off 不给；跑批器各条件不给）
  webTools?: WebToolsConfig;
  // 决策 305–308：打转检测设定——挂在主 agent 上；缺省不挂（pigeon run 按项目配置缺省打开，跑批器各条件明确关掉）
  loopGuard?: LoopGuardSettings;
  // 测试注入 MCP 会话；缺省按治理根的 MCP 配置启动
  startMcp?: () => Promise<McpSession>;
  // M7（决策 077）：分叉续跑——分支会话头、由会话树还原的初始消息、不给新输入从已有消息续跑
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  // 决策 363：分叉续跑时状态变化通道的起点（分支会话记录里最后发出的一份）
  statusSent?: StatusHashes;
  // 决策 361：分叉续跑时上下文裁剪的起点（取自分支会话记录）
  pruneSeed?: PruneSeed;
  continueFromHistory?: boolean;
  // 运行面装起来后的回调（挂会话树写穿）
  onBundle?: (bundle: RuntimeBundle) => void;
  // 决策 457、481：主 agent 能不能派子 agent；缺省不能（pigeon run 按 --no-subagents 缺省打开，沙箱与跑批器不给）
  subagents?: boolean;
  // 测试用：干等子 agent 的上限（毫秒）；缺省取设置的 agents.runWaitMinutes
  subagentWaitMs?: number;
}

export interface HeadlessRunMetrics {
  // 本会话的 Run；运行面没装起来时缺省
  runId?: RunId;
  failure: FailureClass | null;
  turns: number;
  toolCalls: number;
  approvalsNeeded: number;
  usage: TurnUsage;
}

export interface HeadlessRunResult extends HeadlessRunMetrics {
  sessionId: SessionId;
  status: HeadlessStatus;
  durationMs: number;
  errorMessage?: string;
  // 由会话现算的标签（决策 322：不再有"通过"——验证门已删除，正常做完记未知）
  label: OutcomeLabel;
  // 打转叫停时在场（307）：计数与重复的调用（收尾说明用）
  looping?: LoopStop;
  // 决策 409：会话结束后保留中的后台作业（没有即缺省）。只在机器读的结果里列出
  keptJobs?: KeptJob[];
}

export async function runHeadless(options: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const pushed = options.pushedMemory === true;
  // 护栏（112 的延伸）：注入了执行端时 workspaceRoot 在宿主一侧、不是 agent 干活的工作区。分支会话
  // 要在它上面打 git 快照、到独立工作树里续跑——对容器里的工作区只会得到假结果，装配前一律拒绝
  if (options.workspaceHost !== undefined && options.branchHeader !== undefined) {
    throw new Error("branch sessions are not supported in a container workspace");
  }
  const sessionId = options.sessionId ?? newSessionId();
  const startedAt = Date.now();
  // 这一步的墙钟
  let deadline = options.wallClockMs !== undefined ? startedAt + options.wallClockMs : undefined;
  let timer: NodeJS.Timeout | undefined;
  // 推送记忆（191、331）：无人值守——只推送，不给写入配置（冲突处理随之为无人值守版）
  const learnedMemory: LearnedMemoryConfig | undefined = pushed
    ? {
        ...(options.memoryLimits !== undefined ? { limits: options.memoryLimits } : {}),
        ...(options.memoryLayers !== undefined ? { layers: options.memoryLayers } : {}),
      }
    : undefined;
  // 运行面装起来后拿到的装配结果：回炉在释放之前经它的会话文件落验证记录
  let liveBundle: RuntimeBundle | undefined;
  // 已注册工具的风险档位（需审批次数按它现算；运行面没装起来时为空）
  let toolTiers: ReadonlyMap<string, string> = new Map();
  // 决策 457、481：通讯录与子 agent（开着时）；主 agent 与子 agent 共用的审批模式单元
  const modeCell: ApprovalModeCell = { current: options.yolo ? "yolo" : "prompt" };
  const settingsSnapshot = options.settings ?? emptySettingsSnapshot(options.governanceRoot);
  const agentLimits = agentLimitsOfSettings(settingsSnapshot);
  const subagentWaitMs = options.subagentWaitMs ?? agentLimits.runWaitMinutes * 60_000;
  // 子 agent 交回、发来消息或状态有变时叫醒干等
  let wakeWaiter: (() => void) | undefined;
  const wakeUp = (): void => {
    const resolve = wakeWaiter;
    wakeWaiter = undefined;
    resolve?.();
  };
  const warnLine = options.warn ?? ((line: string) => console.error(line));
  const agentHub =
    options.subagents === true
      ? new AgentHub({ mail: new MailGate(), onChange: wakeUp })
      : undefined;
  const agentCatalog =
    agentHub !== undefined
      ? loadAgentTypes({
          governanceRoot: options.governanceRoot,
          ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
        })
      : undefined;
  for (const problem of agentCatalog?.problems ?? []) warnLine(`[agents] ${problem}`);
  const mainBundle = (): RuntimeBundle => {
    if (liveBundle === undefined) throw new Error("the session isn't open yet");
    return liveBundle;
  };
  const agentRegistration =
    agentHub !== undefined && agentCatalog !== undefined
      ? agentHub.registerSession({
          sessionId,
          name: () => defaultSessionName(options.workspaceRoot, sessionId),
          deliver: (text) => {
            mainBundle().adapter.notify(text);
            wakeUp();
          },
          pendingNotices: () => liveBundle?.adapter.pendingNotices() ?? 0,
          record: (entry) => mainBundle().sessionStore.append(agentMessageEntry(entry)),
          open: createSubagentOpener({
            governanceRoot: options.governanceRoot,
            streamFn: options.streamFn,
            flags: {
              yolo: options.yolo,
              provider: options.provider ?? DEFAULT_MODEL_PLACEHOLDER.provider,
              modelId: options.modelId ?? DEFAULT_MODEL_PLACEHOLDER.modelId,
              persistThinking: options.persistThinking ?? true,
              ...(options.thinking !== undefined ? { thinkingLevel: options.thinking } : {}),
              ...(options.maxOutputTokens !== undefined
                ? { maxOutputTokens: options.maxOutputTokens }
                : {}),
              ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
              ...(pushed ? { pushedMemory: true } : {}),
              ...(options.sessionSearch !== undefined
                ? { sessionSearch: options.sessionSearch }
                : {}),
            },
            warn: warnLine,
            topSessionId: () => sessionId,
            topSessionFile: () => mainBundle().sessionStore.filePath(),
            topContext: () => ({
              sessionId,
              settings: settingsSnapshot,
              approvalModeCell: modeCell,
              workspaceRoot: options.workspaceRoot,
              ...(mainBundle().mcp !== undefined ? { mcp: mainBundle().mcp } : {}),
              ...(options.webTools !== undefined ? { webTools: options.webTools } : {}),
              grants: mainBundle().grantStore.list(),
              modelId: options.modelId ?? DEFAULT_MODEL_PLACEHOLDER.modelId,
              transcript: () => mainBundle().adapter.transcript(),
            }),
            notice: (path, line) => warnLine(`[${path}] ${line}`),
            ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
          }),
          catalog: () => agentCatalog,
          limits: () => agentLimits,
        })
      : undefined;
  // 本次运行的装配参数
  const surface: Omit<DetachedRuntimeRequest, "sessionId"> = {
    governanceRoot: options.governanceRoot,
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
    workspaceRoot: options.workspaceRoot,
    ...(options.workspaceHost !== undefined ? { workspaceHost: options.workspaceHost } : {}),
    ...(options.statusFacts !== undefined ? { statusFacts: options.statusFacts } : {}),
    streamFn: options.streamFn,
    // 决策 067：三个入口的模型占位缺省统一为同一常量（真实模型元数据由 streamFn 插件提供）
    provider: options.provider ?? DEFAULT_MODEL_PLACEHOLDER.provider,
    modelId: options.modelId ?? DEFAULT_MODEL_PLACEHOLDER.modelId,
    yolo: options.yolo,
    ...(options.thinking !== undefined ? { thinkingLevel: options.thinking } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.persistThinking !== undefined ? { persistThinking: options.persistThinking } : {}),
    ...(options.skillRoots !== undefined ? { skillRoots: options.skillRoots } : {}),
    ...(options.agentsMd !== undefined ? { agentsMd: options.agentsMd } : {}),
    ...(options.editMode !== undefined ? { editMode: options.editMode } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.truncationContinuation !== undefined
      ? { truncationContinuation: options.truncationContinuation }
      : {}),
    ...(options.repetitionGuard !== undefined ? { repetitionGuard: options.repetitionGuard } : {}),
    ...(options.backgroundCloseoutSeconds !== undefined
      ? { jobCloseoutMs: options.backgroundCloseoutSeconds * 1000 }
      : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.taskDirective !== undefined ? { taskDirective: options.taskDirective } : {}),
    ...(options.sessionSearch !== undefined ? { sessionSearch: options.sessionSearch } : {}),
    ...(options.compaction !== undefined ? { compaction: options.compaction } : {}),
    ...(options.startMcp !== undefined ? { startMcp: options.startMcp } : {}),
    ...(learnedMemory !== undefined ? { learnedMemory } : {}),
    ...(options.taskList === true ? { taskList: true } : {}),
    ...(options.webTools !== undefined ? { webTools: options.webTools } : {}),
  };
  const handle = createDetachedRuntime({
    ...surface,
    sessionId,
    ...(options.beforeCompaction !== undefined
      ? { beforeCompaction: options.beforeCompaction }
      : {}),
    // M8（决策 087）：本次运行的预算冻结进注入快照——回放据此沿用同一预算，不得放宽
    budget: {
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.wallClockMs !== undefined ? { wallClockMs: options.wallClockMs } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    },
    // 决策 418：设了墙钟预算时模型可见（与墙钟定时器同一起点 startedAt）
    ...(options.wallClockMs !== undefined
      ? { wallClock: { totalMs: options.wallClockMs, startedAt, now: Date.now } }
      : {}),
    ...(options.branchHeader !== undefined ? { branchHeader: options.branchHeader } : {}),
    ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}),
    ...(options.statusSent !== undefined ? { statusSent: options.statusSent } : {}),
    ...(options.pruneSeed !== undefined ? { pruneSeed: options.pruneSeed } : {}),
    approvalModeCell: modeCell,
    ...(agentRegistration !== undefined ? { agents: agentRegistration.host } : {}),
    onBundle: (bundle) => {
      liveBundle = bundle;
      // 决策 330：人写的说明超出上限被截断时提示一行（告警出口，缺省标准错误输出）
      // 决策 359：开局没注册 web_search 的原因同样提示一行
      for (const notice of [bundle.instructionsNotice, bundle.toolsNotice]) {
        if (notice !== undefined) (options.warn ?? ((line: string) => console.error(line)))(notice);
      }
      // 决策 305–307：打转检测挂在主 agent 上——提醒进下一轮；计到叫停轮数即以打转中止
      const detachLoopGuard = attachLoopGuard(bundle.adapter, options.loopGuard, (found) => {
        if (limitHit === undefined) {
          looping = found;
        }
        stop("looping");
      });
      bundle.disposers = [...(bundle.disposers ?? []), async () => detachLoopGuard()];
      // 决策 189：无头运行没人看压缩提示——自动压缩没压成与压缩前回调失败写标准错误输出，同一类只说一次
      bundle.adapter.subscribeCompaction(compactionWarner(options.warn));
      toolTiers = bundle.toolTiers;
      // M7（决策 077 / 078）：分支会话在 git 工作区里打快照（/fork 取准确基线）；
      // 非 git 工作区不挂快照（attachCheckpoints 返回 undefined）；执行端另一侧的工作区不在宿主上打快照
      if (options.workspaceHost === undefined && options.branchHeader !== undefined) {
        const checkpoints = attachCheckpoints({ bundle, workspaceRoot: options.workspaceRoot });
        if (checkpoints !== undefined) {
          // 决策 350：运行面停下之后、会话存储关闭之前等未完成的快照拍完（有上限）
          bundle.closers = [...(bundle.closers ?? []), () => checkpoints.close()];
        }
      }
      options.onBundle?.(bundle);
    },
  });
  let limitHit: "turn-limit" | "wall-clock-limit" | "token-limit" | "looping" | undefined;
  let looping: LoopStop | undefined;
  const stop = (reason: NonNullable<typeof limitHit>): void => {
    if (limitHit !== undefined) {
      return;
    }
    limitHit = reason;
    // 只发中止请求；原因随中止请求交给运行面，运行确以中止收尾时 Run 收尾条目据此记撞上限（072 修订）。
    // 中止失败不改变结果：run 以当时的终态收尾
    handle.interrupt(reason).catch(() => {});
  };
  let turns = 0;
  let tokens = 0;
  const unsubscribe = handle.subscribe((event) => {
    if (event.kind !== "turn.completed") {
      return;
    }
    turns += 1;
    tokens += (event.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens ?? 0;
    if (options.maxTurns !== undefined && turns >= options.maxTurns) {
      stop("turn-limit");
    } else if (options.maxTokens !== undefined && tokens >= options.maxTokens) {
      stop("token-limit");
    }
  });
  if (deadline !== undefined) {
    timer = setTimeout(() => stop("wall-clock-limit"), Math.max(0, deadline - Date.now()));
  }
  let externallyAborted = false;
  const onAbort = () => {
    externallyAborted = true;
    handle.interrupt().catch(() => {});
  };
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  if (options.abortSignal?.aborted === true) onAbort();
  let status: HeadlessStatus = "unknown";
  let errorMessage: string | undefined;
  // 决策 365：一次运行结束后等本会话的后台作业（收尾总时限、计入墙钟），把结束通知处理完（撞上限或外部中止即不再等）。
  // 等的途中撞上限或被外部中止：这一步按中止收尾（终态随后按撞上限的原因或外部中止记）
  let drainInterrupted = false;
  const settleRun = async <R>(run: R): Promise<R> => {
    const bundle = liveBundle;
    if (bundle === undefined) {
      return run;
    }
    const stopped = () => limitHit !== undefined || externallyAborted;
    const target = {
      pendingNotices: () => bundle.adapter.pendingNotices(),
      runNotices: () => bundle.adapter.runNotices() as Promise<unknown> as Promise<R>,
      notify: (text: string) => bundle.adapter.notify(text),
    };
    let latest = run;
    for (;;) {
      let progressed = false;
      const jobs = bundle.jobs;
      // 决策 409：保留的作业不等，不算没等完
      if (stopped() && (jobs?.toSettle().length ?? 0) > 0) {
        drainInterrupted = true;
      }
      // 运行没有正常结束（出错、中止）：不进收尾轮，作业随运行面释放停掉并记下，终态保持原样
      const completed = (latest as { status?: unknown } | undefined)?.status === "completed";
      if (jobs !== undefined && completed && jobs.list().length > 0 && !stopped()) {
        const { last } = await settleBackgroundJobs({
          jobs,
          target,
          stopped,
          closeoutMs: bundle.jobCloseoutMs,
        });
        if (stopped() && jobs.toSettle().length > 0) {
          drainInterrupted = true;
        }
        if (last !== undefined) {
          latest = last;
          progressed = true;
        }
      }
      // 决策 481：主 agent 停下了，还有子 agent 在跑或有它们交回的结果：等着、交给主 agent 接着干
      const done = (latest as { status?: unknown } | undefined)?.status === "completed";
      if (!progressed && done && agentHub !== undefined && !stopped()) {
        const waited = await waitForAgents(bundle, stopped);
        if (waited === "notice") {
          latest = await target.runNotices();
          progressed = true;
        } else if (waited === "timeout") {
          const left = agentHub.runningUnder(sessionId);
          await agentRegistration?.unregister();
          warnLine(
            `stopped ${left} sub-agent${left === 1 ? "" : "s"} after waiting ${Math.round(subagentWaitMs / 60_000)} min`
          );
        }
      }
      if (!progressed || stopped()) {
        return latest;
      }
    }
  };
  // 决策 481：干等子 agent——有交回的通知即返回 notice，子 agent 都停下了返回 done，撞上限或外部中止返回 stopped，
  // 连续干等超过上限返回 timeout
  const waitForAgents = async (
    bundle: RuntimeBundle,
    stopped: () => boolean
  ): Promise<"notice" | "done" | "stopped" | "timeout"> => {
    const since = Date.now();
    for (;;) {
      if (stopped()) return "stopped";
      if (bundle.adapter.pendingNotices() > 0) return "notice";
      if (agentHub === undefined || agentHub.runningUnder(sessionId) === 0) return "done";
      const left = subagentWaitMs > 0 ? subagentWaitMs - (Date.now() - since) : 1000;
      if (left <= 0) return "timeout";
      let poll: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        wakeWaiter = resolve;
        // 兜底：撞上限的中止请求不经通讯录，隔一会儿再看一次
        poll = setTimeout(resolve, Math.min(left, 1000));
      });
      clearTimeout(poll);
    }
  };
  try {
    // 决策 323 / 324：会话级钩子——运行面可能异步就绪（MCP 启动）：ready() 等它；装配失败与 run 同一出口（failed）。
    // 端口返回 unknown（编排层不依赖 application），此处收窄到 RuntimeBundle（生产者唯一：本层装配）
    const readyBundle = (await handle.ready?.()) as RuntimeBundle | undefined;
    const hooks = readyBundle?.hooks ?? liveBundle?.hooks;
    // SessionStart：开局补上下文（以一条上下文消息进入，不改开局冻结的系统提示——上下文并进第一条输入）；
    // UserPromptSubmit：可拦下、可补上下文，不能改写
    let task = options.task;
    let preRunBlocked: string | undefined;
    let preRunStopped: string | undefined;
    if (hooks !== undefined && !externallyAborted) {
      const source = options.continueFromHistory === true ? "resume" : "startup";
      const startReport = await hooks.runEvent("SessionStart", source, {
        source,
        ...(options.provider !== undefined && options.modelId !== undefined
          ? { model: `${options.provider}/${options.modelId}` }
          : {}),
      });
      const contexts = [...startReport.additionalContext];
      if (startReport.continueFalse !== undefined) {
        preRunStopped = startReport.continueFalse.stopReason ?? "hook stopped the session";
      } else {
        const promptReport = await hooks.runEvent("UserPromptSubmit", "", { prompt: options.task });
        contexts.push(...promptReport.additionalContext);
        if (promptReport.blocked !== undefined) {
          preRunBlocked = promptReport.blocked.reason;
        } else if (promptReport.continueFalse !== undefined) {
          preRunStopped = promptReport.continueFalse.stopReason ?? "hook stopped the session";
        }
      }
      if (contexts.length > 0) {
        task = `${contexts.join("\n\n")}\n\n${options.task}`;
      }
    }
    // 开工前已被外部中止、或钩子拦下/要求停止：一轮都不跑
    let run: Awaited<ReturnType<typeof handle.run>> | undefined;
    if (externallyAborted || preRunBlocked !== undefined || preRunStopped !== undefined) {
      status = "aborted";
      if (preRunBlocked !== undefined) {
        errorMessage = `input blocked by hook: ${preRunBlocked}`;
      } else if (preRunStopped !== undefined) {
        errorMessage = preRunStopped;
      }
    } else {
      run = await settleRun(
        options.continueFromHistory === true && handle.continueRun !== undefined
          ? await handle.continueRun()
          : await handle.run(task)
      );
    }
    if (!(externallyAborted || preRunBlocked !== undefined || preRunStopped !== undefined)) {
      if (run === undefined) {
        status = "aborted";
      } else {
        status =
          run.emptyReply === true
            ? "empty-reply"
            : run.status === "aborted" || drainInterrupted
              ? (limitHit ?? "aborted")
              : run.status;
        errorMessage = run.errorMessage;
        // 外部中止：这一步由调用方作废
        if (externallyAborted) {
          status = "aborted";
        }
      }
    }
    // 决策 323 / 324：Stop 钩子——收尾拦住要求接着干（理由作为新一轮输入），连续拦截到上限
    // （缺省 8，设置里 stopHookBlockCap 可改）后不再理会、照常结束，结束原因记 stop-hook-limit
    // 决策 324 复审：以出错收尾（failed）的 Run 不跑 Stop——它的通知是 StopFailure（下一段）
    if (
      hooks !== undefined &&
      run !== undefined &&
      !externallyAborted &&
      limitHit === undefined &&
      status !== "aborted" &&
      status !== "failed"
    ) {
      const stopCap = options.settings?.merged.stopHookBlockCap ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
      let stopHookActive = false;
      let blockedCount = 0;
      for (;;) {
        const report = await hooks.runEvent("Stop", "", {
          stop_hook_active: stopHookActive,
          last_assistant_message: handle.summary(),
        });
        // continue:false 压过拦截：整个会话停止处理，不再开新一轮（理由由钩子提示给出）
        if (report.continueFalse !== undefined) break;
        const wantsContinue = report.blocked !== undefined || report.additionalContext.length > 0;
        if (!wantsContinue) break;
        if (blockedCount >= stopCap) {
          // 到上限：这一次拦截不再理会，照常结束
          status = "stop-hook-limit";
          break;
        }
        blockedCount += 1;
        stopHookActive = true;
        const next = [
          ...report.additionalContext,
          ...(report.blocked !== undefined ? [report.blocked.reason] : []),
        ].join("\n\n");
        run = await settleRun(await handle.run(next));
        status =
          run.emptyReply === true
            ? "empty-reply"
            : run.status === "aborted" || drainInterrupted
              ? (limitHit ?? "aborted")
              : run.status;
        errorMessage = run.errorMessage;
        // 续跑这一轮出错或以中断收尾（含钩子 continue:false 停下）：循环停（出错的那一轮触发 StopFailure、
        // 不再触发 Stop；终态与理由如实记，不被 stop-hook-limit 盖掉）——与终端界面同口径
        if (run.status === "failed" || run.status === "aborted") {
          break;
        }
        if (externallyAborted) {
          status = "aborted";
          break;
        }
        if (limitHit !== undefined) {
          break;
        }
      }
    }
    // 决策 324：StopFailure——本 Run 以出错收尾时通知（无决策能力，只作副作用）
    if (hooks !== undefined && run !== undefined && run.status === "failed") {
      await hooks.runEvent("StopFailure", "", {
        error: run.errorMessage ?? "unknown",
        ...(run.errorMessage !== undefined ? { last_assistant_message: run.errorMessage } : {}),
      });
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    deadline = undefined;
    unsubscribe();
    options.abortSignal?.removeEventListener("abort", onAbort);
    // 决策 481：还在跑的子 agent 停下并释放（它们与主 agent 共用 MCP 连接）
    await agentRegistration?.unregister().catch(() => {});
    // 决策 323 / 324：SessionEnd——会话结束（只作副作用；缺省短时限 1.5 秒、单个钩子最长 60 秒）。
    // 在释放运行面之前跑：记录要落在本会话文件里
    if (liveBundle?.hooks !== undefined) {
      await liveBundle.hooks.runEvent("SessionEnd", "exit", { reason: "exit" });
    }
    await handle.dispose();
  }
  const sessionsDir = sessionsDirOf(options.governanceRoot);
  const outcome = readRunOutcome(sessionsDir, sessionId, toolTiers);
  const metrics = outcome.metrics;
  // 决策 409：本次运行结束时保留下来的作业，取自整次运行共用的作业池
  const keptJobs =
    liveBundle?.jobs?.pool.keptJobs().filter((job) => job.sessionId === sessionId) ?? [];
  return {
    sessionId,
    status,
    ...metrics,
    label: outcome.label,
    ...(status === "looping" && looping !== undefined ? { looping } : {}),
    durationMs: Date.now() - startedAt,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(keptJobs.length > 0 ? { keptJobs } : {}),
  };
}

// 一次运行的指标、标签与 Run 数：从会话存储现算；会话存储里没有这个会话（运行面没装起来、写者打不开）时为空指标
function readRunOutcome(
  sessionsDir: string,
  sessionId: SessionId,
  toolTiers: ReadonlyMap<string, string>
): { metrics: HeadlessRunMetrics; label: OutcomeLabel; runCount: number } {
  const loaded = loadStoreSession(sessionsDir, sessionId);
  if (loaded !== undefined) {
    const metrics = storeRunMetrics(loaded.view, { toolTiers });
    return {
      metrics,
      label:
        metrics.runId !== undefined ? storeAttemptLabel(loaded.view, metrics.runId) : "Unknown",
      runCount: loaded.view.runs.length,
    };
  }
  return {
    metrics: {
      failure: { category: "unknown" },
      turns: 0,
      toolCalls: 0,
      approvalsNeeded: 0,
      usage: structuredClone(ZERO_USAGE),
    },
    label: "Unknown",
    runCount: 0,
  };
}

const ZERO_USAGE: TurnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
