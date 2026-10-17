// 子 agent 的临时工作树（决策 457、480）：派出时可选在临时工作树里干活，git 仓库里才有。起点是派出方工作目录此刻的快照
// （含未提交的改动），目录与分支沿用 .pigeon/state/worktrees/<会话号>-<名字> 与 pigeon/<会话号后 8 位>-<名字> 的命名
//（/worktrees 照样列出与清理），起点快照挂在 refs/pigeon/worker-start/ 下随分支一并删。开着期间持有在用锁。
// 每次停下报告时有改动即附位置与分支；进程里关掉它时没有改动即删，有改动或干到一半被打断的保留。
// 决策 486：派出方可用 take_changes 把它的改动取回自己的工作目录（同 /take 的三方叠回）；完整取回之后再没有改动的同样算没有改动。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  deleteSnapshotRef,
  readSnapshotRef,
  snapshotWorkdir,
} from "../execution/workdir-snapshot.ts";
import {
  addWorktree,
  branchCreationCommit,
  branchTailFor,
  mainRepoRoot,
  removeWorktreeAndBranch,
  worktreePristine,
  worktreeStartRefFor,
} from "../orchestration/worktree.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import type { SessionId } from "../state/ids.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";
import { readTakeBase, unchangedSinceTake } from "./session-pool.ts";

export interface AgentWorktree {
  path: string;
  branch: string;
  // 起点提交
  base: string;
  repoRoot: string;
  release(): void;
}

// 名字转成工作树与分支能用的写法：小写字母、数字与连字符，字母或数字开头，至多 40 个字符
export function worktreeSafeName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return safe === "" ? "agent" : safe;
}

export function openAgentWorktree(input: {
  // 派出方的工作目录（快照它）
  parentWorkspace: string;
  governanceRoot: string;
  sessionId: SessionId;
  name: string;
  homeDir?: string;
}): AgentWorktree {
  let repoRoot: string;
  try {
    repoRoot = mainRepoRoot(input.parentWorkspace);
  } catch {
    throw new Error("a worktree needs a git repository");
  }
  const name = worktreeSafeName(input.name);
  const startRef = worktreeStartRefFor(branchTailFor(input.sessionId, name));
  const snapshot = snapshotWorkdir({ repoRoot: input.parentWorkspace, ref: startRef });
  let handle: ReturnType<typeof addWorktree>;
  try {
    handle = addWorktree({
      repoRoot,
      governanceRoot: input.governanceRoot,
      sessionId: input.sessionId,
      name,
      baseRef: snapshot.commit,
      includeSource: input.parentWorkspace,
    });
  } catch (error) {
    // 建不成：起点快照的引用不留
    try {
      deleteSnapshotRef(repoRoot, startRef);
    } catch {
      // 删不掉也无害：只是一个引用
    }
    throw error;
  }
  try {
    return {
      path: handle.path,
      branch: handle.branch,
      base: snapshot.commit,
      repoRoot,
      release: holdWorktreeInUse(handle.path, input.homeDir),
    };
  } catch (error) {
    try {
      removeWorktreeAndBranch({ repoRoot, path: handle.path, branch: handle.branch });
    } catch {
      // 删不掉的留给 /worktrees
    }
    throw error;
  }
}

export function agentWorktreeChanged(worktree: AgentWorktree): boolean {
  try {
    return !worktreePristine(worktree.path, worktree.base, worktree.branch);
  } catch {
    // 看不出来按有改动算（保留）
    return true;
  }
}

// 取回起点引用用的名字（分支名去掉 pigeon/）
function takeKeyOf(branch: string): string {
  return branch.replace(/^pigeon\//, "");
}

// 决策 486：完整取回之后再没有改动（取回的就是全部）
export function unchangedSinceLastTake(worktree: { path: string; branch: string }): boolean {
  const taken = readTakeBase(worktree.path, takeKeyOf(worktree.branch), "agent");
  return taken !== undefined && unchangedSinceTake(worktree.path, taken);
}

// 关掉：没有改动（或完整取回之后再没有改动，决策 486）且不是干到一半的即删（连同分支、起点引用与取回起点引用），否则保留；
// 返回保留与否
export function closeAgentWorktree(worktree: AgentWorktree, interrupted: boolean): boolean {
  worktree.release();
  if (interrupted) return true;
  if (agentWorktreeChanged(worktree) && !unchangedSinceLastTake(worktree)) return true;
  try {
    removeWorktreeAndBranch({
      repoRoot: worktree.repoRoot,
      path: worktree.path,
      branch: worktree.branch,
    });
    return false;
  } catch {
    return true;
  }
}

export type AgentWorktreeLookup =
  | { ok: true; path: string; base: string; key: string }
  // none：它没在自己的临时工作树里干活；gone：工作树没了；off-branch：工作树不在它的分支上；no-base：找不到起点
  | { ok: false; reason: "none" | "gone" | "off-branch" | "no-base"; head?: string };

// 决策 486：子 agent 的临时工作树（目录名 <会话号>-<名字>，分支 pigeon/<会话号后 8 位>-<名字>；不按名字反推，续接改了名的也认）。
// 起点依次取：上次完整取回后前移的（钉在引用上，跨重启）、派出时记下的、起点快照引用（派出方当时有未提交改动才有）、
// 分支建立时那一条（引用日志里最早的）
export function agentWorktreeAt(input: {
  workspace: string | undefined;
  sessionId: string;
  // 派出时记下的起点（本进程派出的才有）
  base?: string | undefined;
}): AgentWorktreeLookup {
  const workspace = input.workspace;
  if (workspace === undefined || !basename(workspace).startsWith(`${input.sessionId}-`)) {
    return { ok: false, reason: "none" };
  }
  if (!existsSync(workspace)) return { ok: false, reason: "gone" };
  let head = "";
  try {
    head = execFileSync(
      "git",
      [...hardenedGitArgs(workspace), "symbolic-ref", "--short", "-q", "HEAD"],
      { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    head = "";
  }
  const prefix = `pigeon/${input.sessionId.slice(-8).toLowerCase()}-`;
  if (!head.startsWith(prefix)) {
    return { ok: false, reason: "off-branch", head: head === "" ? "a detached HEAD" : head };
  }
  const key = takeKeyOf(head);
  let start: string | undefined;
  try {
    start = readSnapshotRef(workspace, worktreeStartRefFor(key));
  } catch {
    start = undefined;
  }
  const base =
    readTakeBase(workspace, key, "agent") ??
    input.base ??
    start ??
    branchCreationCommit(workspace, head);
  return base !== undefined
    ? { ok: true, path: workspace, base, key }
    : { ok: false, reason: "no-base" };
}
