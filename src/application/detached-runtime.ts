// 无人值守的运行面（M6.5 S1，决策 056）：pigeon run 与分叉续跑用的装配内核——普通会话、无审批通道（prompt 档 fail-closed）。
// 治理根有 MCP 配置时启动是异步的，运行面在 run 时就绪：就绪前的订阅暂存、就绪后接上，就绪前中断即按中止收尾。
// 决策 286：会话存储告警的出口可由调用方给出（storeWarn）；不给即照旧写标准错误输出。
// 决策 365：一次运行正常结束后，本会话开过后台作业的，先等在跑的作业、把结束通知交给模型跑一轮，直到没有在跑的作业。
// 决策 457 起不再有 worker：原先与 worker 共用的装配内核只留无人值守这一种。
import type { BeforeCompaction, CompactionConfigInput } from "../pi-runtime/compaction.ts";
import type { PruneSeed } from "../pi-runtime/context-prune.ts";
import type { AgentMessage, RunResult, StreamFn } from "../pi-runtime/index.ts";
import type { SkillRoot } from "../skills/catalog.ts";
import type { AttemptBudget } from "../state/attempt-config.ts";
import type { EventEnvelope } from "../state/events.ts";
import type { SessionId } from "../state/ids.ts";
import type { LoopRound } from "../state/loop-guard.ts";
import type {
  RepetitionGuardSettings,
  TruncationContinuationSettings,
} from "../state/runaway-config.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import type { RunStopCause } from "../state/session-entries.ts";
import type { BranchHeaderInput } from "../state/session-payloads.ts";
import { mcpConfigOf, type SettingsSnapshot } from "../state/settings.ts";
import type { EditMode } from "../tools/edit-mode.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";
import { settleBackgroundJobs } from "./background-jobs.ts";
import { type McpSession, startMcpSession } from "./mcp.ts";
import {
  buildRuntime,
  disposeRuntime,
  type LearnedMemoryConfig,
  type RuntimeBundle,
  type RuntimeDeps,
} from "./runtime.ts";
import type { StatusHashes } from "./status-block.ts";
import type { StatusFacts } from "./status-sources.ts";
import type { WallClockBudget } from "./wall-clock-status.ts";
import type { WarnSink } from "./warnings.ts";
import type { WebToolsConfig } from "./web-tools.ts";

export type DetachedRunStatus = "completed" | "failed" | "aborted" | "unknown";

export interface DetachedRunResult {
  status: DetachedRunStatus;
  errorMessage?: string;
  runId?: RunResult["runId"];
  // 空回复异常结束（决策 170 ②；此时 status 为 failed）
  emptyReply?: boolean;
}

// 交给调用方的运行面句柄
export interface DetachedRuntimeHandle {
  run(task: string): Promise<DetachedRunResult>;
  // 撞上限时带上原因（决策 182：运行面据此把 Run 收尾的结束方式一次写全）；取消与外部中止不带
  interrupt(cause?: RunStopCause): Promise<void>;
  subscribe(listener: (event: EventEnvelope) => void): () => void;
  // 决策 305：整轮观察口（打转检测挂在这里）
  subscribeRounds(listener: (round: LoopRound & { runId: RunResult["runId"] }) => void): () => void;
  // 末条 assistant 正文
  summary(): string;
  // M7（决策 077 / 079）：从已有消息续跑（分叉续跑）
  continueRun(): Promise<DetachedRunResult>;
  // 决策 324：运行面就绪（MCP 启动可能异步）——第一条输入之前跑 SessionStart 等钩子用；装配失败即拒绝
  ready(): Promise<RuntimeBundle>;
  dispose(): Promise<void>;
}

export interface DetachedRuntimeRequest {
  sessionId: SessionId;
  governanceRoot: string;
  workspaceRoot: string;
  // 决策 098：执行端；缺省为 workspaceRoot 上的本地实现
  workspaceHost?: WorkspaceHost;
  streamFn: StreamFn;
  provider: string;
  modelId: string;
  yolo: boolean;
  thinkingLevel?: ThinkingLevel;
  homeDir?: string;
  persistThinking?: boolean;
  skillRoots?: readonly SkillRoot[];
  // 决策 330：读不读人写的说明（AGENTS.md）；缺省读
  agentsMd?: boolean;
  editMode?: EditMode;
  maxOutputTokens?: number;
  // 决策 367：撞上限续跑与流式重复检测（缺省取设置快照）
  truncationContinuation?: TruncationContinuationSettings;
  repetitionGuard?: RepetitionGuardSettings;
  // 决策 365：无人值守收尾等后台作业的总时限（缺省取设置快照；跑批器显式给出）
  jobCloseoutMs?: number;
  temperature?: number;
  taskDirective?: string;
  // 决策 193：能否检索历史会话（缺省开着）
  sessionSearch?: boolean;
  // 决策 188、218：上下文压缩的配置（缺省为产品缺省）
  compaction?: CompactionConfigInput;
  beforeCompaction?: BeforeCompaction;
  // 决策 191、217：推送记忆（在场即开着）
  learnedMemory?: LearnedMemoryConfig;
  startMcp?: () => Promise<McpSession>;
  // 决策 294 B1：任务清单
  taskList?: boolean;
  // 决策 287–291：联网工具的配置
  webTools?: WebToolsConfig;
  // M8（决策 087）：本次尝试的预算冻结进注入快照
  budget?: AttemptBudget;
  // 决策 418：墙钟预算对模型可见
  wallClock?: WallClockBudget;
  branchHeader?: BranchHeaderInput;
  initialMessages?: AgentMessage[];
  onBundle?: (bundle: RuntimeBundle) => void;
  // 决策 286：会话存储告警的出口；缺省标准错误输出
  storeWarn?: WarnSink;
  // 决策 325：本会话的设置快照（pigeon run 由入口读好给出；缺省为空快照）
  settings?: SettingsSnapshot;
  // 决策 354：入口给出的确知事实（沙箱档位、网络能否用），写进开工状态块的环境一节
  statusFacts?: StatusFacts;
  // 决策 363、430：分叉续跑沿用的系统提示、生成它时所用的模型与状态变化通道的起点（分支会话记录里最后发出的一份）
  systemPrompt?: string;
  systemPromptModel?: { provider: string; id: string };
  statusSent?: StatusHashes;
  // 决策 361：分叉续跑时上下文裁剪的起点（取自分支会话记录）
  pruneSeed?: PruneSeed;
}

export function createDetachedRuntime(request: DetachedRuntimeRequest): DetachedRuntimeHandle {
  const runtimeDeps: Omit<RuntimeDeps, "mcp"> = {
    ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
    streamFn: request.streamFn,
    workspaceRoot: request.workspaceRoot,
    ...(request.workspaceHost !== undefined ? { workspaceHost: request.workspaceHost } : {}),
    governanceRoot: request.governanceRoot,
    sessionId: request.sessionId,
    yolo: request.yolo,
    provider: request.provider,
    modelId: request.modelId,
    ...(request.homeDir !== undefined ? { homeDir: request.homeDir } : {}),
    ...(request.persistThinking !== undefined ? { persistThinking: request.persistThinking } : {}),
    ...(request.skillRoots !== undefined ? { skillRoots: request.skillRoots } : {}),
    ...(request.agentsMd !== undefined ? { agentsMd: request.agentsMd } : {}),
    ...(request.editMode !== undefined ? { editMode: request.editMode } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
    ...(request.truncationContinuation !== undefined
      ? { truncationContinuation: request.truncationContinuation }
      : {}),
    ...(request.repetitionGuard !== undefined ? { repetitionGuard: request.repetitionGuard } : {}),
    ...(request.jobCloseoutMs !== undefined ? { jobCloseoutMs: request.jobCloseoutMs } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.taskDirective !== undefined ? { taskDirective: request.taskDirective } : {}),
    ...(request.sessionSearch !== undefined ? { sessionSearch: request.sessionSearch } : {}),
    ...(request.compaction !== undefined ? { compaction: request.compaction } : {}),
    ...(request.beforeCompaction !== undefined
      ? { beforeCompaction: request.beforeCompaction }
      : {}),
    ...(request.learnedMemory !== undefined ? { learnedMemory: request.learnedMemory } : {}),
    ...(request.taskList === true ? { taskList: true } : {}),
    ...(request.webTools !== undefined ? { webTools: request.webTools } : {}),
    ...(request.budget !== undefined ? { budget: request.budget } : {}),
    ...(request.wallClock !== undefined ? { wallClock: request.wallClock } : {}),
    ...(request.initialMessages !== undefined ? { initialMessages: request.initialMessages } : {}),
    ...(request.storeWarn !== undefined ? { storeWarn: request.storeWarn } : {}),
    ...(request.settings !== undefined ? { settings: request.settings } : {}),
    ...(request.statusFacts !== undefined ? { statusFacts: request.statusFacts } : {}),
    ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    ...(request.systemPromptModel !== undefined
      ? { systemPromptModel: request.systemPromptModel }
      : {}),
    ...(request.statusSent !== undefined ? { statusSent: request.statusSent } : {}),
    ...(request.pruneSeed !== undefined ? { pruneSeed: request.pruneSeed } : {}),
    // 分支会话的来历只在新建会话文件时写进文件头（177）
    ...(request.branchHeader !== undefined
      ? { storeLineage: { branch: request.branchHeader } }
      : {}),
  };
  // MCP 配置取自设置快照（会话开始时已校验；不重读文件）
  const mcpConfig =
    request.settings !== undefined ? mcpConfigOf(request.settings) : { servers: [] };
  const startMcp =
    request.startMcp ??
    (mcpConfig.servers.length > 0
      ? () =>
          startMcpSession({
            governanceRoot: request.governanceRoot,
            workspaceRoot: request.workspaceRoot,
            config: mcpConfig,
          })
      : undefined);
  const open = (deps: RuntimeDeps): RuntimeBundle => {
    const bundle = buildRuntime(deps);
    request.onBundle?.(bundle);
    return bundle;
  };
  if (startMcp === undefined) {
    return handleOf(Promise.resolve(open(runtimeDeps)));
  }
  return handleOf(
    startMcp().then(async (mcp) => {
      try {
        return open({ ...runtimeDeps, mcp });
      } catch (error) {
        await mcp.close();
        throw error;
      }
    })
  );
}

function summaryOf(bundle: RuntimeBundle): string {
  const last = bundle.adapter.transcript().findLast((message) => message.role === "assistant");
  if (last === undefined || last.role !== "assistant") {
    return "";
  }
  return last.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

// 决策 365：一次运行正常结束后等在跑的后台作业、把结束通知交给模型跑一轮，直到没有在跑的作业（收尾总时限到即停掉余下的）；
// 运行面被中断即不再等
async function runSettlingJobs(
  bundle: RuntimeBundle,
  run: () => Promise<RunResult>,
  halted: () => boolean
): Promise<RunResult> {
  const first = await run();
  const jobs = bundle.jobs;
  if (jobs === undefined || first.status !== "completed" || jobs.list().length === 0 || halted()) {
    return first;
  }
  const { last } = await settleBackgroundJobs({
    jobs,
    target: {
      pendingNotices: () => bundle.adapter.pendingNotices(),
      runNotices: () => bundle.adapter.runNotices(),
      notify: (text) => bundle.adapter.notify(text),
    },
    stopped: halted,
    closeoutMs: bundle.jobCloseoutMs,
  });
  const result = last ?? first;
  // 等作业时被中断（墙钟、上限、外部中止）：按中止交回（决策 409：保留的作业不等，不算）
  return halted() && jobs.toSettle().length > 0 ? { ...result, status: "aborted" } : result;
}

// 运行面就绪前后同一个句柄：装配失败经 run 与 ready 上抛；dispose 等就绪后释放
function handleOf(ready: Promise<RuntimeBundle>): DetachedRuntimeHandle {
  let bundle: RuntimeBundle | undefined;
  let interruptedEarly = false;
  let halted = false;
  // 就绪前订阅的监听器 → 就绪后的退订函数
  const early = new Map<(event: EventEnvelope) => void, () => void>();
  const earlyObservers = new Map<(adapter: RuntimeBundle["adapter"]) => () => void, () => void>();
  const settled = ready.then((value) => {
    bundle = value;
    for (const listener of early.keys()) {
      early.set(listener, value.adapter.subscribe(listener));
    }
    for (const attach of earlyObservers.keys()) {
      earlyObservers.set(attach, attach(value.adapter));
    }
    return value;
  });
  const observeWhenReady = (attach: (adapter: RuntimeBundle["adapter"]) => () => void) => {
    if (bundle !== undefined) {
      return attach(bundle.adapter);
    }
    earlyObservers.set(attach, () => {});
    return () => {
      const unsubscribe = earlyObservers.get(attach);
      earlyObservers.delete(attach);
      unsubscribe?.();
    };
  };
  // 拒绝由 run / ready / dispose 观察；此处只防未处理拒绝
  settled.catch(() => {});
  return {
    run: async (task) => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      halted = false;
      current.jobs?.beginRun();
      return runSettlingJobs(
        current,
        () => current.adapter.run(task),
        () => halted
      );
    },
    ready: () => settled,
    interrupt: async (cause) => {
      if (bundle === undefined) {
        interruptedEarly = true;
        return;
      }
      halted = true;
      await bundle.adapter.interrupt(cause);
    },
    subscribe: (listener) => {
      if (bundle !== undefined) {
        return bundle.adapter.subscribe(listener);
      }
      early.set(listener, () => {});
      return () => {
        const unsubscribe = early.get(listener);
        early.delete(listener);
        unsubscribe?.();
      };
    },
    subscribeRounds: (listener) => observeWhenReady((adapter) => adapter.subscribeRounds(listener)),
    summary: () => (bundle !== undefined ? summaryOf(bundle) : ""),
    continueRun: async () => {
      const current = await settled;
      if (interruptedEarly) {
        return { status: "aborted" };
      }
      return current.adapter.continueRun();
    },
    dispose: async () => {
      const current = await settled.catch(() => undefined);
      if (current !== undefined) {
        await disposeRuntime(current);
      }
    },
  };
}
