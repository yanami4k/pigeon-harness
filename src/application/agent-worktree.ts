// 子 agent 的临时工作树（决策 457、480）：派出时可选在临时工作树里干活，git 仓库里才有。起点是派出方工作目录此刻的快照
// （含未提交的改动），目录 .pigeon/trees/<名字>、分支 pigeon/<名字>（决策 494：与别的树同一种形状，名字撞了让路成 <名字>-2…；
// /worktrees 照样列出与清理），起点快照挂在 refs/pigeon/worker-start/<名字> 下随分支一并删。开着期间持有在用标记。
// 每次停下报告时有改动即附位置与分支；进程里关掉它时没有改动即删，有改动、干到一半被打断或别人还在用的保留。
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
  dropTreeRefs,
  mainRepoRoot,
  removeWorktreeAndBranch,
  worktreePristine,
  worktreeStartRefFor,
} from "../orchestration/worktree.ts";
import { holdWorktreeInUse, worktreeInUse } from "../persistence/worktree-in-use.ts";
import type { SessionId } from "../state/ids.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";
import { availableWorktreeName } from "./named-worktree.ts";
import { readTakeBase, unchangedSinceTake } from "./session-pool.ts";

export interface AgentWorktree {
  path: string;
  branch: string;
  // 起点提交
  base: string;
  repoRoot: string;
  release(): void;
  // 在用标记所在的主目录（测试注入；缺省用户主目录）
  homeDir?: string;
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
  // 派出方的工作目录（快照它）；树建在它所在仓库的主仓库根下（决策 494）
  parentWorkspace: string;
  sessionId: SessionId;
  name: string;
  homeDir?: string;
}): AgentWorktree {
  let repoRoot: string;
  try {
    repoRoot = mainRepoRoot(input.parentWorkspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 只在 git 明说不是仓库时这么写；别的失败（没装 git、safe.directory 拒绝等）照原样带出
    if (/not a git repository/i.test(message)) {
      throw new Error(
        `a worktree needs this session's project to be a git repository; ${input.parentWorkspace} is not in one`
      );
    }
    throw new Error(`a worktree can't be created here: ${message}`);
  }
  // 决策 494：程序起的名字撞了（上一棵同名的树还留着、别的会话的同名子 agent 在跑）就让路；起点引用与树同名
  const name = availableWorktreeName(repoRoot, worktreeSafeName(input.name));
  // 上一棵同名的树被人手删时留下的引用不接手
  dropTreeRefs(repoRoot, name);
  const startRef = worktreeStartRefFor(name);
  const snapshot = snapshotWorkdir({ repoRoot: input.parentWorkspace, ref: startRef });
  let handle: ReturnType<typeof addWorktree>;
  try {
    handle = addWorktree({
      repoRoot,
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
      ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
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
// 别人还持着它的在用标记（同名的树被 --worktree、enter_worktree 打开了）同样保留。返回保留与否
export function closeAgentWorktree(worktree: AgentWorktree, interrupted: boolean): boolean {
  worktree.release();
  if (interrupted) return true;
  if (
    worktreeInUse(
      worktree.path,
      worktree.homeDir !== undefined ? { homeDir: worktree.homeDir } : {}
    )
  ) {
    return true;
  }
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

// 决策 486、494：子 agent 的临时工作树（目录 .pigeon/trees/<名字>，分支 pigeon/<名字>；按派出时记下的工作目录找，不按子 agent
// 的名字反推，续接改了名、撞名让过路的也认）。
// 起点依次取：上次完整取回后前移的（钉在引用上，跨重启）、派出时记下的、起点快照引用（派出方当时有未提交改动才有）、
// 分支建立时那一条（引用日志里最早的）
export function agentWorktreeAt(input: {
  workspace: string | undefined;
  sessionId: string;
  // 派出时记下的起点（本进程派出的才有）
  base?: string | undefined;
}): AgentWorktreeLookup {
  const workspace = input.workspace;
  // 决策 494：工作树目录名就是它的名字（不再带会话号前缀），所以按"在自己的 pigeon/<名字> 分支上"认定
  if (workspace === undefined) return { ok: false, reason: "none" };
  const expected = `pigeon/${basename(workspace)}`;
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
  if (head !== expected) {
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
