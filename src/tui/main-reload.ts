// 终端界面主会话的 /reload 重建（决策 340）：按新快照在同一会话上重开运行面。任务清单开关、打转检测与联网工具按新快照重算，
// 有人对话入口的记忆写入照常带上（决策 331，重建后 update_memory 仍注册），/memory 的上限随新快照更新。
// 先建后换：重建失败时抛出，调用方的快照与旧运行面都不变（/memory 的上限也只在重建成功后才更新）。
// 从 main.ts 抽出，使 /reload 的实际装配路径可测。

import type { EnterWorktreeSlot } from "../application/enter-worktree-tool.ts";
import type { LaunchFlags } from "../application/launch-flags.ts";
import type { ApprovalModeCell, MemoryWriteConfig, RuntimeBundle } from "../application/runtime.ts";
import {
  type OpenedSessionRuntime,
  type OpenSessionRuntimeRequest,
  openSessionRuntime,
} from "../application/session-runtime.ts";
import type { StatusFacts } from "../application/status-sources.ts";
import type { AgentToolsHost } from "../application/subagents.ts";
import type { WebToolsConfig } from "../application/web-tools.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import type { SessionId } from "../state/ids.ts";
import type { LoopGuardSettings } from "../state/loop-guard-config.ts";
import type { MemoryLimits } from "../state/memory-config.ts";
import {
  loopGuardSettingsOf,
  memoryLimitsOf,
  type SettingsSnapshot,
  taskListEnabledOf,
} from "../state/settings.ts";
import type { WorkspaceHost } from "../tools/workspace-host.ts";

// 重建所需的、跨快照不变的部分（入口在开局时备好）
export interface MainReloadContext {
  // 决策 469：主会话的审批模式单元（重建沿用，切换过的模式不丢）
  approvalModeCell?: ApprovalModeCell;
  governanceRoot: string;
  // 决策 445、446：主会话的工作区根（独立工作树）；缺省按会话推导
  workspaceRoot?: string | undefined;
  // 决策 446：enter_worktree 的工具槽（重建的运行面照常注册）
  enterWorktree?: EnterWorktreeSlot;
  streamFn: StreamFn;
  flags: LaunchFlags;
  workspaceHost?: WorkspaceHost;
  // 决策 354：沙箱会话的确知事实（开工状态块环境一节）
  statusFacts?: StatusFacts;
  warn: (line: string) => void;
  // 决策 562：给人看的次要提示（档位回落说明）的出口；不注入时同 warn
  notice?: (line: string) => void;
  createApprovalHandler: NonNullable<OpenSessionRuntimeRequest["createApprovalHandler"]>;
  // 决策 331：有人对话的入口带记忆写入
  memoryWrite: MemoryWriteConfig;
  // 决策 331、332：/memory 的上下文（上限随新快照更新）
  memoryContext: { limits: MemoryLimits };
  // 决策 287–291：联网工具按快照取
  webToolsFor: (snapshot: SettingsSnapshot) => { webTools?: WebToolsConfig };
  hooksNotice: (line: string) => void;
  onMcpNote: (note: string) => void;
  // 决策 457、480：当前会话在通讯录里的工具接口（重建的运行面照常注册四件工具；/resume 换会话时换成新的）
  agents?: AgentToolsHost;
  // 测试注入：用户级目录与 MCP 启动
  homeDir?: string;
  startMcp?: OpenSessionRuntimeRequest["startMcp"];
}

export interface MainReloaded {
  opened: OpenedSessionRuntime;
  loopGuard: LoopGuardSettings;
  webTools: { webTools?: WebToolsConfig };
}

export async function reopenMainSessionForReload(
  context: MainReloadContext,
  snapshot: SettingsSnapshot,
  current: { sessionId: SessionId; bundle: RuntimeBundle }
): Promise<MainReloaded> {
  const loopGuard = loopGuardSettingsOf(snapshot);
  const webTools = context.webToolsFor(snapshot);
  await current.bundle.sessionStore.flush();
  const opened = await openSessionRuntime({
    governanceRoot: context.governanceRoot,
    ...(context.approvalModeCell !== undefined
      ? { approvalModeCell: context.approvalModeCell }
      : {}),
    turnSnapshots: true,
    ...(context.workspaceRoot !== undefined ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(context.enterWorktree !== undefined ? { enterWorktree: context.enterWorktree } : {}),
    settings: snapshot,
    sessionId: current.sessionId,
    streamFn: context.streamFn,
    flags: context.flags,
    ...(context.workspaceHost !== undefined ? { workspaceHost: context.workspaceHost } : {}),
    ...(context.statusFacts !== undefined ? { statusFacts: context.statusFacts } : {}),
    taskList: taskListEnabledOf(snapshot),
    ...webTools,
    warn: context.warn,
    ...(context.notice !== undefined ? { notice: context.notice } : {}),
    loopGuard,
    createApprovalHandler: context.createApprovalHandler,
    // 决策 331：/reload 重建的运行面照常注册 update_memory
    memoryWrite: context.memoryWrite,
    ...(context.agents !== undefined ? { agents: context.agents } : {}),
    resume: true,
    reloadFrom: current.bundle,
    hooksNotice: context.hooksNotice,
    onMcpNote: context.onMcpNote,
    ...(context.homeDir !== undefined ? { homeDir: context.homeDir } : {}),
    ...(context.startMcp !== undefined ? { startMcp: context.startMcp } : {}),
  });
  // /memory 的上限按新快照更新（重建成功之后）
  context.memoryContext.limits = memoryLimitsOf(snapshot);
  return { opened, loopGuard, webTools };
}
