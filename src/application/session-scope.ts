// 会话运行面的工作区（M5.5 S4，决策 040；决策 457 起不再有 worker 会话）：续接与续跑要回到会话自己的工作区——分支会话回到
// 它的工作树，开在独立工作树里的会话回到那个工作树，其余即治理根。只读。
// 从会话存储读（决策 177 / 180）：分支会话的来历在会话文件头（metadata）；会话存储里没有这个会话的文件即按主会话处理（新会话
// 尚未写出文件）。旧会话里 worker 的会话文件头不再认（决策 477），按普通会话处理：文件头记的工作目录是 .pigeon/state/worktrees
// 下的工作树且还在时回到那里，不在即回到治理根。
import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { StoredEntry } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { SessionId } from "../state/ids.ts";
import { mapLegacyWorktreePath, namedWorktreesDirOf, worktreesDirOf } from "../state/paths.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { sessionsDirOf } from "./workspace.ts";

export interface SessionRuntimeScope {
  workspaceRoot: string;
}

export function sessionRuntimeScope(
  governanceRoot: string,
  sessionId: SessionId
): SessionRuntimeScope {
  const dir = sessionsDirOf(governanceRoot);
  const loaded = loadStoreSession(dir, sessionId);
  if (loaded === undefined) {
    return { workspaceRoot: governanceRoot };
  }
  const { view } = loaded;
  // M7（决策 077）：分支会话回到它自己的工作树
  const branch = view.metadata?.branch;
  if (branch !== undefined) {
    return { workspaceRoot: existingWorktree(governanceRoot, branch.workspace) };
  }
  return {
    workspaceRoot: mainSessionWorkspace(governanceRoot, loaded.file.header.cwd, loaded.main),
  };
}

// 决策 445、446：会话开在独立工作树（.pigeon/wt/<名字>）里时，续接回到那里——主分支上最后一条 pigeon.worktree 条目
//（enter_worktree 移进去的）优先，其次会话文件头记的工作目录（pigeon --worktree 开的；旧会话里的 worker 在 .pigeon/state/worktrees
// 下）；工作树已不在即回到治理根（主检出），不报错
function mainSessionWorkspace(
  governanceRoot: string,
  cwd: string,
  entries: readonly StoredEntry[]
): string {
  const dirs = [namedWorktreesDirOf(governanceRoot), worktreesDirOf(governanceRoot)];
  const usable = (path: string): boolean =>
    existsSync(path) &&
    dirs.some((dir) => {
      const rel = relative(dir, path);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    });
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SessionEntryType.Worktree) continue;
    const path = (entry.data as { path?: unknown } | undefined)?.path;
    if (typeof path === "string") return usable(path) ? path : governanceRoot;
  }
  return usable(cwd) ? cwd : governanceRoot;
}

// 决策 325：工作树移入 .pigeon/state/worktrees 之前的会话记着旧位置的绝对路径，按旧前缀到新前缀映射后再找
function existingWorktree(
  governanceRoot: string,
  workspace: { path: string; branch: string }
): string {
  const located = mapLegacyWorktreePath(governanceRoot, workspace.path);
  if (!existsSync(located)) {
    throw new Error(
      `branch worktree is gone: ${located} (branch ${workspace.branch} still exists)`
    );
  }
  return located;
}
