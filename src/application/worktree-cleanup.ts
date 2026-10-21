// 留下的工作树的列出与删除（决策 448、494）：终端界面的 /worktrees 与命令行的 pigeon worktrees list|clean 共用。
// 列出四类：.pigeon/trees/ 下 git 登记的工作树、登记还在而目录已不在的、没有工作树的 pigeon/ 分支、该目录下 git 不认的残留目录。
// 每项给是否在用、未取走的改动（相对起点改过、内容又与主检出不同的文件数）与占用大小。
// - 比较的基准一律是主检出（不是当前目录）；当前目录在这些工作树里时拒绝列出与删除。
// - 起点取建立时记在仓库配置里的那个；取不到记为"不明"，按有改动对待。
// - 在用：用户级在用标记（本进程或别的进程有会话开着它，在跑的 /fork 与子 agent 的临时工作树也持有）；决策 497：会话面板
//   工作清单里仍挂着的会话的工作树（要清先在面板里删掉那一行）。
// 删除缺省只删没有未取走改动的；点名或 --all 才删有改动的，并明说会丢。在用的一律不删。删之前重新核一遍：
// 期间变成在用或改动有变化的剔除并说明；真删的那一刻再看一次在用标记。删除不跟随链接（worktree.ts 的 removeWorktree）。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  branchCreationCommit,
  branchMovedSince,
  filesChangedSince,
  listBranches,
  listWorktrees,
  mainRepoRoot,
  removeTreeNoFollow,
  removeWorktreeAndBranch,
  WORKER_BRANCH_PREFIX,
} from "../orchestration/worktree.ts";
import { type ListedSession, readableSessionIndex } from "../persistence/session-index.ts";
import { worktreeInUse } from "../persistence/worktree-in-use.ts";
import { pigeonRel, worktreesDirOf } from "../state/paths.ts";
import { plural } from "./format.ts";
import { namedWorktreeBase, namedWorktreeBranch } from "./named-worktree.ts";
import { sessionNameOf } from "./session-name.ts";

// 工作目录在 git 仓库里（/worktrees 只在这时提供）
export function isGitWorkspace(workspaceRoot: string): boolean {
  try {
    mainRepoRoot(workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

export type LeftoverKind = "worktree" | "missing-dir" | "branch-only" | "orphan-dir";

export interface LeftoverWorktree {
  kind: LeftoverKind;
  // 工作树名（目录名）；只剩分支的为分支名去掉 pigeon/
  name: string;
  // 工作树目录（登记的位置；只剩分支的没有）
  path?: string;
  branch?: string;
  // 在用：不删；inUseReason 为说明
  inUse: boolean;
  inUseReason?: string;
  // 决策 497：会话面板工作清单里挂着这棵树的会话（"名字 (会话号)"）；有即按在用
  panelSession?: string;
  // 未取走的改动：文件数；"commits" = 只剩分支且分支上有新提交（文件数不细算）；"unknown" = 算不出（按有改动对待）
  untaken: number | "commits" | "unknown";
  bytes: number;
}

export interface WorktreeScope {
  // 当前工作目录（据它找主仓库；在这些工作树里时拒绝）
  workspaceRoot: string;
  // 治理根（.pigeon 所在）；缺省主仓库根
  governanceRoot?: string;
  // 用户级程序状态所在的主目录（在用标记与会话面板的工作清单在这里；测试可注入）
  homeDir?: string;
}

export class WorktreeCleanupError extends Error {}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(dir: string, path: string): boolean {
  const check = (d: string, p: string) => {
    const rel = relative(d, p);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  return (
    check(dir, path) ||
    (process.platform === "win32" && check(dir.toLowerCase(), path.toLowerCase()))
  );
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
  base: string | undefined,
  mainRoot: string
): number | "unknown" {
  if (base === undefined) return "unknown";
  try {
    return filesChangedSince(worktree, base).filter(
      (file) => !sameContent(join(worktree, file), join(mainRoot, file))
    ).length;
  } catch {
    return "unknown";
  }
}

// 决策 497：会话面板工作清单里挂着的会话（它们的工作目录）；清单文件在却读不成为 undefined（这时每棵树都按在用算，
// 不因读不到清单就删了面板会话的树）
function listedSessions(scope: WorktreeScope): ListedSession[] | undefined {
  try {
    return readableSessionIndex(scope.homeDir);
  } catch {
    return undefined;
  }
}

// 一棵树的在用说明：在用标记（会话开着它）优先，其次面板清单里挂着它的会话；都不是为 undefined
function inUseFacts(
  scope: WorktreeScope,
  path: string | undefined,
  listed: readonly ListedSession[] | undefined
): { inUseReason?: string; panelSession?: string } {
  if (path === undefined) return {};
  if (listed === undefined) return { inUseReason: "the session panel's work list can't be read" };
  const owner = listed.find(
    (entry) => samePath(resolve(entry.workspaceRoot), path) || isInside(path, entry.workspaceRoot)
  );
  const panelSession =
    owner !== undefined
      ? `${sessionNameOf(owner.governanceRoot, owner.sessionId, owner.workspaceRoot)} (${owner.sessionId})`
      : undefined;
  const marked = worktreeInUse(path, scope.homeDir !== undefined ? { homeDir: scope.homeDir } : {});
  if (marked)
    return { inUseReason: "session open", ...(panelSession !== undefined ? { panelSession } : {}) };
  if (panelSession !== undefined) {
    return { inUseReason: `in the session panel: ${panelSession}`, panelSession };
  }
  return {};
}

// 当前目录在 .pigeon/trees 之下的工作树里时拒绝：比较与删除都要从主检出做
function assertNotInWorktree(scope: WorktreeScope, governanceRoot: string): void {
  const here = realOrResolved(scope.workspaceRoot);
  const treesDir = realOrResolved(worktreesDirOf(governanceRoot));
  if (isInside(treesDir, here) || samePath(treesDir, here)) {
    throw new WorktreeCleanupError(
      `not available inside a worktree under ${pigeonRel("trees")}; run from the main checkout`
    );
  }
}

export function listLeftoverWorktrees(scope: WorktreeScope): LeftoverWorktree[] {
  const repoRoot = mainRepoRoot(scope.workspaceRoot);
  const governanceRoot = scope.governanceRoot ?? repoRoot;
  assertNotInWorktree(scope, governanceRoot);
  // 未取走的改动一律与主检出比（工作树里的路径相对仓库顶层，主检出的根即仓库顶层）
  const mainRoot = realOrResolved(repoRoot);
  const stateDir = realOrResolved(worktreesDirOf(governanceRoot));
  const items: LeftoverWorktree[] = [];
  const seenPaths: string[] = [];
  const seenBranches = new Set<string>();
  const listed = listedSessions(scope);
  const branches = new Set(listBranches(repoRoot, WORKER_BRANCH_PREFIX));
  for (const entry of listWorktrees(repoRoot)) {
    if (entry.branch !== undefined) seenBranches.add(entry.branch);
    const path = resolve(entry.path);
    if (!isInside(stateDir, path)) continue;
    seenPaths.push(path);
    // 决策 494：目录名就是工作树的名字；起点取建立时记在仓库配置里的那个
    const name = basename(path);
    const present = existsSync(path);
    const facts = inUseFacts(scope, path, listed);
    const base = namedWorktreeBase(repoRoot, name);
    const own = namedWorktreeBranch(name);
    items.push({
      kind: present ? "worktree" : "missing-dir",
      name,
      path,
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      inUse: facts.inUseReason !== undefined,
      ...facts,
      // 目录已不在的：删的只是登记与它自己的 pigeon/<名字> 分支，会丢的只有那个分支上的新提交
      untaken: present
        ? entry.branch === own
          ? untakenFiles(path, base, mainRoot)
          : "unknown"
        : branches.has(own)
          ? branchUntaken(repoRoot, own, base)
          : 0,
      bytes: present ? directoryBytes(path) : 0,
    });
  }

  // 没有工作树的 pigeon/ 分支
  for (const branch of branches) {
    if (seenBranches.has(branch)) continue;
    const tail = branch.slice(WORKER_BRANCH_PREFIX.length);
    // 决策 494：同名的工作树已经在上面列过（它换到了别的分支上），不再单列一条"只剩分支"
    if (items.some((item) => item.name === tail)) continue;
    items.push({
      kind: "branch-only",
      name: tail,
      branch,
      inUse: false,
      untaken: branchUntaken(repoRoot, branch, branchCreationCommit(repoRoot, branch)),
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
      const facts = inUseFacts(scope, path, listed);
      items.push({
        kind: "orphan-dir",
        name: dirName,
        path,
        inUse: facts.inUseReason !== undefined,
        ...facts,
        untaken: "unknown",
        bytes: directoryBytes(path),
      });
    }
  }
  return items;
}

function branchUntaken(
  repoRoot: string,
  branch: string,
  base: string | undefined
): number | "commits" | "unknown" {
  if (base === undefined) return "unknown";
  return branchMovedSince(repoRoot, branch, base) ? "commits" : 0;
}

// 删一项：工作树连分支（目录已不在的只删登记，不跟随链接）；只剩分支的删分支；残留目录不跟随链接地删掉。
// 真删的那一刻再看一次在用标记（列出之后才有会话打开它的不删）
export function removeLeftover(scope: WorktreeScope, item: LeftoverWorktree): void {
  const repoRoot = mainRepoRoot(scope.workspaceRoot);
  if (
    item.path !== undefined &&
    worktreeInUse(item.path, scope.homeDir !== undefined ? { homeDir: scope.homeDir } : {})
  ) {
    throw new WorktreeCleanupError("in use (session open)");
  }
  if (item.kind === "orphan-dir") {
    if (item.path !== undefined) removeTreeNoFollow(item.path);
    return;
  }
  const own = removedBranchOf(item);
  removeWorktreeAndBranch({
    repoRoot,
    ...(item.path !== undefined ? { path: item.path } : {}),
    ...(own !== undefined ? { branch: own } : {}),
  });
}

// 决策 494：删的是这棵树自己的分支 pigeon/<名字>（目录已不在的也一样）；它临时换到别的分支上时，别的分支不动。残留目录不删分支
function removedBranchOf(item: LeftoverWorktree): string | undefined {
  if (item.kind === "orphan-dir") return undefined;
  return item.kind === "branch-only" ? item.branch : namedWorktreeBranch(item.name);
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
  if (item.untaken === 0) return "no untaken changes";
  if (item.untaken === "commits") return "new commits on branch";
  if (item.untaken === "unknown") return "untaken changes: unknown";
  return `untaken changes: ${plural(item.untaken, "file")}`;
}

function itemLine(item: LeftoverWorktree, index: number): string {
  const parts = [
    `${index + 1}. ${item.name}`,
    item.kind === "branch-only"
      ? `branch ${item.branch ?? "?"} (worktree gone)`
      : item.kind === "missing-dir"
        ? `branch ${item.branch ?? "(detached)"} (directory gone, still registered)`
        : item.kind === "orphan-dir"
          ? "directory (unknown to git)"
          : `branch ${item.branch ?? "(detached)"}`,
    untakenText(item),
    ...(item.kind === "branch-only" || item.kind === "missing-dir"
      ? []
      : [formatBytes(item.bytes)]),
    ...(item.inUse ? [`in use (${item.inUseReason ?? "session open"})`] : []),
  ];
  return `  ${parts.join("  ")}`;
}

export function formatLeftoverList(items: readonly LeftoverWorktree[]): string {
  if (items.length === 0) {
    return "no leftover worktrees or branches";
  }
  return [`leftover worktrees and branches (${items.length}):`, ...items.map(itemLine)].join("\n");
}

export interface CleanPlan {
  remove: LeftoverWorktree[];
  // 点名了却不能删的（在用、编号或名字不认得、同名多项）
  refused: string[];
}

// 按参数挑要删的：不带参数为没有未取走改动的；--all 为全部；编号（列出时的序号）、完整分支名或名字为点名的
//（名字对应多项时不挑，要求给编号或完整分支名）。在用的一律不挑；决策 497：点名了面板清单里的会话的树，写明是哪个会话
export function planClean(items: readonly LeftoverWorktree[], args: readonly string[]): CleanPlan {
  const refused: string[] = [];
  const picked = new Set<LeftoverWorktree>();
  const named = args.filter((arg) => arg !== "--all");
  if (args.includes("--all")) {
    for (const item of items) if (!item.inUse) picked.add(item);
  } else if (named.length === 0) {
    for (const item of items) {
      if (!item.inUse && !hasUntaken(item)) picked.add(item);
    }
  }
  for (const arg of named) {
    let item: LeftoverWorktree | undefined;
    if (/^\d+$/.test(arg)) {
      item = items[Number(arg) - 1];
    } else {
      const byBranch = items.filter((entry) => entry.branch === arg);
      const matches = byBranch.length > 0 ? byBranch : items.filter((entry) => entry.name === arg);
      if (matches.length > 1) {
        refused.push(`${arg}: ambiguous (${matches.length} matches)`);
        continue;
      }
      item = matches[0];
    }
    if (item === undefined) {
      refused.push(`${arg}: not found`);
    } else if (item.panelSession !== undefined) {
      refused.push(
        `${arg}: belongs to session ${item.panelSession} in the session panel; remove it from the panel first`
      );
    } else if (item.inUse) {
      refused.push(`${arg}: in use (${item.inUseReason ?? "session open"})`);
    } else {
      picked.add(item);
    }
  }
  return { remove: items.filter((item) => picked.has(item)), refused };
}

export function formatCleanPlan(plan: CleanPlan): string {
  const lines: string[] = [];
  if (plan.remove.length === 0) {
    lines.push("nothing to remove");
  } else {
    lines.push(`will remove ${plural(plan.remove.length, "item")}:`);
    for (const item of plan.remove) {
      const loss = hasUntaken(item) ? `: ${untakenText(item)}, lost on removal` : "";
      const branch = removedBranchOf(item);
      lines.push(`  ${item.name}${branch !== undefined ? ` (${branch})` : ""}${loss}`);
    }
  }
  for (const line of plan.refused) lines.push(`kept ${line}`);
  return lines.join("\n");
}

function sameItem(a: LeftoverWorktree, b: LeftoverWorktree): boolean {
  return (
    a.kind === b.kind &&
    a.branch === b.branch &&
    (a.path === undefined ? b.path === undefined : b.path !== undefined && samePath(a.path, b.path))
  );
}

// 执行之前重新核一遍（确认期间 worker 可能被续做、开跑或又改了文件）：已不在的、变成在用的、未取走的改动有变化的剔除并说明
export function revalidatePlan(scope: WorktreeScope, plan: CleanPlan): CleanPlan {
  const current = listLeftoverWorktrees(scope);
  const remove: LeftoverWorktree[] = [];
  const refused = [...plan.refused];
  for (const item of plan.remove) {
    const now = current.find((entry) => sameItem(entry, item));
    if (now === undefined) {
      refused.push(`${item.name}: gone`);
    } else if (now.inUse) {
      refused.push(`${item.name}: now in use (${now.inUseReason ?? "session open"})`);
    } else if (now.untaken !== item.untaken) {
      refused.push(`${item.name}: changed since listing (${untakenText(now)})`);
    } else {
      remove.push(now);
    }
  }
  return { remove, refused };
}

// 执行删除：逐项删，失败的照实列出、不挡其余
export function executeClean(
  scope: WorktreeScope,
  plan: CleanPlan
): { removed: string[]; failed: string[]; refused: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const item of plan.remove) {
    try {
      removeLeftover(scope, item);
      removed.push(item.name);
    } catch (error) {
      failed.push(
        `removing ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { removed, failed, refused: plan.refused };
}

export function formatCleanResult(result: {
  removed: string[];
  failed: string[];
  refused?: string[];
}): string {
  const lines = [
    result.removed.length > 0
      ? `removed ${plural(result.removed.length, "item")}: ${result.removed.join(", ")}`
      : "nothing removed",
    ...result.failed,
    ...(result.refused ?? []).map((line) => `kept ${line}`),
  ];
  return lines.join("\n");
}

export const WORKTREES_COMMAND_USAGE =
  "usage: pigeon worktrees list | clean [<number|branch|name>...] [--all] [--yes]";

// pigeon worktrees list | clean：confirm 为终端里的确认（返回是否同意）；没有终端时须带 --yes。确认之后、删之前重新核一遍
export async function runWorktreesCommand(
  argv: readonly string[],
  scope: WorktreeScope,
  confirm?: (question: string) => Promise<boolean>
): Promise<string> {
  const [sub, ...rest] = argv;
  if (sub === "list" && rest.length === 0) {
    return `${formatLeftoverList(listLeftoverWorktrees(scope))}\n`;
  }
  if (sub === "clean") {
    const yes = rest.includes("--yes");
    const args = rest.filter((arg) => arg !== "--yes");
    const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--all");
    if (unknown !== undefined)
      throw new Error(`unknown option: ${unknown} (${WORKTREES_COMMAND_USAGE})`);
    const items = listLeftoverWorktrees(scope);
    const plan = planClean(items, args);
    const planText = formatCleanPlan(plan);
    if (plan.remove.length === 0) return `${planText}\n`;
    if (!yes) {
      if (confirm === undefined) {
        return `${planText}\nno terminal to confirm; rerun with --yes\n`;
      }
      if (!(await confirm(`${planText}\nremove? [y/N] `))) {
        return "cancelled\n";
      }
    }
    const checked = revalidatePlan(scope, { remove: plan.remove, refused: [] });
    return `${yes ? `${planText}\n` : ""}${formatCleanResult(executeClean(scope, checked))}\n`;
  }
  throw new Error(WORKTREES_COMMAND_USAGE);
}

// 终端界面的 /worktrees：list 列出；clean 先给出将删的清单，界面在状态行问一次 `remove? [y/N]`，答 y 才删
//（答别的、按 Esc、或再打一条命令即作罢）；真删之前重新核一遍，期间变成在用或改动有变化的不删
export interface TuiWorktreesFace {
  run(args: readonly string[]): string;
  // 有等着确认的清单（clean 刚列出、还没答）
  hasPending(): boolean;
  // 答 y：重新核一遍再删，返回给人看的行
  confirmPending(): string;
  // 答别的：作罢
  cancelPending(): void;
}

export function createTuiWorktreesFace(scope: WorktreeScope): TuiWorktreesFace {
  let pending: CleanPlan | undefined;
  const guarded = (body: () => string): string => {
    try {
      return body();
    } catch (error) {
      if (error instanceof WorktreeCleanupError) return error.message;
      throw error;
    }
  };
  return {
    hasPending: () => pending !== undefined,
    confirmPending() {
      const plan = pending;
      pending = undefined;
      if (plan === undefined) return "nothing pending to confirm";
      return guarded(() =>
        formatCleanResult(
          executeClean(scope, revalidatePlan(scope, { remove: plan.remove, refused: [] }))
        )
      );
    },
    cancelPending() {
      pending = undefined;
    },
    run(args) {
      return guarded(() => {
        const [sub, ...rest] = args;
        pending = undefined;
        if (sub === undefined || sub === "list") {
          const items = listLeftoverWorktrees(scope);
          return formatLeftoverList(items);
        }
        if (sub === "clean") {
          const unknown = rest.find((arg) => arg.startsWith("-") && arg !== "--all");
          if (unknown !== undefined) return `unknown option: ${unknown} (${WORKTREES_TUI_USAGE})`;
          const plan = planClean(listLeftoverWorktrees(scope), rest);
          const text = formatCleanPlan(plan);
          if (plan.remove.length === 0) return text;
          pending = plan;
          return `${text}\nremove? [y/N]`;
        }
        return WORKTREES_TUI_USAGE;
      });
    },
  };
}

export const WORKTREES_TUI_USAGE =
  "usage: /worktrees [list] | /worktrees clean [<number|branch|name>...] [--all]";
