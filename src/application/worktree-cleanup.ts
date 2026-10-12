// 留下的工作树的列出与删除（决策 448）：终端界面的 /worktrees 与命令行的 pigeon worktrees list|clean 共用。
// 列出三类：.pigeon/state/worktrees/ 下 git 登记的工作树（worker、脚本编排、/fork 的）、没有工作树的 pigeon/ 分支（以前
// 留下的旧分支，或工作树目录被手删的）、该目录下 git 不认的残留目录。每项给所属会话（派出它的会话，读 worker 会话文件头）、
// 是否在用（worker 会话正被一个仍在的进程打开）、未取走的改动（worker 相对起点改过、内容又与主工作目录不同的文件数）与占用大小。
// 删除缺省只删没有未取走改动的；点名或 --all 才删有改动的，并明说会丢。在用的一律不删。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  branchCreationCommit,
  branchMovedSince,
  filesChangedSince,
  listBranches,
  listWorktrees,
  mainRepoRoot,
  pruneWorktrees,
  removeWorktreeAndBranch,
  WORKER_BRANCH_PREFIX,
} from "../orchestration/worktree.ts";
import { sessionFileHolder } from "../persistence/session-lock.ts";
import { locateSessionFile, readSessionHeader } from "../persistence/session-reader.ts";
import { sessionsDirOf, worktreesDirOf } from "../state/paths.ts";

// 工作目录在 git 仓库里（/worktrees 只在这时提供）
export function isGitWorkspace(workspaceRoot: string): boolean {
  try {
    mainRepoRoot(workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

export type LeftoverKind = "worktree" | "branch-only" | "orphan-dir";

export interface LeftoverWorktree {
  kind: LeftoverKind;
  // 显示用的名字：worker 名（目录名去掉会话号）、分支名或目录名
  name: string;
  // 工作树目录（只剩分支的没有）
  path?: string;
  branch?: string;
  // 目录名里的 worker 会话号
  workerSessionId?: string;
  // 派出它的会话（读不到 worker 会话文件时缺省）
  ownerSessionId?: string;
  // 决策 447 之前的命名（分支 pigeon/<名字>）
  legacy: boolean;
  // worker 会话正被一个仍在的进程打开（在跑）：不删
  inUse: boolean;
  // 未取走的改动：文件数；"commits" = 只剩分支且分支上有新提交（文件数不细算）；"unknown" = 算不出
  untaken: number | "commits" | "unknown";
  bytes: number;
}

export interface WorktreeScope {
  // 主工作目录（取主仓库根、比较未取走的改动都看它）
  workspaceRoot: string;
  // 治理根（.pigeon 所在）；缺省主仓库根
  governanceRoot?: string;
}

const WORKER_DIR = /^(sess_[0-9A-HJKMNP-TV-Z]{26})-(.+)$/;

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

// 目录占用（不跟随符号链接与目录联接）
export function directoryBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let names: string[] = [];
      try {
        names = readdirSync(current);
      } catch {
        continue;
      }
      for (const name of names) stack.push(join(current, name));
    } else {
      total += stat.size;
    }
  }
  return total;
}

function sameContent(a: string, b: string): boolean {
  const aExists = existsSync(a);
  const bExists = existsSync(b);
  if (!aExists || !bExists) return aExists === bExists;
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function untakenFiles(
  worktree: string,
  branch: string | undefined,
  head: string | undefined,
  root: string,
  repoRoot: string
): number | "unknown" {
  const base = (branch !== undefined ? branchCreationCommit(repoRoot, branch) : undefined) ?? head;
  if (base === undefined) return "unknown";
  try {
    return filesChangedSince(worktree, base).filter(
      (file) => !sameContent(join(worktree, file), join(root, file))
    ).length;
  } catch {
    return "unknown";
  }
}

function workerSessionFacts(
  governanceRoot: string,
  workerSessionId: string | undefined
): { ownerSessionId?: string; inUse: boolean } {
  if (workerSessionId === undefined) return { inUse: false };
  const file = locateSessionFile(sessionsDirOf(governanceRoot), workerSessionId);
  if (file === undefined) return { inUse: false };
  const header = readSessionHeader(file.path);
  return {
    ...(header?.parentSessionId !== undefined ? { ownerSessionId: header.parentSessionId } : {}),
    inUse: sessionFileHolder(file.path) !== undefined,
  };
}

export function listLeftoverWorktrees(scope: WorktreeScope): LeftoverWorktree[] {
  const repoRoot = mainRepoRoot(scope.workspaceRoot);
  const governanceRoot = scope.governanceRoot ?? repoRoot;
  const root = realOrResolved(scope.workspaceRoot);
  const stateDir = realOrResolved(worktreesDirOf(governanceRoot));
  const items: LeftoverWorktree[] = [];
  const seenPaths: string[] = [];
  const seenBranches = new Set<string>();
  for (const entry of listWorktrees(repoRoot)) {
    if (entry.branch !== undefined) seenBranches.add(entry.branch);
    const path = resolve(entry.path);
    const inStateDir =
      isInside(stateDir, path) ||
      (process.platform === "win32" && isInside(stateDir.toLowerCase(), path.toLowerCase()));
    if (!inStateDir) continue;
    seenPaths.push(path);
    const dirName = basename(path);
    const match = WORKER_DIR.exec(dirName);
    const workerSessionId = match?.[1];
    const name = match?.[2] ?? dirName;
    const facts = workerSessionFacts(governanceRoot, workerSessionId);
    const present = existsSync(path);
    items.push({
      kind: present ? "worktree" : "branch-only",
      name,
      ...(present ? { path } : {}),
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      ...(workerSessionId !== undefined ? { workerSessionId } : {}),
      ...(facts.ownerSessionId !== undefined ? { ownerSessionId: facts.ownerSessionId } : {}),
      legacy: entry.branch === `${WORKER_BRANCH_PREFIX}${name}` && !name.startsWith("fork-"),
      inUse: facts.inUse,
      untaken: present
        ? untakenFiles(path, entry.branch, entry.head, root, repoRoot)
        : entry.branch !== undefined
          ? branchUntaken(repoRoot, entry.branch)
          : 0,
      bytes: present ? directoryBytes(path) : 0,
    });
  }
  // 没有工作树的 pigeon/ 分支
  for (const branch of listBranches(repoRoot, WORKER_BRANCH_PREFIX)) {
    if (seenBranches.has(branch)) continue;
    const tail = branch.slice(WORKER_BRANCH_PREFIX.length);
    items.push({
      kind: "branch-only",
      name: tail,
      branch,
      legacy: !/^[0-9a-z]{8}-/.test(tail) && !tail.startsWith("fork-"),
      inUse: false,
      untaken: branchUntaken(repoRoot, branch),
      bytes: 0,
    });
  }
  // git 不认的残留目录
  if (existsSync(stateDir)) {
    for (const dirName of readdirSync(stateDir)) {
      const path = join(stateDir, dirName);
      if (seenPaths.some((seen) => samePath(seen, path))) continue;
      try {
        if (!lstatSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      const match = WORKER_DIR.exec(dirName);
      const facts = workerSessionFacts(governanceRoot, match?.[1]);
      items.push({
        kind: "orphan-dir",
        name: match?.[2] ?? dirName,
        path,
        ...(match?.[1] !== undefined ? { workerSessionId: match[1] } : {}),
        ...(facts.ownerSessionId !== undefined ? { ownerSessionId: facts.ownerSessionId } : {}),
        legacy: false,
        inUse: facts.inUse,
        untaken: "unknown",
        bytes: directoryBytes(path),
      });
    }
  }
  return items;
}

function branchUntaken(repoRoot: string, branch: string): number | "commits" | "unknown" {
  const base = branchCreationCommit(repoRoot, branch);
  if (base === undefined) return "unknown";
  return branchMovedSince(repoRoot, branch, base) ? "commits" : 0;
}

// 删一项：工作树连分支（目录已不在的 prune 掉登记）；只剩分支的删分支；残留目录直接删目录
export function removeLeftover(scope: WorktreeScope, item: LeftoverWorktree): void {
  const repoRoot = mainRepoRoot(scope.workspaceRoot);
  if (item.kind === "orphan-dir") {
    if (item.path !== undefined) rmSync(item.path, { recursive: true, force: true });
    return;
  }
  removeWorktreeAndBranch({
    repoRoot,
    ...(item.path !== undefined ? { path: item.path } : {}),
    ...(item.branch !== undefined ? { branch: item.branch } : {}),
  });
  // 只剩分支、工作树目录被手删的：git 对已不在的目录的登记一并清掉
  if (item.kind === "branch-only") {
    pruneWorktrees(repoRoot);
  }
}

export function hasUntaken(item: LeftoverWorktree): boolean {
  return item.untaken !== 0;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function untakenText(item: LeftoverWorktree): string {
  if (item.untaken === 0) return "没有未取走的改动";
  if (item.untaken === "commits") return "分支上有新提交";
  if (item.untaken === "unknown") return "有无未取走的改动不明";
  return `未取走的改动 ${item.untaken} 个文件`;
}

function itemLine(item: LeftoverWorktree, index: number): string {
  const parts = [
    `${index + 1}. ${item.name}${item.legacy ? "（旧命名）" : ""}`,
    item.kind === "branch-only"
      ? `分支 ${item.branch ?? "?"}（工作树已不在）`
      : item.kind === "orphan-dir"
        ? "目录（git 已不认）"
        : `分支 ${item.branch ?? "（分离头指针）"}`,
    `所属会话 ${item.ownerSessionId ?? "不明"}`,
    untakenText(item),
    ...(item.kind === "branch-only" ? [] : [`占用 ${formatBytes(item.bytes)}`]),
    ...(item.inUse ? ["在用（worker 在跑），不能删"] : []),
  ];
  return `  ${parts.join("  ")}`;
}

export function formatLeftoverList(items: readonly LeftoverWorktree[]): string {
  if (items.length === 0) {
    return "没有留下的 worker 工作树与分支";
  }
  return [`留下的 worker 工作树与分支（${items.length} 项）：`, ...items.map(itemLine)].join("\n");
}

export interface CleanPlan {
  remove: LeftoverWorktree[];
  // 点名了却不能删的（在用、编号或名字不认得）
  refused: string[];
}

// 按参数挑要删的：不带参数为没有未取走改动的；--all 为全部；编号（列出时的序号）或名字为点名的。在用的一律不挑
export function planClean(items: readonly LeftoverWorktree[], args: readonly string[]): CleanPlan {
  const refused: string[] = [];
  const picked = new Set<LeftoverWorktree>();
  const named = args.filter((arg) => arg !== "--all");
  if (args.includes("--all")) {
    for (const item of items) if (!item.inUse) picked.add(item);
  } else if (named.length === 0) {
    for (const item of items) if (!item.inUse && !hasUntaken(item)) picked.add(item);
  }
  for (const arg of named) {
    const index = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
    const item =
      index >= 0 ? items[index] : items.find((entry) => entry.name === arg || entry.branch === arg);
    if (item === undefined) {
      refused.push(`${arg}：没有这一项`);
    } else if (item.inUse) {
      refused.push(`${arg}：在用（worker 在跑），不删`);
    } else {
      picked.add(item);
    }
  }
  return { remove: items.filter((item) => picked.has(item)), refused };
}

export function formatCleanPlan(plan: CleanPlan): string {
  const lines: string[] = [];
  if (plan.remove.length === 0) {
    lines.push("没有要删的");
  } else {
    lines.push(`将删除 ${plan.remove.length} 项：`);
    for (const item of plan.remove) {
      const loss = hasUntaken(item) ? `——${untakenText(item)}，删除后丢失` : "";
      lines.push(`  ${item.name}${item.branch !== undefined ? `（${item.branch}）` : ""}${loss}`);
    }
  }
  for (const line of plan.refused) lines.push(`不删 ${line}`);
  return lines.join("\n");
}

// 执行删除：逐项删，失败的照实列出、不挡其余
export function executeClean(
  scope: WorktreeScope,
  plan: CleanPlan
): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const item of plan.remove) {
    try {
      removeLeftover(scope, item);
      removed.push(item.name);
    } catch (error) {
      failed.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, failed };
}

export function formatCleanResult(result: { removed: string[]; failed: string[] }): string {
  const lines = [
    result.removed.length > 0
      ? `已删除 ${result.removed.length} 项：${result.removed.join("、")}`
      : "没有删除任何一项",
    ...result.failed.map((line) => `删除失败 ${line}`),
  ];
  return lines.join("\n");
}

export const WORKTREES_COMMAND_USAGE =
  "用法：pigeon worktrees list | clean [编号或名字…] [--all] [--yes]（clean 不带编号只删没有未取走改动的；--all 连有改动的一起删；--yes 不再确认）";

export const WORKTREES_CLEAN_HINT =
  "删除：clean 不带编号只删没有未取走改动的；带编号或名字删点名的；--all 连有改动的一起删";

// pigeon worktrees list | clean：confirm 为终端里的确认（返回是否同意）；没有终端时须带 --yes
export async function runWorktreesCommand(
  argv: readonly string[],
  scope: WorktreeScope,
  confirm?: (question: string) => Promise<boolean>
): Promise<string> {
  const [sub, ...rest] = argv;
  if (sub === "list" && rest.length === 0) {
    const items = listLeftoverWorktrees(scope);
    return `${formatLeftoverList(items)}${items.length > 0 ? `\n${WORKTREES_CLEAN_HINT.replace("删除：clean", "删除：pigeon worktrees clean")}` : ""}\n`;
  }
  if (sub === "clean") {
    const yes = rest.includes("--yes");
    const args = rest.filter((arg) => arg !== "--yes");
    const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--all");
    if (unknown !== undefined)
      throw new Error(`未知参数：${unknown}（${WORKTREES_COMMAND_USAGE}）`);
    const items = listLeftoverWorktrees(scope);
    const plan = planClean(items, args);
    const planText = formatCleanPlan(plan);
    if (plan.remove.length === 0) return `${planText}\n`;
    if (!yes) {
      if (confirm === undefined) {
        return `${planText}\n没有终端可确认：确认要删时加 --yes 再执行一次\n`;
      }
      if (!(await confirm(`${planText}\n确认删除？[y/N] `))) {
        return "已取消，没有删除\n";
      }
    }
    return `${yes ? `${planText}\n` : ""}${formatCleanResult(executeClean(scope, plan))}\n`;
  }
  throw new Error(WORKTREES_COMMAND_USAGE);
}

// 终端界面的 /worktrees：list 列出；clean 先给出将删的清单，/worktrees confirm 才删（期间再打别的 /worktrees 即作罢）
export interface TuiWorktreesFace {
  run(args: readonly string[]): string;
}

export function createTuiWorktreesFace(scope: WorktreeScope): TuiWorktreesFace {
  let pending: CleanPlan | undefined;
  return {
    run(args) {
      const [sub, ...rest] = args;
      if (sub === "confirm") {
        const plan = pending;
        pending = undefined;
        if (plan === undefined) return "没有待确认的删除：先用 /worktrees clean 选出要删的";
        // 确认时再核一遍在不在用（期间 worker 可能开跑了）
        const current = listLeftoverWorktrees(scope);
        const fresh: CleanPlan = {
          remove: plan.remove.filter(
            (item) =>
              !current.some(
                (now) =>
                  now.inUse &&
                  now.name === item.name &&
                  now.branch === item.branch &&
                  now.path === item.path
              )
          ),
          refused: [],
        };
        return formatCleanResult(executeClean(scope, fresh));
      }
      pending = undefined;
      if (sub === undefined || sub === "list") {
        const items = listLeftoverWorktrees(scope);
        return `${formatLeftoverList(items)}${items.length > 0 ? `\n${WORKTREES_CLEAN_HINT.replace("删除：clean", "删除：/worktrees clean")}` : ""}`;
      }
      if (sub === "clean") {
        const unknown = rest.find((arg) => arg.startsWith("-") && arg !== "--all");
        if (unknown !== undefined) return `未知参数：${unknown}（${WORKTREES_TUI_USAGE}）`;
        const plan = planClean(listLeftoverWorktrees(scope), rest);
        const text = formatCleanPlan(plan);
        if (plan.remove.length === 0) return text;
        pending = plan;
        return `${text}\n确认删除请输入 /worktrees confirm；输入别的 /worktrees 命令即作罢`;
      }
      return WORKTREES_TUI_USAGE;
    },
  };
}

export const WORKTREES_TUI_USAGE =
  "用法：/worktrees [list] | /worktrees clean [编号或名字…] [--all] | /worktrees confirm";
