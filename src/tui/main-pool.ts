// 会话面板的会话池（决策 443，进程内版）：派出的会话各开一个运行面（与主会话同一条装配路径），进自己的独立工作树（445、446：
// 起点缺省远端默认分支，名字为"面板里的名字-会话号末六位"），审批汇到主会话的同一队列并写明来源会话；停下即释放运行面，
// 工作树没有改动即删、有改动保留（不问）。会话面板派出的会话不带派 worker 的工具（worker 属于派出它的会话）。

import { summarizeArgs } from "../application/format.ts";
import type { LaunchFlags } from "../application/launch-flags.ts";
import { closeNamedWorktree, openNamedWorktree } from "../application/named-worktree.ts";
import { disposeRuntime, type MemoryWriteConfig } from "../application/runtime.ts";
import {
  LocalSessionPool,
  type PooledRuntime,
  takePooledChanges,
} from "../application/session-pool.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import type { WarnSink } from "../application/warnings.ts";
import type { WebToolsConfig } from "../application/web-tools.ts";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalHandler } from "../approvals/handler.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { newSessionId } from "../state/ids.ts";
import type { SettingsSnapshot } from "../state/settings.ts";
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
  // 工作树建立与清理的说明
  notice(line: string): void;
}

type PooledLive = Pick<TuiRuntimeFace, "subscribe" | "subscribeStream" | "subscribeToolResults">;

export function createSessionPool(context: SessionPoolContext): {
  pool: LocalSessionPool<PooledLive>;
  face: TuiPoolFace;
} {
  const pool = new LocalSessionPool<PooledLive>({
    open: async ({ name, hooks }) => {
      const sessionId = newSessionId();
      const worktree = openNamedWorktree({
        cwd: context.governanceRoot,
        name: `${name}-${sessionId.slice(-6).toLowerCase()}`,
        notice: context.notice,
      });
      const settings = context.settings();
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
        await closeNamedWorktree(worktree, { write: context.notice }).catch(() => "kept");
        throw error;
      }
      const bundle = opened.bundle;
      const adapter = bundle.adapter;
      const runtime: PooledRuntime<PooledLive> = {
        sessionId,
        worktree: { path: worktree.path, branch: worktree.branch },
        run: (text) => adapter.run(text),
        interrupt: () => {
          void adapter.interrupt();
        },
        isRunning: () => adapter.isRunning(),
        transcript: () => adapter.transcript(),
        close: async () => {
          await disposeRuntime(bundle).catch(() => {});
          await closeNamedWorktree(worktree, { write: context.notice }).catch(() => "kept");
        },
        live: {
          subscribe: (listener) => adapter.subscribe(listener),
          subscribeStream: (listener) => adapter.subscribeStream(listener),
          subscribeToolResults: (listener) => adapter.subscribeToolResults(listener),
        },
        take: () =>
          takePooledChanges({
            name,
            repoRoot: context.mainWorkspace(),
            base: worktree.base,
            worktreePath: worktree.path,
          }),
      };
      return runtime;
    },
  });
  return { pool, face: { source: pool, live: (id) => pool.runtimeOf(id)?.live } };
}
