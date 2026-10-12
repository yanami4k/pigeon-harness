// worker 工作树管理（M5.5 S1，决策 040）：隔离工作区第一版为 git 工作树。
// 目录 <治理根>/.pigeon/state/worktrees/<sessionId>-<name>（带会话编号：两个窗口的同名 worker 不撞目录），
// 分支 pigeon/<会话号后 8 位>-<name>（决策 447：与目录同一规则，跨会话不撞名）。git 经参数数组直接调用，不经 shell；
// 名字先按白名单校验再进参数，杜绝被当成选项或路径穿越。合并由人用 git 完成，本模块不合并。
// 决策 449：建好后把项目根 .worktreeinclude 列出、又被 git 忽略的文件从来源工作目录复制进去。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SessionId } from "../state/ids.ts";
import { isUnderPigeonDir, worktreesDirOf } from "../state/paths.ts";
import { GIT_HARDENING_CONFIG, hardenedGitArgs } from "../tools/git-hardening.ts";

export class WorktreeError extends Error {}

// worker 名：小写字母数字开头，小写字母数字与连字符，最长 40
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface WorktreeHandle {
  name: string;
  sessionId: SessionId;
  path: string;
  branch: string;
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  // 短分支名（去掉 refs/heads/）；分离头指针时缺省
  branch?: string;
}

export function assertWorkerName(name: string): void {
  if (!WORKER_NAME.test(name)) {
    throw new WorktreeError(
      `Invalid worker name: ${JSON.stringify(name)} (it must start with a lowercase letter or digit, contain only lowercase letters, digits, and hyphens, and be at most 40 characters)`
    );
  }
}

export function worktreePathFor(
  governanceRoot: string,
  sessionId: SessionId,
  name: string
): string {
  return join(worktreesDirOf(governanceRoot), `${sessionId}-${name}`);
}

export const WORKER_BRANCH_PREFIX = "pigeon/";

// 分支名去掉 pigeon/ 之后的部分：<会话号后 8 位>-<名字>；旧分支（决策 447 之前）只有 <名字>
const BRANCH_TAIL = /^[a-z0-9][a-z0-9-]{0,48}$/;

// 决策 447：<会话号后 8 位，小写>-<名字>。会话号后 8 位是 ULID 的随机部分，各次派出不同
export function branchTailFor(sessionId: SessionId, name: string): string {
  assertWorkerName(name);
  return `${sessionId.slice(-8).toLowerCase()}-${name}`;
}

export function worktreeBranchFor(sessionId: SessionId, name: string): string {
  return `${WORKER_BRANCH_PREFIX}${branchTailFor(sessionId, name)}`;
}

function assertBranchTail(tail: string): void {
  if (!BRANCH_TAIL.test(tail)) {
    throw new WorktreeError(`Invalid worker branch: ${JSON.stringify(tail)}`);
  }
}

// 决策 279：worker 起点快照的引用（快照提交挂在这里防止被 git 回收；与分支同名、随分支一并删除）
export const WORKER_START_REF_PREFIX = "refs/pigeon/worker-start/";

// tail 为分支名去掉 pigeon/ 的部分（branchTailFor 给出；旧分支即 worker 名）
export function workerStartRefFor(tail: string): string {
  assertBranchTail(tail);
  return `${WORKER_START_REF_PREFIX}${tail}`;
}

// 显式给出的分支名（/fork、独立工作树）：小写字母数字开头，小写字母数字、连字符与斜杠，不含空段、不以斜杠结尾
const EXPLICIT_BRANCH = /^[a-z0-9][a-z0-9/-]{0,99}$/;

function assertExplicitBranch(branch: string): void {
  if (!EXPLICIT_BRANCH.test(branch) || branch.includes("//") || branch.endsWith("/")) {
    throw new WorktreeError(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
}

export interface AddWorktreeInput {
  // 主仓库根：工作树与分支建在它上面
  repoRoot: string;
  // M6.5 S2（决策 057）：工作树目录所在的治理根（放在其 .pigeon/state/worktrees 下）；缺省同仓库根（主会话派 worker）。
  // Eval 的治理根是输出目录，与仓库根分开
  governanceRoot?: string;
  sessionId: SessionId;
  name: string;
  // 起点提交；缺省 HEAD
  baseRef?: string;
  // 分支名；缺省 worktreeBranchFor(sessionId, name)（/fork 给自己的 pigeon/fork-<会话号后 8 位>）
  branch?: string;
  // 决策 449：.worktreeinclude 的来源工作目录；缺省仓库根
  includeSource?: string;
}

export function addWorktree(input: AddWorktreeInput): WorktreeHandle {
  assertWorkerName(input.name);
  const baseRef = input.baseRef ?? "HEAD";
  if (baseRef.startsWith("-")) {
    throw new WorktreeError(`起点提交不合法：${baseRef}`);
  }
  const path = worktreePathFor(input.governanceRoot ?? input.repoRoot, input.sessionId, input.name);
  let branch: string;
  if (input.branch !== undefined) {
    assertExplicitBranch(input.branch);
    branch = input.branch;
  } else {
    branch = worktreeBranchFor(input.sessionId, input.name);
  }
  // 建工作树要检出文件：只关钩子（post-checkout 等）与 fsmonitor，不加 --attr-source——检出照常按 .gitattributes
  // 做行尾转换与过滤，工作树里的文件与正常检出一致
  runGit(input.repoRoot, ["worktree", "add", "-b", branch, path, baseRef], GIT_HARDENING_CONFIG);
  copyWorktreeIncludes(input.includeSource ?? input.repoRoot, path);
  return { name: input.name, sessionId: input.sessionId, path, branch };
}

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

// 决策 449：来源工作目录里既匹配 .worktreeinclude 规则（gitignore 语法）、又被 git 忽略的文件，复制进新工作树的同一位置。
// 匹配借 git 自己：ls-files --others --ignored --exclude-from 只按 .worktreeinclude 的规则列出未跟踪的文件，
// 再经 check-ignore 留下真被忽略的（已跟踪的本就在检出里，不在 --others 之列）。.pigeon 下的文件不复制；
// 只复制普通文件（符号链接与特殊文件跳过），目标已存在的不覆盖。没有 .worktreeinclude 即什么都不做。返回复制了的相对路径
export function copyWorktreeIncludes(sourceRoot: string, worktreePath: string): string[] {
  const includeFile = join(sourceRoot, WORKTREE_INCLUDE_FILE);
  if (!existsSync(includeFile)) {
    return [];
  }
  const matched = splitNul(
    runGit(sourceRoot, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${includeFile}`])
  ).filter((path) => !isUnderPigeonDir(path));
  if (matched.length === 0) {
    return [];
  }
  const ignored = new Set(checkIgnored(sourceRoot, matched));
  const copied: string[] = [];
  for (const relative of matched) {
    if (!ignored.has(relative)) continue;
    const from = join(sourceRoot, relative);
    const to = join(worktreePath, relative);
    try {
      if (!lstatSync(from).isFile() || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(relative);
    } catch {
      // 来源在列出之后消失、或无权读取：跳过这一个，不挡建工作树
    }
  }
  return copied;
}

// git check-ignore：给出的路径里被忽略的（全不被忽略时 git 以 1 退出，按空清单处理）
function checkIgnored(cwd: string, paths: readonly string[]): string[] {
  try {
    const output = execFileSync("git", [...hardenedGitArgs(cwd), "check-ignore", "-z", "--stdin"], {
      cwd,
      input: `${paths.join("\0")}\0`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return splitNul(output);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return [];
    }
    throw new WorktreeError(
      `git check-ignore 失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((part) => part.length > 0);
}

export function removeWorktree(input: { repoRoot: string; path: string; force?: boolean }): void {
  runGit(input.repoRoot, [
    "worktree",
    "remove",
    ...(input.force === true ? ["--force"] : []),
    resolve(input.path),
  ]);
}

// 删除 worker 分支（M6.5 S2：Eval 每次运行收尾清理工作树与分支）；只接受 pigeon/<会话号后 8 位>-<名字> 与旧的 pigeon/<名字>。
// 决策 279：起点快照的引用随分支一并删除（引用不存在也算删掉）
export function deleteBranch(input: { repoRoot: string; branch: string }): void {
  const tail = input.branch.startsWith(WORKER_BRANCH_PREFIX)
    ? input.branch.slice(WORKER_BRANCH_PREFIX.length)
    : "";
  assertBranchTail(tail);
  runGit(input.repoRoot, ["branch", "-D", input.branch]);
  runGit(input.repoRoot, ["update-ref", "-d", workerStartRefFor(tail)]);
}

// 决策 448：删一个工作树连同它的分支。目录还在即 git worktree remove --force；目录已不在即 prune 掉 git 的登记。
// 分支已不在不算失败；pigeon/ 下的分支连起点引用一并删（deleteBranch），其余（独立工作树的等）只删分支
export function removeWorktreeAndBranch(input: {
  repoRoot: string;
  path?: string;
  branch?: string;
}): void {
  if (input.path !== undefined) {
    if (existsSync(input.path)) {
      removeWorktree({ repoRoot: input.repoRoot, path: input.path, force: true });
    } else {
      pruneWorktrees(input.repoRoot);
    }
  }
  const branch = input.branch;
  if (branch === undefined || branch.startsWith("-")) return;
  if (resolveCommit(input.repoRoot, `refs/heads/${branch}`) === undefined) return;
  const tail = branch.startsWith(WORKER_BRANCH_PREFIX)
    ? branch.slice(WORKER_BRANCH_PREFIX.length)
    : "";
  if (BRANCH_TAIL.test(tail)) {
    deleteBranch({ repoRoot: input.repoRoot, branch });
  } else {
    runGit(input.repoRoot, ["branch", "-D", branch]);
  }
}

// 路径所在仓库的主仓库根（M6.5 S2：任务 repo 为 "." 时）——从工作树里调用同样返回主检出，
// 工作树与分支都建在主仓库上
export function mainRepoRoot(path: string): string {
  const commonDir = runGit(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  return dirname(resolve(commonDir));
}

// 把一个 ref 解析成完整提交号（M8，决策 082）：worker 工作树建好后起点提交进派出记录，
// 回放据此精确回到"任务开始处"。解析不出（空仓库、ref 不存在）返回 undefined，由调用方决定是否降级
export function resolveCommit(repoRoot: string, ref: string): string | undefined {
  if (ref.startsWith("-")) {
    throw new WorktreeError(`起点提交不合法：${ref}`);
  }
  try {
    const commit = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
    return commit === "" ? undefined : commit;
  } catch {
    return undefined;
  }
}

// 路径所在仓库的 HEAD 短号与工作区是否有未提交改动（pigeon --version 与打包产物的构建戳用；忽略文件不计）
export function describeHead(path: string): { commit: string; dirty: boolean } {
  const commit = runGit(path, ["rev-parse", "--short", "HEAD"]).trim();
  const dirty = runGit(path, ["status", "--porcelain"]).trim() !== "";
  return { commit, dirty };
}

// git worktree list --porcelain：空行分隔的块，每块 worktree / HEAD / branch|detached 行
export function listWorktrees(repoRoot: string): WorktreeEntry[] {
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: resolve(line.slice("worktree ".length)) };
      entries.push(current);
    } else if (current !== null && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current !== null && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

// 工作树内改动清单（工作树相对路径，含未跟踪文件，升序）：git status --porcelain -z；
// 改名与复制条目的原路径占下一段，跳过
export function changedFiles(worktreePath: string): string[] {
  const output = runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = new Set<string>();
  const parts = output.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length < 4) {
      continue;
    }
    files.add(part.slice(3));
    if (part.startsWith("R") || part.startsWith("C")) {
      index += 1;
    }
  }
  return [...files].sort();
}

// 清掉 git 对已不在的工作树目录的登记
export function pruneWorktrees(repoRoot: string): void {
  runGit(repoRoot, ["worktree", "prune"]);
}

// 决策 448：一个前缀下的本地分支（短名，升序）；前缀须以斜杠结尾
export function listBranches(repoRoot: string, prefix: string): string[] {
  const output = runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${prefix}`,
  ]);
  return output
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .sort();
}

// 决策 448：分支建立时指向的提交——分支引用日志里最早的一条（建工作树时 -b 建出的分支，这条就是起点）；
// 没有引用日志（关掉了 core.logAllRefUpdates、日志已过期）时返回 undefined
export function branchCreationCommit(repoRoot: string, branch: string): string | undefined {
  if (branch.startsWith("-")) return undefined;
  try {
    const lines = runGit(repoRoot, ["reflog", "show", "--format=%H", `refs/heads/${branch}`])
      .split(/\r?\n/)
      .filter((line) => /^[0-9a-f]{40,64}$/.test(line));
    return lines.at(-1);
  } catch {
    return undefined;
  }
}

// 决策 448：工作树相对 base 改过的文件（工作树相对路径，升序）：已跟踪文件的改动连同提交（git diff base），加未跟踪未忽略的文件
export function filesChangedSince(worktreePath: string, base: string): string[] {
  if (base.startsWith("-")) {
    throw new WorktreeError(`起点提交不合法：${base}`);
  }
  const tracked = splitNul(runGit(worktreePath, ["diff", "--name-only", "-z", base, "--"]));
  const untracked = splitNul(
    runGit(worktreePath, ["ls-files", "-z", "--others", "--exclude-standard"])
  );
  return [...new Set([...tracked, ...untracked])].sort();
}

// 决策 448：分支 tip 是否已不同于 base（分支上有新提交）
export function branchMovedSince(repoRoot: string, branch: string, base: string): boolean {
  return resolveCommit(repoRoot, `refs/heads/${branch}`) !== base;
}

// 决策 448：工作树与起点一致——目录在、没有未提交改动（含未跟踪文件）、HEAD 仍是起点提交（没有新提交）
export function worktreePristine(worktreePath: string, baseCommit: string): boolean {
  if (!existsSync(worktreePath)) return false;
  return (
    changedFiles(worktreePath).length === 0 && resolveCommit(worktreePath, "HEAD") === baseCommit
  );
}

// 加固过的 git（tools/git-hardening.ts：不跑 fsmonitor、钩子与 .gitattributes 指派的过滤）；hardening 缺省为整套加固参数
function runGit(
  cwd: string,
  args: string[],
  hardening: readonly string[] = hardenedGitArgs(cwd)
): string {
  try {
    return execFileSync("git", [...hardening, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new WorktreeError(`git ${args.join(" ")} 失败：${detail}`);
  }
}
