// 会话面板的会话池（决策 443，进程内版）：派出的会话各开一个运行面（与主会话同一条装配路径），进自己的独立工作树（445、446：
// 起点按设置的 worktree.baseRef，缺省远端默认分支，取远端在后台进行、不卡界面；名字为"面板里的名字-会话号末六位"；开着期间
// 持有工作树的在用锁）。审批汇到主会话的同一队列并写明来源会话；与主会话一样挂打转检测、后台作业通知（空闲时叫醒）、
// 会话级钩子（SessionStart、UserPromptSubmit、SessionEnd）与 MCP 提示。停下即释放运行面，工作树没有改动即删、有改动保留
//（不问）。/take 完整取回之后：已停的会话删工作树与分支（同 448），还开着的把起点前移到取回时的样子。会话面板派出的会话
// 不带派 worker 的工具（worker 属于派出它的会话）。
import { realpathSync } from "node:fs";
import { summarizeArgs } from "../application/format.ts";
import type { LaunchFlags } from "../application/launch-flags.ts";
import { attachLoopGuard } from "../application/loop-guard.ts";
import {
  closeNamedWorktree,
  openNamedWorktree,
  prefetchWorktreeBase,
  removeNamedWorktree,
} from "../application/named-worktree.ts";
import { disposeRuntime, type MemoryWriteConfig } from "../application/runtime.ts";
import {
  advanceTakeBase,
  LocalSessionPool,
  type PooledRuntime,
  takePooledChanges,
} from "../application/session-pool.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import type { WarnSink } from "../application/warnings.ts";
import type { WebToolsConfig } from "../application/web-tools.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import { holdWorktreeInUse, worktreeInUseByOthers } from "../persistence/worktree-in-use.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import {
  loopGuardSettingsOf,
  type SettingsSnapshot,
  worktreeSectionOf,
} from "../state/settings.ts";
import { worktreeBaseModeOf } from "../state/worktree-config.ts";
import type { TuiPoolFace, TuiRuntimeFace } from "./shell.ts";

export interface SessionPoolContext {
  governanceRoot: string;
  streamFn: StreamFn;
  flags: LaunchFlags;
  // 派出时取主会话当前的设置快照
  settings(): SettingsSnapshot;
  warn: WarnSink;
  createApprovalHandler: (grants: SessionGrantStore) => ApprovalHandler;
  memoryWrite?: MemoryWriteConfig;
  webToolsFor?: (snapshot: SettingsSnapshot) => { webTools?: WebToolsConfig };
  // /take 取回到哪（主会话当前的工作区）
  mainWorkspace(): string;
  // 工作树建立与清理、钩子、MCP、打转与作业通知的说明（写明来源会话）
  notice(line: string): void;
  // 测试用：在用锁的家目录（缺省用户家目录）
  homeDir?: string;
}

type PooledLive = Pick<TuiRuntimeFace, "subscribe" | "subscribeStream" | "subscribeToolResults">;

// 两个路径是不是同一个目录（实际位置；有一个不在即不是）
function sameDir(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function createSessionPool(context: SessionPoolContext): {
  pool: LocalSessionPool<PooledLive>;
  face: TuiPoolFace;
} {
  const pool = new LocalSessionPool<PooledLive>({
    open: async ({ name, hooks }) => {
      const say = (line: string) => context.notice(`[${name}] ${line}`);
      const sessionId = newSessionId();
      const settings = context.settings();
      let baseMode = worktreeBaseModeOf(worktreeSectionOf(settings));
      // 取远端在后台进行（不卡界面）；取不到即从 HEAD 起
      if (baseMode === "fresh" && !(await prefetchWorktreeBase(context.governanceRoot))) {
        say("取远端默认分支失败，工作树从当前 HEAD 起");
        baseMode = "head";
      }
      const worktree = openNamedWorktree({
        cwd: context.governanceRoot,
        name: `${name}-${sessionId.slice(-6).toLowerCase()}`,
        baseMode,
        notice: say,
      });
      // 开着期间持有在用锁（/worktrees 与退出清理据此不删开着的）
      const releaseInUse = holdWorktreeInUse(worktree.path, context.homeDir);
      let opened: Awaited<ReturnType<typeof openSessionRuntime>>;
      try {
        opened = await openSessionRuntime({
          governanceRoot: context.governanceRoot,
          workspaceRoot: worktree.path,
          sessionId,
          settings,
          streamFn: context.streamFn,
          flags: context.flags,
          warn: context.warn,
          ...(context.memoryWrite !== undefined ? { memoryWrite: context.memoryWrite } : {}),
          ...(context.webToolsFor?.(settings) ?? {}),
          hooksNotice: say,
          onMcpNote: (note) => say(`[mcp] ${note}`),
          // 决策 443：审批汇到同一队列，写明来源会话；挂着时面板把它放进"等待回应"
          createApprovalHandler: (grants) => {
            const inner = context.createApprovalHandler(grants);
            return async (request) => {
              hooks.waiting(`${request.toolName} ${summarizeArgs(request.args)}`);
              try {
                return await inner({ ...request, sessionId, pooled: { name } });
              } finally {
                hooks.waiting(undefined);
              }
            };
          },
        });
      } catch (error) {
        releaseInUse();
        await closeNamedWorktree(worktree, { write: say }).catch(() => "kept");
        throw error;
      }
      const bundle = opened.bundle;
      const adapter = bundle.adapter;
      const sessionHooks = bundle.hooks;
      // 打转检测（同主会话的设置）：叫停即中断这一轮
      const detachLoopGuard = attachLoopGuard(adapter, loopGuardSettingsOf(settings), () => {
        say("打转检测叫停了这一轮");
        void adapter.interrupt("looping").catch(() => {});
      });
      // 后台作业结束：通知写明来源，空闲时叫醒它
      bundle.jobNotices?.bind({ wake: () => hooks.wake(), onNotice: (text) => say(text) });
      // SessionStart：补的上下文存起来当作第一条输入的前缀
      let startContexts: string[] = [];
      if (sessionHooks !== undefined && !sessionHooks.disabled) {
        try {
          const report = await sessionHooks.runEvent("SessionStart", "startup", {
            source: "startup",
          });
          for (const line of report.systemMessages) say(line);
          startContexts = [...report.additionalContext];
        } catch (error) {
          say(
            `钩子出错（SessionStart）：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      let base = worktree.base;
      let removed = false;
      const runtime: PooledRuntime<PooledLive> = {
        sessionId,
        worktree: { path: worktree.path, branch: worktree.branch },
        // UserPromptSubmit：拦下即这一轮失败并写明原因；补的上下文作前缀
        run: async (text) => {
          let input = text;
          if (sessionHooks !== undefined && !sessionHooks.disabled) {
            try {
              const report = await sessionHooks.runEvent("UserPromptSubmit", "", { prompt: text });
              for (const line of report.systemMessages) say(line);
              const blocked =
                report.blocked?.reason ??
                (report.continueFalse !== undefined
                  ? (report.continueFalse.stopReason ?? "钩子要求整个会话停止")
                  : undefined);
              if (blocked !== undefined) {
                return { status: "failed", errorMessage: `输入被钩子拦下：${blocked}` };
              }
              const contexts = [...startContexts, ...report.additionalContext];
              startContexts = [];
              if (contexts.length > 0) input = `${contexts.join("\n\n")}\n\n${text}`;
            } catch (error) {
              say(
                `钩子出错（UserPromptSubmit）：${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
          return adapter.run(input);
        },
        runNotices: () => adapter.runNotices(),
        interrupt: () => {
          void adapter.interrupt();
        },
        isRunning: () => adapter.isRunning(),
        transcript: () => adapter.transcript(),
        close: async () => {
          detachLoopGuard();
          if (sessionHooks !== undefined && !sessionHooks.disabled) {
            await sessionHooks.runEvent("SessionEnd", "exit", { reason: "exit" }).catch(() => {});
          }
          await disposeRuntime(bundle).catch(() => {});
          releaseInUse();
          if (!removed) await closeNamedWorktree(worktree, { write: say }).catch(() => "kept");
        },
        live: {
          subscribe: (listener) => adapter.subscribe(listener),
          subscribeStream: (listener) => adapter.subscribeStream(listener),
          subscribeToolResults: (listener) => adapter.subscribeToolResults(listener),
        },
        take: (state) => {
          if (removed) return `会话 ${name} 的工作树已删除，没有可取回的`;
          // 取回的落点就是这个工作树（主会话 /resume 过去、进了它的工作树）：自己叠自己，拒绝
          if (sameDir(context.mainWorkspace(), worktree.path)) {
            return `主会话现在就在会话 ${name} 的工作树里，没有可取回的（落点与来源是同一处）`;
          }
          const result = takePooledChanges({
            name,
            repoRoot: context.mainWorkspace(),
            base,
            worktreePath: worktree.path,
          });
          if (!result.complete) return result.text;
          if (state === "stopped") {
            // 别的进程或本进程的主会话开着这个工作树：保留
            if (
              worktreeInUseByOthers(
                worktree.path,
                context.homeDir !== undefined ? { homeDir: context.homeDir } : {}
              )
            ) {
              return `${result.text}\n工作树 ${worktree.name} 另有会话开着，保留不删`;
            }
            // 已停的会话完整取回：同 448，删工作树与分支
            try {
              removeNamedWorktree(worktree);
              removed = true;
              return `${result.text}\n已删除工作树 ${worktree.name} 与分支 ${worktree.branch}`;
            } catch (error) {
              return `${result.text}\n删除工作树失败：${error instanceof Error ? error.message : String(error)}`;
            }
          }
          // 还开着：起点前移到取回时的样子，下次只取之后的改动
          try {
            base = advanceTakeBase(worktree.path, worktree.name);
          } catch (error) {
            return `${result.text}\n起点没有前移（下次取回会与这次重复）：${error instanceof Error ? error.message : String(error)}`;
          }
          return result.text;
        },
      };
      return runtime;
    },
  });
  return { pool, face: { source: pool, live: (id) => pool.runtimeOf(id)?.live } };
}
