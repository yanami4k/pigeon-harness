// 手动分叉命令层（M7 S6，决策 079）：终端界面主会话的 /fork。
// 用法：/fork [--at <条目号> | --at <Run 号前缀>:<条目号>] ["新输入"]
// - 缺省分叉点：最近一次 Run 的任务开始处（第一条人输入的消息，跳过开工状态块）；只给条目号时指最近一次 Run；Run 号可用唯一前缀（trace 里显示的短号）；
// - 分叉点末条是用户消息或工具结果时不给新输入直接续跑；末条是助手消息时必须给新输入；
// - 分支在独立工作树里续跑，跑完回报分支会话、工作树、终态与标签。
// 分叉点从会话存储定位；本会话在会话存储里没有文件时明确报错。
import { loadStoreSession } from "../persistence/session-view.ts";
import type { RunId } from "../state/ids.ts";
import { type StoreSessionView, storeMessageAt } from "../state/session-judge.ts";
import type { ForkPoint } from "../state/session-payloads.ts";
import { isStatusMessage } from "../state/status-text.ts";
import { ForkError, type ForkRunOptions, runForkBranch } from "./fork.ts";
import type { OpenedSessionRuntime } from "./session-runtime.ts";
import { sessionsDirOf } from "./workspace.ts";

export const FORK_USAGE = 'usage: /fork [--at <entry> | --at <run prefix>:<entry>] ["new input"]';

export class ForkCommandError extends Error {}

export interface ForkAt {
  runPrefix?: string;
  runSeq?: number;
}

export function parseForkCommand(raw: string): { at?: ForkAt; input?: string } {
  let rest = raw.trim();
  let at: ForkAt | undefined;
  const atMatch = /^--at\s+(\S+)\s*/.exec(rest);
  if (atMatch !== null) {
    const spec = atMatch[1] ?? "";
    const colon = spec.lastIndexOf(":");
    const runPrefix = colon >= 0 ? spec.slice(0, colon) : undefined;
    const runSeq = Number(colon >= 0 ? spec.slice(colon + 1) : spec);
    if (!Number.isInteger(runSeq) || runSeq < 1 || runPrefix === "") {
      throw new ForkCommandError(`--at needs <entry> or <run prefix>:<entry> (${FORK_USAGE})`);
    }
    at = { ...(runPrefix !== undefined ? { runPrefix } : {}), runSeq };
    rest = rest.slice(atMatch[0].length);
  } else if (rest.startsWith("--")) {
    throw new ForkCommandError(FORK_USAGE);
  }
  let input = rest.trim();
  const quoted =
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("“") && input.endsWith("”"));
  if (input.length >= 2 && quoted) {
    input = input.slice(1, -1).trim();
  }
  return { ...(at !== undefined ? { at } : {}), ...(input !== "" ? { input } : {}) };
}

// 任务开始处：Run 里第一条人输入的用户消息（决策 363：跳过排在前面的开工状态块）；找不到时为第 1 条
function taskSeqOf(session: StoreSessionView, runId: RunId): number {
  const messages = session.runs.find((run) => run.runId === runId)?.messages ?? [];
  const index = messages.findIndex(
    (ref) => ref.message.role === "user" && !isStatusMessage(ref.message)
  );
  return index >= 0 ? index + 1 : 1;
}

const NO_RUN_TO_FORK = "no runs in this session yet; nothing to fork";

// 分叉点定位：Run 顺序取会话里 Run 开始条目的先后
export function resolveForkPoint(session: StoreSessionView, at: ForkAt): ForkPoint {
  const runs: RunId[] = session.runs.map((run) => run.runId);
  let runId: RunId | undefined;
  if (at.runPrefix !== undefined) {
    const prefix = at.runPrefix;
    const matches = runs.filter((run) => run.startsWith(prefix));
    if (matches.length !== 1) {
      throw new ForkCommandError(
        matches.length === 0
          ? `no run starting with ${prefix} in this session`
          : `run prefix ${prefix} is ambiguous (${matches.length} matches)`
      );
    }
    runId = matches[0];
  } else {
    runId = runs.at(-1);
  }
  if (runId === undefined) {
    throw new ForkCommandError(NO_RUN_TO_FORK);
  }
  const runSeq = at.runSeq ?? taskSeqOf(session, runId);
  if (storeMessageAt(session, { runId, runSeq }) === undefined) {
    throw new ForkCommandError(`run has no entry ${runSeq}`);
  }
  return { runId, runSeq };
}

export async function runForkCommand(input: {
  governanceRoot: string;
  opened: OpenedSessionRuntime;
  args: string;
  run: ForkRunOptions;
}): Promise<string> {
  const { at, input: nextInput } = parseForkCommand(input.args);
  const sessionId = input.opened.bundle.adapter.sessionId;
  if (input.opened.bundle.adapter.isRunning()) {
    throw new ForkCommandError("can't fork while running");
  }
  // 决策 432：会话文件推迟建、还没建——本会话还没有对话
  if (input.opened.bundle.sessionStore.fileDeferred?.() === true) {
    throw new ForkCommandError(NO_RUN_TO_FORK);
  }
  // 本会话的写者先落盘，再从会话存储读
  await input.opened.bundle.sessionStore.flush();
  const loaded = loadStoreSession(sessionsDirOf(input.governanceRoot), sessionId);
  if (loaded === undefined) {
    throw new ForkError(`can't fork: session ${sessionId} has no file in the session store`);
  }
  const forkPoint = resolveForkPoint(loaded.view, at ?? {});
  const result = await runForkBranch({
    governanceRoot: input.governanceRoot,
    sourceSessionId: sessionId,
    sourceStore: input.opened.bundle.sessionStore,
    forkPoint,
    trigger: "manual",
    // 复用运行面已挂的快照器实例：同一会话只能有一个实例，否则两边各自算序号会写同一个 ref
    // 决策 350：分叉之前先等本会话未完成的快照拍完
    ...(input.opened.checkpoints !== undefined
      ? {
          checkpointer: input.opened.checkpoints.checkpointer,
          settleCheckpoints: input.opened.checkpoints.settle,
        }
      : {}),
    // 决策 325：分支沿用来源会话的设置快照
    run: {
      settings: input.opened.bundle.settings,
      ...input.run,
      ...(nextInput !== undefined ? { input: nextInput } : {}),
    },
  });
  return [
    `forked at ${forkPoint.runId} #${forkPoint.runSeq} | snapshot ${result.checkpoint.commit.slice(0, 12)}`,
    `  branch session ${result.branchSessionId} | worktree ${result.workspace.path} (branch ${result.workspace.branch})`,
    `  status ${result.status} | label ${result.label}`,
  ].join("\n");
}
