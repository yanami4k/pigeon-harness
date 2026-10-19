// 会话面板的会话池（决策 443，进程内版）：派出的会话各开一个运行面（与当前会话同一条装配路径），进自己的独立工作树（445、446：
// 起点按设置的 worktree.baseRef，缺省远端默认分支，取远端在后台进行、不卡界面；名字为"面板里的名字-会话号末六位"；开着期间
// 持有工作树的在用锁）。与当前会话一样挂打转检测、后台作业通知（空闲时叫醒）、会话级钩子（SessionStart、UserPromptSubmit、
// SessionEnd）与 MCP 提示。/take 完整取回之后起点前移到取回时的样子。
// 决策 483：停下只停这一轮（排着的主 agent 审批撤回，子 agent 接着跑）；从面板去掉才释放运行面，工作树没有改动（或完整取回
// 之后再没有改动）即删、有改动保留（不问）。决策 457、480：面板里的会话同样在通讯录里登记、能派子 agent（子 agent 的审批写明
// 所属会话与子 agent 的路径）；会话去掉时它派出的子 agent 一并停下。
// 决策 484（所有会话一样）：每个会话一个"会话核"（运行面、名字、审批模式、工作区与工作树、通讯录登记），当前会话与面板里的
// 会话是同一种；进入面板里的会话即与当前会话换手。要叫醒时找谁、打转检测挂在哪，按会话核此刻是不是当前会话走：当前会话
// 叫醒交给壳，面板里的交给会话池。审批一律带上所属会话（决策 509：只在它的视图里出现），面板里的卡片标等待回应。
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentTypeCatalog } from "../application/agent-types.ts";
import type { EnterWorktreeSlot } from "../application/enter-worktree-tool.ts";
import { summarizeArgs } from "../application/format.ts";
import type { LaunchFlags } from "../application/launch-flags.ts";
import { attachLoopGuard } from "../application/loop-guard.ts";
import {
  availableWorktreeName,
  type NamedWorktree,
  openNamedWorktree,
  prefetchWorktreeBase,
  reopenNamedWorktree,
  worktreeNameFrom,
} from "../application/named-worktree.ts";
import {
  type ApprovalModeCell,
  disposeRuntime,
  type MemoryWriteConfig,
  type RuntimeBundle,
} from "../application/runtime.ts";
import { defaultSessionName, validSessionName } from "../application/session-name.ts";
import {
  advanceTakeBase,
  LocalSessionPool,
  type PooledHooks,
  type PooledRuntime,
  type PooledSessionCard,
  readTakeBase,
  takePooledChanges,
} from "../application/session-pool.ts";
import { type OpenedSessionRuntime, openSessionRuntime } from "../application/session-runtime.ts";
import { agentMessageEntry } from "../application/session-store.ts";
import { createSubagentOpener } from "../application/subagent-runtime.ts";
import type { AgentHub, AgentToolsHost } from "../application/subagents.ts";
import type { WarnSink } from "../application/warnings.ts";
import type { WebToolsConfig } from "../application/web-tools.ts";
import { isGitWorkspace } from "../application/worktree-cleanup.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import {
  agentLimitsOfSettings,
  loopGuardSettingsOf,
  type SettingsSnapshot,
  worktreeSectionOf,
} from "../state/settings.ts";
import { worktreeBaseModeOf } from "../state/worktree-config.ts";
import type { ApprovalModeControl, TuiPoolFace, TuiRuntimeFace } from "./shell.ts";
import { tildePath } from "./welcome.ts";

export interface SessionPoolContext {
  governanceRoot: string;
  streamFn: StreamFn;
  flags: LaunchFlags;
  // 本进程当前的设置快照（/reload 后换新的）
  settings(): SettingsSnapshot;
  warn: WarnSink;
  createApprovalHandler: (grants: SessionGrantStore) => ApprovalHandler;
  memoryWrite?: MemoryWriteConfig;
  webToolsFor?: (snapshot: SettingsSnapshot) => { webTools?: WebToolsConfig };
  // /take 取回到哪（当前会话的工作区）
  mainWorkspace(): string;
  // 决策 469：派出时当前会话的审批模式（派出的会话各有自己的模式，从这里起）；缺省按启动参数
  approvalMode?(): "prompt" | "yolo";
  // 工作树建立与清理、钩子、MCP 与打转的说明（面板里的会话写明来源）；alert 为报错，醒目显示
  notice(line: string, alert?: boolean): void;
  // 测试用：在用锁的家目录（缺省用户家目录）
  homeDir?: string;
  // 决策 457、480：本进程的通讯录与子 agent 的类型；不给即不派子 agent。waiting：子 agent 在等审批（路径）
  agents?: {
    hub: AgentHub;
    // 某个项目的子 agent 类型（按治理根）
    catalog(governanceRoot: string): AgentTypeCatalog;
    waiting?(path: string, on: boolean): void;
  };
  // 决策 484：会话是当前会话时的去处——叫醒（壳跑待递通知）、重画、后台作业的结果行、打转检测挂到壳上
  current?: CurrentRoute;
  // 决策 485：面板里新派的会话开在哪个项目（当前会话所在的；缺省 governanceRoot 与 settings()）
  spawnTarget?(): { governanceRoot: string; settings?: SettingsSnapshot | undefined };
  // 当前会话所在项目的治理根（/take 不跨仓库）
  currentRoot?(): string;
  // 派出的会话开好时记进工作清单
  onListed?(core: SessionCore): void;
  // 从面板去掉：删出工作清单
  onUnlisted?(sessionId: string): void;
  // 决策 486、490：会话（caller）的主 agent 用 take_changes 取面板里的会话（按全量会话号）；面板里没有它返回 undefined
  panelTake?(caller: SessionCore, id: string, into: string): string | undefined;
}

export interface CurrentRoute {
  wake(): void;
  render?(): void;
  jobEnded?(line: string): void;
  guard(bundle: RuntimeBundle): () => void;
}

export type PooledLive = Pick<
  TuiRuntimeFace,
  "subscribe" | "subscribeStream" | "subscribeToolResults"
> & {
  // 决策 469：这个会话自己的审批模式
  approvalMode?: ApprovalModeControl | undefined;
  // 决策 484：它的会话核（进入时换成当前会话用）
  core: SessionCore;
};

// 决策 484：一个会话的会话核
export interface SessionCore {
  readonly sessionId: SessionId;
  // 决策 485：会话所属项目的治理根（会话记录、设置与记忆所在）与它的设置快照（缺省本进程的）
  governanceRoot: string;
  settings?: SettingsSnapshot | undefined;
  name: string;
  // 卡片上的那句话（派它时的、或它的首条输入）
  task: string;
  // 运行面（开好之前为 undefined；/reload 重建后换新的）
  opened?: OpenedSessionRuntime | undefined;
  modeCell: ApprovalModeCell;
  workspaceRoot: string;
  // 它自己的独立工作树（面板派出的、--worktree 或 enter_worktree 进去的），开着期间持有在用锁
  worktree?: NamedWorktree | undefined;
  releaseInUse?: (() => void) | undefined;
  sharedDir?: boolean;
  // /take 的起点（完整取回后前移）
  takeBase?: string | undefined;
  registration?: { host: AgentToolsHost; unregister(): Promise<void> } | undefined;
  // enter_worktree 的工具槽（从当前会话开的才有；面板派出的已在自己的工作树里）
  enterWorktree?: EnterWorktreeSlot | undefined;
  // 是不是当前会话
  current: boolean;
  // 在面板里时会话池给的钩子（审批挂上与落定、要叫醒）
  poolHooks?: PooledHooks | undefined;
  // 决策 483：主 agent 审批的撤回信号（面板里停下、去掉时撤回；开跑与成为当前会话时换新）
  approvals: AbortController;
  // 等 UserPromptSubmit 钩子期间被停下：这一轮不开跑
  interrupted?: boolean;
  // SessionStart 等补的上下文（随下一条输入一起交给模型）
  startContexts: string[];
  // 当前会话被中断时退回、还没放回输入框的排队内容（回到它时放进输入框）
  heldInput?: string[] | undefined;
  // 从当前会话交出来、还在等 UserPromptSubmit 钩子的那一轮：停下它（钩子之后不再开跑）
  cancelHandedOff?: (() => void) | undefined;
  // 决策 484：设置重读过、还没按新快照重建；已排着重建
  settingsStale?: boolean;
  reloadQueued?: boolean;
  // 打转检测的挂点（换角色时换）
  detachGuard?: (() => void) | undefined;
  closed?: boolean;
}

// 决策 485：会话用的设置快照（别的项目的会话用它自己项目的）
export function settingsOf(context: SessionPoolContext, core: SessionCore): SettingsSnapshot {
  return core.settings ?? context.settings();
}

export function coreBundle(core: SessionCore): RuntimeBundle {
  if (core.opened === undefined) throw new Error(`session ${core.name} isn't open yet`);
  return core.opened.bundle;
}

// 两个路径是不是同一个目录（实际位置；有一个不在即不是）
// （Windows 上不分大小写：同一目录的写法可能只差大小写）
function sameDir(left: string, right: string): boolean {
  try {
    const a = realpathSync.native(left);
    const b = realpathSync.native(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

// 说明行：当前会话的照写，面板里的写明来源
export function sayOf(context: SessionPoolContext, core: SessionCore) {
  return (line: string, alert = false): void => {
    // 还没起名（正在开）的同当前会话照写
    if (core.current || core.name === "") context.notice(line, alert);
    else context.notice(`[${core.name}] ${line}`, alert);
  };
}

// 要叫醒：当前会话交给壳，面板里的交给会话池
function wakeCore(context: SessionPoolContext, core: SessionCore): void {
  if (core.current) context.current?.wake();
  else core.poolHooks?.wake();
}

// 挂上一条在等的审批：面板里的卡片标等待回应；返回落定时调用的函数
function markWaiting(core: SessionCore, text: string): () => void {
  if (core.current) return () => {};
  return core.poolHooks?.waiting(text) ?? (() => {});
}

// 决策 443、483、484、509：主 agent 的审批 handler——带上所属会话（审批只在它的视图里出现）；面板里的卡片标等待回应。
// 都带上撤回信号（面板里停下、去掉即撤回）
export function coreApprovalHandler(
  context: SessionPoolContext,
  core: SessionCore
): (grants: SessionGrantStore) => ApprovalHandler {
  return (grants) => {
    const inner = context.createApprovalHandler(grants);
    return async (request) => {
      const signal =
        request.signal !== undefined
          ? AbortSignal.any([request.signal, core.approvals.signal])
          : core.approvals.signal;
      // 决策 509：审批带上所属会话——只在它的视图里出现，不在别的会话里弹出
      if (core.current) return inner({ ...request, sessionId: core.sessionId, signal });
      const settled = markWaiting(core, `${request.toolName} ${summarizeArgs(request.args)}`);
      try {
        return await inner({ ...request, sessionId: core.sessionId, signal });
      } finally {
        settled();
      }
    };
  };
}

// 决策 457、480、484：在通讯录里登记（运行面开好之前就登记：它的工具接口要交给运行面）
export function registerCoreAgents(
  context: SessionPoolContext,
  core: SessionCore
): AgentToolsHost | undefined {
  const agents = context.agents;
  if (agents === undefined) return undefined;
  const say = sayOf(context, core);
  const registration = agents.hub.registerSession({
    sessionId: core.sessionId,
    name: () => core.name,
    deliver: (text, mark) => {
      coreBundle(core).adapter.notify(text, mark);
      wakeCore(context, core);
    },
    pendingNotices: () => core.opened?.bundle.adapter.pendingNotices() ?? 0,
    record: (entry) => {
      const bundle = coreBundle(core);
      bundle.sessionStore.append(agentMessageEntry(entry, bundle.adapter.currentRunId()));
    },
    open: createSubagentOpener({
      governanceRoot: core.governanceRoot,
      streamFn: context.streamFn,
      flags: context.flags,
      warn: context.warn,
      topSessionId: () => core.sessionId,
      topSessionFile: () => coreBundle(core).sessionStore.filePath(),
      topContext: () => {
        const bundle = coreBundle(core);
        const settings = settingsOf(context, core);
        return {
          sessionId: core.sessionId,
          settings,
          approvalModeCell: core.modeCell,
          workspaceRoot: core.workspaceRoot,
          ...(bundle.mcp !== undefined ? { mcp: bundle.mcp } : {}),
          ...(context.webToolsFor?.(settings) ?? {}),
          grants: bundle.grantStore.list(),
          modelId: context.flags.modelId,
          transcript: () => bundle.adapter.transcript(),
        };
      },
      // 子 agent 的审批写明路径与所属会话；所属会话在面板里时卡片标等待回应
      createApprovalHandler: (grants, path) => {
        const inner = context.createApprovalHandler(grants);
        return async (request) => {
          const settled = markWaiting(
            core,
            `${path}: ${request.toolName} ${summarizeArgs(request.args)}`
          );
          agents.waiting?.(path, true);
          try {
            // 决策 509：带上所属会话（只在它的主代理视图与这个子 agent 的视图里出现）
            return await inner({ ...request, sessionId: core.sessionId, subagent: { path } });
          } finally {
            settled();
            agents.waiting?.(path, false);
          }
        };
      },
      notice: (path, line) => say(`[${path}] ${line}`, true),
      ...(context.homeDir !== undefined ? { homeDir: context.homeDir } : {}),
    }),
    catalog: () => agents.catalog(core.governanceRoot),
    // 决策 486：take_changes 的落点，与取面板里的会话
    workspaceRoot: () => core.workspaceRoot,
    ...(context.panelTake !== undefined
      ? {
          takeFromPanel: (id: string, into: string) => context.panelTake?.(core, id, into),
        }
      : {}),
    limits: () => agentLimitsOfSettings(settingsOf(context, core)),
  });
  core.registration = registration;
  return registration.host;
}

// 运行面开好（或重建）之后：后台作业结束按会话核此刻的角色叫醒，打转检测按角色挂上
export function attachCoreRuntime(context: SessionPoolContext, core: SessionCore): void {
  const bundle = coreBundle(core);
  // 后台作业的结束通知是给模型的，不显示（决策 460）；当前会话另在消息区写一行简短结果
  bundle.jobNotices?.bind({
    wake: () => wakeCore(context, core),
    onNotice: () => {
      if (core.current) context.current?.render?.();
    },
    onEnded: (line) => {
      if (core.current) context.current?.jobEnded?.(line);
    },
  });
  setCoreRole(context, core, core.current);
}

// 决策 484：换角色——打转检测换挂点（当前会话的挂到壳上；面板里的叫停即中断这一轮并写一行）。成为当前会话时审批的撤回信号换新
export function setCoreRole(
  context: SessionPoolContext,
  core: SessionCore,
  current: boolean
): void {
  core.current = current;
  if (current) {
    core.poolHooks = undefined;
    if (core.approvals.signal.aborted) core.approvals = new AbortController();
  }
  core.detachGuard?.();
  core.detachGuard = undefined;
  const bundle = core.opened?.bundle;
  if (bundle === undefined) return;
  if (current && context.current !== undefined) {
    core.detachGuard = context.current.guard(bundle);
    return;
  }
  const say = sayOf(context, core);
  const adapter = bundle.adapter;
  core.detachGuard = attachLoopGuard(
    adapter,
    loopGuardSettingsOf(settingsOf(context, core)),
    () => {
      say("loop detected; turn stopped");
      void adapter.interrupt("looping").catch(() => {});
    }
  );
}

// /take 完整取回后前移的起点：本进程记下的，没有即钉在引用上的（重启、从工作清单开起来的）
function takenBaseOf(core: SessionCore): string | undefined {
  const worktree = core.worktree;
  if (core.takeBase !== undefined || worktree === undefined) return core.takeBase;
  try {
    return readTakeBase(worktree.path, worktree.name, "panel");
  } catch {
    return undefined;
  }
}

// 决策 484：释放一个会话核（面板里去掉、关掉 Pigeon、/resume 换走闲着的当前会话）：注销通讯录（它派出的子 agent 一并停下）、
// 跑 SessionEnd、释放运行面与在用标记。决策 494：工作树与它的取回起点都不动（收尾交给 /worktrees clean，删树时一并删起点）
export async function closeCore(
  core: SessionCore,
  options: { reason: "exit" | "switch" }
): Promise<void> {
  if (core.closed === true) return;
  core.closed = true;
  core.approvals.abort();
  // 决策 480、483：会话释放时它派出的子 agent 一并停下并释放
  await core.registration?.unregister();
  core.detachGuard?.();
  core.detachGuard = undefined;
  const bundle = core.opened?.bundle;
  const sessionHooks = bundle?.hooks;
  if (sessionHooks !== undefined && !sessionHooks.disabled) {
    await sessionHooks
      .runEvent("SessionEnd", options.reason, { reason: options.reason })
      .catch(() => {});
  }
  if (bundle !== undefined) await disposeRuntime(bundle).catch(() => {});
  core.releaseInUse?.();
  core.releaseInUse = undefined;
}

// 决策 484：会话核在面板里时的运行面（派出的、与从当前会话退下来的同一份）
export function pooledRuntimeOf(
  context: SessionPoolContext,
  core: SessionCore
): PooledRuntime<PooledLive> {
  const say = sayOf(context, core);
  const alert = (line: string) => say(line, true);
  const bundleNow = () => coreBundle(core);
  // 开跑：撤回信号换新（上一轮停下时撤回过）
  const begin = () => {
    core.interrupted = false;
    if (core.approvals.signal.aborted) core.approvals = new AbortController();
  };
  return {
    sessionId: core.sessionId,
    // 决策 490：开好之后的缺省显示名
    name: () => core.name,
    ...(core.worktree !== undefined
      ? { worktree: { path: core.worktree.path, branch: core.worktree.branch } }
      : {}),
    attachHooks: (hooks) => {
      core.poolHooks = hooks;
    },
    // UserPromptSubmit：拦下即这一轮失败并写明原因；补的上下文作前缀
    run: async (text) => {
      begin();
      const bundle = bundleNow();
      const sessionHooks = bundle.hooks;
      let input = text;
      const contexts = core.startContexts.splice(0);
      if (sessionHooks !== undefined && !sessionHooks.disabled) {
        try {
          const report = await sessionHooks.runEvent("UserPromptSubmit", "", { prompt: text });
          for (const line of report.systemMessages) say(line);
          const blocked =
            report.blocked?.reason ??
            (report.continueFalse !== undefined
              ? (report.continueFalse.stopReason ?? "hook stopped the session")
              : undefined);
          if (blocked !== undefined) {
            core.startContexts.unshift(...contexts);
            return { status: "failed", errorMessage: `input blocked by hook: ${blocked}` };
          }
          contexts.push(...report.additionalContext);
        } catch (error) {
          alert(
            `UserPromptSubmit hook failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      if (contexts.length > 0) input = `${contexts.join("\n\n")}\n\n${text}`;
      // 等钩子期间被停下：这一轮不开跑
      if (core.interrupted === true) return { status: "interrupted" };
      return bundle.adapter.run(input);
    },
    runNotices: () => {
      begin();
      return bundleNow().adapter.runNotices();
    },
    interrupt: () => {
      core.interrupted = true;
      core.cancelHandedOff?.();
      core.approvals.abort();
      void core.opened?.bundle.adapter.interrupt();
    },
    isRunning: () => core.opened?.bundle.adapter.isRunning() ?? false,
    transcript: () => core.opened?.bundle.adapter.transcript() ?? [],
    // 决策 485、494：关掉 Pigeon、从面板去掉都不动工作树；从面板去掉的先删出清单（决策 497：之后 /worktrees clean 才清得掉它）
    close: async (options) => {
      if (options?.removed === true) context.onUnlisted?.(core.sessionId);
      await closeCore(core, { reason: "exit" });
    },
    live: {
      subscribe: (listener) => bundleNow().adapter.subscribe(listener),
      subscribeStream: (listener) => bundleNow().adapter.subscribeStream(listener),
      subscribeToolResults: (listener) => bundleNow().adapter.subscribeToolResults(listener),
      get approvalMode() {
        return core.opened?.bundle.approvalMode;
      },
      core,
    },
    // 决策 490：/take 的候选只列取得成的（与下面 take 的拒绝条件同一组，按人用 /take 的落点）
    takeable: () => {
      const worktree = core.worktree;
      if (worktree === undefined) return false;
      const landingRoot = context.currentRoot?.();
      if (landingRoot !== undefined && !sameDir(landingRoot, core.governanceRoot)) return false;
      return !sameDir(context.mainWorkspace(), worktree.path);
    },
    take: (into) => {
      const worktree = core.worktree;
      // 决策 486：模型取（take_changes）的出错作工具错误交回
      const refuse = (text: string) => (into !== undefined ? `Error: ${text}` : text);
      // 决策 459：共用目录的会话没有工作树，改动已直接在目录里
      if (worktree === undefined) return refuse(`${core.name} has no worktree; nothing to take`);
      // 决策 485：别的仓库里的会话不取；决策 486：take_changes 取回到调用方自己的工作目录
      const landingRoot = into?.root ?? context.currentRoot?.();
      const landing = into?.workspace ?? context.mainWorkspace();
      if (landingRoot !== undefined && !sameDir(landingRoot, core.governanceRoot)) {
        return refuse(`${core.name} is in another repository; nothing to take`);
      }
      // 取回的落点就是这个工作树（进了它的工作树）：自己叠自己，拒绝
      if (sameDir(landing, worktree.path)) {
        return into !== undefined
          ? refuse(`you are working in ${core.name}'s worktree; nothing to take`)
          : `the current session is in ${core.name}'s worktree; nothing to take`;
      }
      // 起点：上次 /take 完整取回后前移的（钉在引用上，重启后照样认）
      const result = takePooledChanges({
        name: core.name,
        repoRoot: landing,
        base: takenBaseOf(core) ?? worktree.base,
        worktreePath: worktree.path,
        ...(into !== undefined ? { protectPigeon: true } : {}),
      });
      if (result.error === true) return refuse(result.text);
      // 决策 486：模型取回到别处时起点不前移（起点是给人的 /take 与去掉时的清理用的）
      if (!result.complete || into !== undefined) return result.text;
      // 起点前移到取回时的样子，下次只取之后的改动
      try {
        core.takeBase = advanceTakeBase(worktree.path, worktree.name);
      } catch (error) {
        return `${result.text}\nadvancing the base failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return result.text;
    },
  };
}

// 决策 486、490：会话的主 agent 用 take_changes 取面板里的会话——按全量会话号找（不按显示名），不取自己；在干活的、没开的、
// 别的仓库的不取。面板里没有这个会话返回 undefined（调用方再说明找不到）
export function takeFromPanel(input: {
  cards: readonly PooledSessionCard[];
  pool: LocalSessionPool<PooledLive>;
  caller: SessionCore;
  id: string;
  into: string;
}): string | undefined {
  const { id, caller, pool } = input;
  const card = input.cards.find((item) => item.id === id && item.id !== caller.sessionId);
  if (card === undefined) return undefined;
  if (card.state === "running" || card.state === "waiting" || card.state === "preparing") {
    return `Error: session ${id} is still working; take its changes after it finishes`;
  }
  const target = pool.runtimeOf(card.id)?.live?.core;
  if (target === undefined) return `Error: session ${id} isn't open`;
  if (!sameDir(target.governanceRoot, caller.governanceRoot)) {
    return `Error: ${id} is in another repository; nothing to take`;
  }
  return pool.takeInto(card.id, { workspace: input.into, root: caller.governanceRoot });
}

// 决策 445、446：会话核认领它的工作目录（项目根或某棵工作树，含其中的子目录）；在工作树里的期间持有它的在用标记。
// 决策 497：认领之后经 follow 让工作清单里那条跟着走（已在清单里的才改）
export function adoptCoreWorkspace(
  core: SessionCore,
  root: string,
  follow: (core: SessionCore) => void,
  homeDir?: string
): void {
  core.workspaceRoot = root;
  const next = sameDir(root, core.governanceRoot)
    ? undefined
    : (reopenNamedWorktree(core.governanceRoot, root) ?? core.worktree);
  if (next?.path !== core.worktree?.path || core.releaseInUse === undefined) {
    core.releaseInUse?.();
    core.releaseInUse = next !== undefined ? holdWorktreeInUse(next.path, homeDir) : undefined;
  }
  core.worktree = next;
  follow(core);
}

// 决策 446：会话移进工作树（enter_worktree，工作目录已换成它）：换持这棵树的在用标记；决策 497：工作清单里那条跟着走
export function adoptCoreWorktree(
  core: SessionCore,
  worktree: NamedWorktree,
  follow: (core: SessionCore) => void,
  homeDir?: string
): void {
  if (core.worktree?.path !== worktree.path) {
    core.releaseInUse?.();
    core.releaseInUse = holdWorktreeInUse(worktree.path, homeDir);
  }
  core.worktree = worktree;
  follow(core);
}

export function createSessionPool(context: SessionPoolContext): {
  pool: LocalSessionPool<PooledLive>;
  face: TuiPoolFace;
} {
  // 决策 459：不是 git 仓库时，面板派出的会话直接在当前目录里干活（不建工作树、与其他会话不隔离）
  // 决策 485：在当前会话所在的项目里派
  const target = () =>
    context.spawnTarget?.() ?? {
      governanceRoot: context.governanceRoot,
      settings: context.settings(),
    };
  const sharedDir = (): boolean => !isGitWorkspace(target().governanceRoot);
  // 决策 489：共用目录的会话在卡上写它用的工作区（`~` 缩写；与欢迎头、/resume 列表同一写法）
  const sharedWorkspace = (): string =>
    tildePath(target().governanceRoot, context.homeDir ?? homedir());
  const pool = new LocalSessionPool<PooledLive>({
    sharedDir,
    sharedWorkspace,
    displayPath: (path) => tildePath(path, context.homeDir ?? homedir()),
    open: async ({ task, hooks, sharedDir: shared }) => {
      const sessionId = newSessionId();
      const spawnedIn = target();
      // 决策 490：缺省显示名 = 工作目录名 + 会话号末 4 位（Claude Code 的"目录名 + 两字符后缀"同一路数）
      const displayName = defaultSessionName(spawnedIn.governanceRoot, sessionId);
      const governanceRoot = spawnedIn.governanceRoot;
      // 本进程启动的项目里的不带快照（用本进程的，/reload 换新的）
      const settings = spawnedIn.settings ?? context.settings();
      // 决策 469：这个会话自己的审批模式（从当前会话当时的起）；它派出的子 agent 共用
      const core: SessionCore = {
        sessionId,
        name: displayName,
        task,
        modeCell: {
          current: context.approvalMode?.() ?? (context.flags.yolo ? "yolo" : "prompt"),
        },
        governanceRoot,
        ...(spawnedIn.settings !== undefined ? { settings: spawnedIn.settings } : {}),
        workspaceRoot: governanceRoot,
        current: false,
        poolHooks: hooks,
        approvals: new AbortController(),
        startContexts: [],
        ...(shared === true ? { sharedDir: true } : {}),
      };
      const say = sayOf(context, core);
      const alert = (line: string) => say(line, true);
      if (shared !== true) {
        let baseMode = worktreeBaseModeOf(worktreeSectionOf(settings));
        // 取远端在后台进行（不卡界面）；取不到即从 HEAD 起
        if (baseMode === "fresh" && !(await prefetchWorktreeBase(governanceRoot))) {
          alert("fetching the remote default branch failed; worktree starts from HEAD");
          baseMode = "head";
        }
        // 决策 494：程序生成的名字撞了就让路（<名字>-2…），并在消息区说明用的是哪个名字
        const wanted = worktreeNameFrom(displayName);
        const worktreeName = availableWorktreeName(governanceRoot, wanted);
        const worktree = openNamedWorktree({
          cwd: governanceRoot,
          name: worktreeName,
          baseMode,
          notice: say,
        });
        if (worktreeName !== wanted) say(`worktree name ${wanted} is taken; using ${worktreeName}`);
        core.worktree = worktree;
        core.workspaceRoot = worktree.path;
        // 开着期间持有工作树的在用锁（/worktrees 与退出清理据此不删开着的）；共用目录的没有工作树
        core.releaseInUse = holdWorktreeInUse(worktree.path, context.homeDir);
      }
      const agentsHost = registerCoreAgents(context, core);
      try {
        core.opened = await openSessionRuntime({
          governanceRoot,
          approvalModeCell: core.modeCell,
          ...(agentsHost !== undefined ? { agents: agentsHost } : {}),
          // 共用目录的会话工作区就是当前目录（会话文件头记的工作目录即此，没有工作树）
          workspaceRoot: core.workspaceRoot,
          sessionId,
          settings,
          streamFn: context.streamFn,
          flags: context.flags,
          warn: context.warn,
          ...(context.memoryWrite !== undefined ? { memoryWrite: context.memoryWrite } : {}),
          ...(context.webToolsFor?.(settings) ?? {}),
          hooksNotice: alert,
          onMcpNote: (note) => alert(`[mcp] ${note}`),
          // 决策 443、484、509：审批带上所属会话（只在它的视图里出现）；在面板里时卡片标等待回应
          createApprovalHandler: coreApprovalHandler(context, core),
        });
      } catch (error) {
        await core.registration?.unregister();
        core.releaseInUse?.();

        throw error;
      }
      const bundle = core.opened.bundle;
      // 决策 456：面板会话的名字记进它自己的会话记录（续接与 /resume 列表照用）
      if (validSessionName(displayName)) bundle.sessionStore.setName(displayName);
      attachCoreRuntime(context, core);
      // 决策 485：在面板里新开的会话进工作清单
      context.onListed?.(core);
      // SessionStart：补的上下文存起来当作第一条输入的前缀
      const sessionHooks = bundle.hooks;
      if (sessionHooks !== undefined && !sessionHooks.disabled) {
        try {
          const report = await sessionHooks.runEvent("SessionStart", "startup", {
            source: "startup",
          });
          for (const line of report.systemMessages) say(line);
          core.startContexts.push(...report.additionalContext);
        } catch (error) {
          alert(
            `SessionStart hook failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return pooledRuntimeOf(context, core);
    },
  });
  return { pool, face: { source: pool } };
}
