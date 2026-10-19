// 会话运行面的工作区（M5.5 S4，决策 040；决策 457 起不再有 worker 会话）：续接与续跑要回到会话自己的工作区——分支会话回到
// 它的工作树，开在独立工作树里的会话回到那个工作树，其余即治理根。只读。
// 从会话存储读（决策 177 / 180）：分支会话的来历在会话文件头（metadata）；会话存储里没有这个会话的文件即按主会话处理（新会话
// 尚未写出文件）。
import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { treesDirFor } from "../orchestration/worktree.ts";
import type { StoredEntry } from "../persistence/session-reader.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import type { SessionId } from "../state/ids.ts";
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
    return { workspaceRoot: existingWorktree(branch.workspace) };
  }
  return {
    workspaceRoot: mainSessionWorkspace(governanceRoot, loaded.file.header.cwd, loaded.main),
  };
}

// 决策 445、446、494：会话开在工作树（.pigeon/worktrees/<名字>）里时，续接回到那里——主分支上最后一条 pigeon.worktree 条目
//（enter_worktree 移进去的）优先，其次会话文件头记的工作目录（pigeon --worktree、/clear 开的）；工作树已不在即回到治理根
//（主检出），不报错
function mainSessionWorkspace(
  governanceRoot: string,
  cwd: string,
  entries: readonly StoredEntry[]
): string {
  // 决策 494：项目开在仓库子目录里时，工作树照样在主仓库根的 .pigeon/worktrees 下（用到时才问 git）
  let dir: string | undefined;
  const usable = (path: string): boolean => {
    if (path === governanceRoot || !existsSync(path)) return false;
    dir ??= treesDirFor(governanceRoot);
    const rel = relative(dir, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SessionEntryType.Worktree) continue;
    const path = (entry.data as { path?: unknown } | undefined)?.path;
    if (typeof path === "string") return usable(path) ? path : governanceRoot;
  }
  return usable(cwd) ? cwd : governanceRoot;
}

// 分支会话（/fork）的工作树：不在了即响亮失败
function existingWorktree(workspace: { path: string; branch: string }): string {
  const located = workspace.path;
  if (!existsSync(located)) {
    throw new Error(
      `branch worktree is gone: ${located} (branch ${workspace.branch} still exists)`
    );
  }
  return located;
}
