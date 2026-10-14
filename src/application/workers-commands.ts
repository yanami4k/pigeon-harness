// worker 命令层（M5.5 S4，决策 040）：/spawn /cancel 的解析与收尾摘要。决策 301：/workers 的清单与原先的状态栏一行
// 由终端界面的编排面板取代（同一排版在 tui/worker-panel.ts）。纯函数，输出纯字符串（tui 投影到消息区与状态栏）；编排动作本身在 orchestration。
import type { WorkerOutcome, WorkerStartPoint, WorkerStatus } from "../orchestration/workers.ts";
import { skippedFilesText } from "../state/snapshot-config.ts";
import { plural } from "./format.ts";

export type {
  SpawnRequest,
  WorkerActivity,
  WorkerLifecycleEvent,
  WorkerOutcome,
  WorkerRef,
  WorkerStartPoint,
  WorkerStatus,
} from "../orchestration/workers.ts";
// 决策 301：进入 worker 会话补批时，人另附的话前面同样写这一句
// 权威链审计 ②：对续接后找回的之前运行的 worker 发取消、发消息、补批续做时的说明
export { previousRunWorkerText, resumeApprovalText } from "../orchestration/workers.ts";

// 续接后找回的之前运行的 worker 在状态里的标注（worker_status 与 /workers 共用）
export function previousRunNote(status: Pick<WorkerStatus, "previousRun">): string {
  return status.previousRun === "settled"
    ? " (from a previous run)"
    : status.previousRun === "interrupted"
      ? " (from a previous run, interrupted)"
      : "";
}

export class WorkerCommandError extends Error {}

export const SPAWN_USAGE =
  'usage: /spawn <explorer|implementer|tester> [--name <name> | --attempts <N>] "<task>"';

// 决策 279：/take <worker 名> 把已收尾 worker 自己的改动叠进工作目录
export const TAKE_USAGE = "usage: /take <worker|session>";

// raw = 去掉 "/spawn" 之后的原文；任务可带英文或中文引号，也可不带
export function parseSpawnCommand(raw: string): {
  role: string;
  task: string;
  name?: string;
  attempts?: number;
} {
  let rest = raw.trim();
  const roleMatch = /^(\S+)\s*/.exec(rest);
  const role = roleMatch?.[1];
  if (roleMatch === null || role === undefined || role.startsWith("--")) {
    throw new WorkerCommandError(SPAWN_USAGE);
  }
  rest = rest.slice(roleMatch[0].length);
  let name: string | undefined;
  let attempts: number | undefined;
  for (;;) {
    const nameMatch = /^--name\s+(\S+)\s*/.exec(rest);
    if (nameMatch !== null) {
      name = nameMatch[1];
      rest = rest.slice(nameMatch[0].length);
      continue;
    }
    // M7（决策 069）：并行派发同一任务的 N 个尝试（至少 2），共享任务标识
    const attemptsMatch = /^--attempts\s+(\S+)\s*/.exec(rest);
    if (attemptsMatch !== null) {
      const value = Number(attemptsMatch[1]);
      if (!Number.isInteger(value) || value < 2) {
        throw new WorkerCommandError(`--attempts needs an integer >= 2 (${SPAWN_USAGE})`);
      }
      attempts = value;
      rest = rest.slice(attemptsMatch[0].length);
      continue;
    }
    break;
  }
  if (attempts !== undefined && name !== undefined) {
    throw new WorkerCommandError(`--attempts can't be combined with --name (${SPAWN_USAGE})`);
  }
  let task = rest.trim();
  const quoted =
    (task.startsWith('"') && task.endsWith('"')) || (task.startsWith("“") && task.endsWith("”"));
  if (task.length >= 2 && quoted) {
    task = task.slice(1, -1).trim();
  }
  if (task === "") {
    throw new WorkerCommandError(SPAWN_USAGE);
  }
  return {
    role,
    task,
    ...(name !== undefined ? { name } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
  };
}

const STATE_LABEL: Record<string, string> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  aborted: "aborted",
  cancelled: "cancelled",
  "turn-limit": "turn limit",
  "wall-clock-limit": "time limit",
  "token-limit": "token limit",
  "spawn-failed": "spawn failed",
  // 决策 298
  stalled: "stalled",
};

export function workerStateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

// 收尾摘要：结构化结果的人读投影；合并由人用 git 完成，Pigeon 不自动合并
export function renderWorkerOutcome(outcome: WorkerOutcome): string {
  const lines = [
    `== worker ${outcome.name} (${outcome.role}) finished: ${workerStateLabel(outcome.status)} | ` +
      `${plural(outcome.turns, "turn")} | session ${outcome.sessionId} ==`,
  ];
  if (outcome.error !== undefined) {
    lines.push(`  reason: ${outcome.error}`);
  }
  const result = outcome.result;
  if (result !== undefined) {
    const files = result.changedFiles ?? [];
    lines.push(
      result.branch !== undefined
        ? `  branch ${result.branch} | ${plural(files.length, "file")} changed${files.length > 0 ? `: ${files.join(", ")}` : ""}`
        : "  read-only, no changes"
    );
    if (result.summary !== "") {
      lines.push(`  summary: ${result.summary}${result.summaryTruncated ? " (truncated)" : ""}`);
    }
  }
  // 只留事实：工作树在哪、没有改动时已删（决策 448）；只读的 explorer 不建工作树（决策 377）
  if (outcome.worktreeRemoved === "unchanged") {
    lines.push("  no changes; worktree and branch removed");
  } else if (outcome.workspace.kind === "git-worktree") {
    lines.push(`  worktree ${outcome.workspace.path}`);
  } else if (outcome.workspace.kind === "shared") {
    lines.push(`  read-only ${outcome.workspace.path}`);
  }
  // 决策 381：worker 新建却因过大不会进交回的树的文件
  if (result?.skippedFiles !== undefined && result.skippedFiles.length > 0) {
    lines.push(
      `  large files skipped (${result.skippedFiles.length}): ${skippedFilesText(result.skippedFiles)}`
    );
  }
  // 决策 279：起点快照与只取其自身改动的取用方式（与 spawn_worker 返回的那一行同一口径，取用入口为 /take）
  if (
    outcome.start !== undefined &&
    outcome.workspace.kind === "git-worktree" &&
    outcome.worktreeRemoved === undefined
  ) {
    lines.push(`  ${workerStartLine(outcome.start)}`);
  }
  return lines.join("\n");
}

// 决策 279：worker 起点的一行——快照起点写明带入了几个未提交的文件，HEAD 起点写明派出时没有未提交的文件
export function workerStartLine(start: WorkerStartPoint): string {
  const commit = start.commit.slice(0, 12);
  const origin = start.snapshot
    ? `base: snapshot ${commit} (${plural(start.files.length, "uncommitted file")})`
    : `base: commit ${commit} (no uncommitted files)`;
  return origin;
}

// /cancel 的目标：按 worker 名或会话 id 定位
export function resolveWorkerRef(workers: readonly WorkerStatus[], ref: string): WorkerStatus {
  const found = workers.find((worker) => worker.name === ref || worker.sessionId === ref);
  if (found === undefined) {
    throw new WorkerCommandError(`unknown worker: ${ref}`);
  }
  return found;
}

// M7（决策 069）：并行同任务派发的收尾摘要——各尝试的会话与状态（决策 322：不再贴标签，由人比较各份的改动与摘要）
export function renderAttemptGroupOutcome(result: {
  taskKey: string;
  outcomes: ReadonlyArray<{ sessionId: string; name: string; status: string }>;
}): string {
  return [
    `== parallel attempts finished | task ${result.taskKey} ==`,
    ...result.outcomes.map(
      (outcome) => `  session ${outcome.sessionId} | ${outcome.name} | ${outcome.status}`
    ),
  ].join("\n");
}
