// 独立工作树的在用锁（决策 445、446）：会话开在某个独立工作树里的期间，进程在用户级程序状态目录的 worktree-use/ 下持有一个
// 标记文件（按工作树路径的散列与进程号命名，内容记进程号与路径）。同一工作树可以有几个进程同时持有。退出时的清理与
// /worktrees clean 都先查"别的仍在的进程是否持有"，有即不删。进程崩溃留下的标记在查询时按进程已不在清掉。
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { userStateDir } from "../state/paths.ts";

// 信号 0 只探测不投递：ESRCH = 进程不在；EPERM = 在但无权限（按在算）
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 本进程持有的（工作树散列 → 持有次数）
const heldByThisProcess = new Map<string, number>();

function useDirOf(homeDir: string = homedir()): string {
  return join(userStateDir(homeDir), "worktree-use");
}

function keyOf(path: string): string {
  const normalized = resolve(path);
  return createHash("sha256")
    .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
    .digest("hex")
    .slice(0, 24);
}

// 持有：返回幂等的释放函数
export function holdWorktreeInUse(path: string, homeDir?: string): () => void {
  const dir = useDirOf(homeDir);
  mkdirSync(dir, { recursive: true });
  const key = keyOf(path);
  const file = join(dir, `${key}-${process.pid}.lock`);
  heldByThisProcess.set(key, (heldByThisProcess.get(key) ?? 0) + 1);
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, path: resolve(path) })}\n`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (heldByThisProcess.get(key) ?? 1) - 1;
    if (count > 0) {
      heldByThisProcess.set(key, count);
      return;
    }
    heldByThisProcess.delete(key);
    rmSync(file, { force: true });
  };
}

// 决策 484：本进程里还有会话持有这个工作树（同一进程里几个会话可以在同一个工作树里）
export function worktreeHeldHere(path: string): boolean {
  return (heldByThisProcess.get(keyOf(path)) ?? 0) > 0;
}

// 别的仍在的进程持有这个工作树（本进程的不算）；进程已不在的标记顺手删掉
export function worktreeInUseByOthers(
  path: string,
  options: { homeDir?: string; alive?: (pid: number) => boolean } = {}
): boolean {
  const dir = useDirOf(options.homeDir);
  const prefix = `${keyOf(path)}-`;
  const alive = options.alive ?? processAlive;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  let held = false;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".lock")) continue;
    const file = join(dir, name);
    let pid: number | undefined;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      pid = typeof value.pid === "number" ? value.pid : undefined;
    } catch {
      pid = undefined;
    }
    if (pid === undefined || !alive(pid)) {
      rmSync(file, { force: true });
      continue;
    }
    if (pid !== process.pid) held = true;
  }
  return held;
}

// 有仍在的进程持有这个工作树（含本进程）：/worktrees 列出时按它判在用
export function worktreeInUse(
  path: string,
  options: { homeDir?: string; alive?: (pid: number) => boolean } = {}
): boolean {
  return worktreeInUseByOthers(path, options) || heldByThisProcess.has(keyOf(path));
}
