// 留下的工作树的列出与删除（决策 448）：终端界面的 /worktrees 与命令行的 pigeon worktrees list|clean 共用。
// 列出四类：.pigeon/state/worktrees/ 下 git 登记的工作树（/fork 的、以前 worker 留下的）、登记还在而目录已不在的、没有工作树的
// pigeon/ 分支（以前留下的旧分支等）、该目录下 git 不认的残留目录。每项给所属会话（派出它的会话，读工作树里那个会话的文件头）、
// 是否在用、未取走的改动（相对起点改过、内容又与主检出不同的文件数）与占用大小。
// - 比较的基准一律是主检出（不是当前目录）；当前目录在这些工作树里时拒绝列出与删除。
// - 起点取分支引用日志里最早的一条；取不到记为"不明"，按有改动对待。
// - 在用：工作树里那个会话正被一个仍在的进程打开；所属会话正被另一个仍在的进程打开；刚建、还没有会话记录（10 分钟内）；
//   调用方另给本进程里仍在用它的会话（liveWorkers）。读锁出错也按在用算。
// 删除缺省只删没有未取走改动的；点名或 --all 才删有改动的，并明说会丢。在用的一律不删。删之前重新核一遍：
// 期间变成在用或改动有变化的剔除并说明。删除不跟随链接（worktree.ts 的 removeWorktree）。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
import { sessionFileHolder } from "../persistence/session-lock.ts";
import { locateSessionFile, readSessionHeader } from "../persistence/session-reader.ts";
import { worktreeInUse } from "../persistence/worktree-in-use.ts";
import { namedWorktreesDirOf, pigeonRel, sessionsDirOf, worktreesDirOf } from "../state/paths.ts";
import { plural } from "./format.ts";
import { namedWorktreeBase, namedWorktreeBranch } from "./named-worktree.ts";

// 工作目录在 git 仓库里（/worktrees 只在这时提供）
export function isGitWorkspace(workspaceRoot: string): boolean {
  try {
    mainRepoRoot(workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

// named：pigeon --worktree 与 enter_worktree 建的独立工作树（决策 445、446），有自己的退出清理；列出但 clean 缺省与 --all 都不挑
export type LeftoverKind = "worktree" | "missing-dir" | "branch-only" | "orphan-dir" | "named";

export interface LeftoverWorktree {
  kind: LeftoverKind;
  // 显示用的名字：worker 名（目录名去掉会话号）、分支名或目录名
  name: string;
  // 工作树目录（登记的位置；只剩分支的没有）
  path?: string;
  branch?: string;
  // 目录名里的 worker 会话号
  workerSessionId?: string;
  // 派出它的会话（读不到 worker 会话文件时缺省）
  ownerSessionId?: string;
  // 决策 447 之前的命名（分支 pigeon/<名字>）
  legacy: boolean;
  // 在用：不删；inUseReason 为说明
  inUse: boolean;
  inUseReason?: string;
  // 未取走的改动：文件数；"commits" = 只剩分支且分支上有新提交（文件数不细算）；"unknown" = 算不出（按有改动对待）
  untaken: number | "commits" | "unknown";
  bytes: number;
}

export interface WorktreeScope {
  // 当前工作目录（据它找主仓库；在这些工作树里时拒绝）
  workspaceRoot: string;
  // 治理根（.pigeon 所在）；缺省主仓库根
  governanceRoot?: string;
  // 本进程里仍在用工作树的会话号（缺省没有）
  liveWorkers?: () => ReadonlySet<string>;
  // 测试用的时钟（判断"刚建"）
  now?: () => number;
}

export class WorktreeCleanupError extends Error {}

const WORKER_DIR = /^(sess_[0-9A-HJKMNP-TV-Z]{26})-(.+)$/;
// 刚建的工作树：目录新于这个时长、又还没有 worker 会话记录的，按在用算（派出到建会话文件之间的窗口）
const FRESH_MS = 10 * 60_000;

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

// 起点：分支引用日志里最早的一条；取不到为 undefined（不退回工作树当前 HEAD）
function startCommitOf(repoRoot: string, branch: string | undefined): string | undefined {
  return branch !== undefined ? branchCreationCommit(repoRoot, branch) : undefined;
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

interface WorkerFacts {
  ownerSessionId?: string;
  inUseReason?: string;
}

// 一个 worker 的事实：所属会话、是否在用
function workerFacts(
  scope: WorktreeScope,
  governanceRoot: string,
  workerSessionId: string | undefined,
  dir: string | undefined
): WorkerFacts {
  if (workerSessionId === undefined) return {};
  if (scope.liveWorkers?.().has(workerSessionId) === true) {
    return { inUseReason: "in use in this session" };
  }
  const sessionsDir = sessionsDirOf(governanceRoot);
  const file = locateSessionFile(sessionsDir, workerSessionId);
  if (file === undefined) {
    // 派出到建 worker 会话文件之间的窗口：刚建的目录按在用算
    if (dir !== undefined) {
      try {
        const age = (scope.now?.() ?? Date.now()) - statSync(dir).mtimeMs;
        if (age < FRESH_MS) return { inUseReason: "just created, no session yet" };
      } catch {
        // 目录读不了：照常列
      }
    }
    return {};
  }
  const header = readSessionHeader(file.path);
  const owner = header?.parentSessionId;
  const facts: WorkerFacts = owner !== undefined ? { ownerSessionId: owner } : {};
  if (sessionFileHolder(file.path) !== undefined) {
    return { ...facts, inUseReason: "session open" };
  }
  if (owner !== undefined) {
    const ownerFile = locateSessionFile(sessionsDir, owner);
    if (ownerFile !== undefined) {
      const holder = sessionFileHolder(ownerFile.path);
      if (holder !== undefined && holder !== process.pid) {
        facts.inUseReason = "owner session is open";
      }
    }
  }
  return facts;
}

// 当前目录在 .pigeon/state/worktrees 之下的工作树里时拒绝：比较与删除都要从主检出做
function assertNotInStateWorktree(scope: WorktreeScope, governanceRoot: string): void {
  const here = realOrResolved(scope.workspaceRoot);
  const stateDir = realOrResolved(worktreesDirOf(governanceRoot));
  if (isInside(stateDir, here) || samePath(stateDir, here)) {
    throw new WorktreeCleanupError(
      `not available inside a worktree under ${pigeonRel("state", "worktrees")}; run from the main checkout`
    );
  }
}

export function listLeftoverWorktrees(scope: WorktreeScope): LeftoverWorktree[] {
  const repoRoot = mainRepoRoot(scope.workspaceRoot);
  const governanceRoot = scope.governanceRoot ?? repoRoot;
  assertNotInStateWorktree(scope, governanceRoot);
  // 未取走的改动一律与主检出比（工作树里的路径相对仓库顶层，主检出的根即仓库顶层）
  const mainRoot = realOrResolved(repoRoot);
  const stateDir = realOrResolved(worktreesDirOf(governanceRoot));
  const items: LeftoverWorktree[] = [];
  const seenPaths: string[] = [];
  const seenBranches = new Set<string>();
  for (const entry of listWorktrees(repoRoot)) {
    if (entry.branch !== undefined) seenBranches.add(entry.branch);
    const path = resolve(entry.path);
    if (!isInside(stateDir, path)) continue;
    seenPaths.push(path);
    const dirName = basename(path);
    const match = WORKER_DIR.exec(dirName);
    const workerSessionId = match?.[1];
    const name = match?.[2] ?? dirName;
    const present = existsSync(path);
    const facts = workerFacts(scope, governanceRoot, workerSessionId, present ? path : undefined);
    const base = startCommitOf(repoRoot, entry.branch);
    items.push({
      kind: present ? "worktree" : "missing-dir",
      name,
      path,
      ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
      ...(workerSessionId !== undefined ? { workerSessionId } : {}),
      ...(facts.ownerSessionId !== undefined ? { ownerSessionId: facts.ownerSessionId } : {}),
      legacy: entry.branch === `${WORKER_BRANCH_PREFIX}${name}` && !name.startsWith("fork-"),
      inUse: facts.inUseReason !== undefined,
      ...(facts.inUseReason !== undefined ? { inUseReason: facts.inUseReason } : {}),
      untaken: present
        ? untakenFiles(path, base, mainRoot)
        : entry.branch !== undefined
          ? branchUntaken(repoRoot, entry.branch, base)
          : "unknown",
      bytes: present ? directoryBytes(path) : 0,
    });
  }
  // 决策 445、446：独立工作树（.pigeon/wt/<名字>）：分支一律按 pigeon-wt/<名字>（删除只删它）；起点取建立时记下的；
  // 工作树当前不在这个分支上时改动按"不明"；有进程持有它的在用锁（含本进程）即在用
  const namedDir = realOrResolved(namedWorktreesDirOf(repoRoot));
  for (const entry of listWorktrees(repoRoot)) {
    const path = resolve(entry.path);
    if (!isInside(namedDir, path) || !existsSync(path)) continue;
    const name = basename(path);
    const branch = namedWorktreeBranch(name);
    const holder = worktreeInUse(path);
    items.push({
      kind: "named",
      name,
      path,
      branch,
      legacy: false,
      inUse: holder,
      ...(holder ? { inUseReason: "a session is open in it" } : {}),
      untaken:
        entry.branch === branch
          ? untakenFiles(path, namedWorktreeBase(repoRoot, name), mainRoot)
          : "unknown",
      bytes: directoryBytes(path),
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
      const match = WORKER_DIR.exec(dirName);
      const facts = workerFacts(scope, governanceRoot, match?.[1], path);
      items.push({
        kind: "orphan-dir",
        name: match?.[2] ?? dirName,
        path,
        ...(match?.[1] !== undefined ? { workerSessionId: match[1] } : {}),
        ...(facts.ownerSessionId !== undefined ? { ownerSessionId: facts.ownerSessionId } : {}),
        legacy: false,
        inUse: facts.inUseReason !== undefined,
        ...(facts.inUseReason !== undefined ? { inUseReason: facts.inUseReason } : {}),
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

// 删一项：工作树连分支（目录已不在的只删登记，不跟随链接）；只剩分支的删分支；残留目录不跟随链接地删掉
export function removeLeftover(scope: WorktreeScope, item: LeftoverWorktree): void {
  const repoRoot = mainRepoRoot(scope.workspaceRoot);
  if (item.kind === "orphan-dir") {
    if (item.path !== undefined) removeTreeNoFollow(item.path);
    return;
  }
  removeWorktreeAndBranch({
    repoRoot,
    ...(item.path !== undefined ? { path: item.path } : {}),
    ...(item.branch !== undefined ? { branch: item.branch } : {}),
  });
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
    `${index + 1}. ${item.name}${item.legacy ? " (old naming)" : ""}`,
    item.kind === "branch-only"
      ? `branch ${item.branch ?? "?"} (worktree gone)`
      : item.kind === "missing-dir"
        ? `branch ${item.branch ?? "(detached)"} (directory gone, still registered)`
        : item.kind === "named"
          ? `worktree, branch ${item.branch ?? "(detached)"}`
          : item.kind === "orphan-dir"
            ? "directory (unknown to git)"
            : `branch ${item.branch ?? "(detached)"}`,
    `session ${item.ownerSessionId ?? "unknown"}`,
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
//（名字对应多项时不挑，要求给编号或完整分支名）。在用的一律不挑
export function planClean(items: readonly LeftoverWorktree[], args: readonly string[]): CleanPlan {
  const refused: string[] = [];
  const picked = new Set<LeftoverWorktree>();
  const named = args.filter((arg) => arg !== "--all");
  if (args.includes("--all")) {
    for (const item of items) if (!item.inUse && item.kind !== "named") picked.add(item);
  } else if (named.length === 0) {
    for (const item of items) {
      if (!item.inUse && !hasUntaken(item) && item.kind !== "named") picked.add(item);
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
      lines.push(`  ${item.name}${item.branch !== undefined ? ` (${item.branch})` : ""}${loss}`);
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

// 终端界面的 /worktrees：list 列出；clean 先给出将删的清单，/worktrees confirm 才删（期间再打别的 /worktrees 即作罢）；
// confirm 时重新核一遍
export interface TuiWorktreesFace {
  run(args: readonly string[]): string;
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
    run(args) {
      return guarded(() => {
        const [sub, ...rest] = args;
        if (sub === "confirm") {
          const plan = pending;
          pending = undefined;
          if (plan === undefined) return "nothing pending to confirm";
          return formatCleanResult(
            executeClean(scope, revalidatePlan(scope, { remove: plan.remove, refused: [] }))
          );
        }
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
          return `${text}\ntype /worktrees confirm to delete`;
        }
        return WORKTREES_TUI_USAGE;
      });
    },
  };
}

export const WORKTREES_TUI_USAGE =
  "usage: /worktrees [list] | /worktrees clean [<number|branch|name>...] [--all] | /worktrees confirm";
