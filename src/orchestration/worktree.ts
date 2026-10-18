// 工作树管理（M5.5 S1，决策 040）：隔离工作区为 git 工作树。
// 目录 <主仓库根>/.pigeon/trees/<name>（决策 494：工作树只有一种形状），分支 pigeon/<名字>。git 经参数数组直接调用，不经 shell；
// 名字先按白名单校验再进参数，杜绝被当成选项或路径穿越。合并由人用 git 完成，本模块不合并。
// 决策 449：建好后把项目根 .worktreeinclude 列出、又被 git 忽略的文件从来源工作目录复制进去。
import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SessionId } from "../state/ids.ts";
import { isUnderPigeonDir, worktreesDirOf } from "../state/paths.ts";
import { GIT_HARDENING_CONFIG, hardenedGitArgs } from "../tools/git-hardening.ts";
import { insideGitMetadata } from "../tools/paths.ts";

export class WorktreeError extends Error {}

// 决策 494：工作树名（也是分支 pigeon/<名字> 的后半段与起点引用的名字）：小写字母数字开头，小写字母数字、下划线与连字符，
// 最长 64（与 named-worktree.ts 的名字规则同一条）
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
      `Invalid worktree name: ${JSON.stringify(name)} (it must start with a lowercase letter or digit, contain only lowercase letters, digits, underscores and hyphens, and be at most 64 characters)`
    );
  }
}

// 决策 494：工作树目录一棵一个名字，不再带会话号前缀（撞名由调用方挑一个可用名字）。repoRoot 为主仓库根
export function worktreePathFor(repoRoot: string, name: string): string {
  return join(worktreesDirOf(repoRoot), name);
}

// 决策 494：工作树所在的根——项目所在仓库的主仓库根（项目开在仓库的子目录里也一样：所有工作树都在主仓库根的
// .pigeon/trees 下，建与认都按它）；不是 git 仓库时就是它本身
export function treesHomeOf(root: string): string {
  try {
    return mainRepoRoot(root);
  } catch {
    return resolve(root);
  }
}

// 工作树目录（<主仓库根>/.pigeon/trees）
export function treesDirFor(root: string): string {
  return worktreesDirOf(treesHomeOf(root));
}

export const WORKER_BRANCH_PREFIX = "pigeon/";

// 分支名去掉 pigeon/ 之后的部分：就是工作树名（决策 494）
const BRANCH_TAIL = WORKER_NAME;

function assertBranchTail(tail: string): void {
  if (!BRANCH_TAIL.test(tail)) {
    throw new WorktreeError(`Invalid worker branch: ${JSON.stringify(tail)}`);
  }
}

// 决策 279、480：子 agent 临时工作树起点快照的引用（快照提交挂在这里防止被 git 回收；与分支同名、随分支一并删除）
export const WORKTREE_START_REF_PREFIX = "refs/pigeon/worker-start/";

// tail 为分支名去掉 pigeon/ 的部分，即工作树名
export function worktreeStartRefFor(tail: string): string {
  assertBranchTail(tail);
  return `${WORKTREE_START_REF_PREFIX}${tail}`;
}

// 显式给出的分支名（/fork、独立工作树）：小写字母数字开头，小写字母数字、下划线、连字符与斜杠，不含空段、不以斜杠结尾
const EXPLICIT_BRANCH = /^[a-z0-9][a-z0-9/_-]{0,99}$/;

function assertExplicitBranch(branch: string): void {
  if (!EXPLICIT_BRANCH.test(branch) || branch.includes("//") || branch.endsWith("/")) {
    throw new WorktreeError(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
}

export interface AddWorktreeInput {
  // 仓库根（可以是仓库里的子目录）：工作树与分支建在它所在的仓库上，目录在主仓库根的 .pigeon/trees 下（决策 494）
  repoRoot: string;
  sessionId: SessionId;
  name: string;
  // 起点提交；缺省 HEAD
  baseRef?: string;
  // 分支名；缺省 pigeon/<名字>（/fork 也一样，见 494）
  branch?: string;
  // 决策 449：.worktreeinclude 的来源工作目录；缺省仓库根
  includeSource?: string;
}

export function addWorktree(input: AddWorktreeInput): WorktreeHandle {
  assertWorkerName(input.name);
  const baseRef = input.baseRef ?? "HEAD";
  if (baseRef.startsWith("-")) {
    throw new WorktreeError(`invalid base commit: ${baseRef}`);
  }
  const path = worktreePathFor(treesHomeOf(input.repoRoot), input.name);
  let branch: string;
  if (input.branch !== undefined) {
    assertExplicitBranch(input.branch);
    branch = input.branch;
  } else {
    branch = `${WORKER_BRANCH_PREFIX}${input.name}`;
  }
  createWorktreeAt({
    repoRoot: input.repoRoot,
    path,
    branch,
    baseRef,
    includeSource: input.includeSource ?? input.repoRoot,
  });
  // 决策 494：起点记进仓库配置（与独立工作树同一个键），清理时据此判断有没有未取走的改动
  try {
    const commit = resolveCommit(input.repoRoot, baseRef) ?? baseRef;
    runGit(input.repoRoot, ["config", "--local", `branch.${branch}.pigeonBase`, commit]);
  } catch {
    // 记不下就按"不明"处理（缺省清理不删）
  }
  return { name: input.name, sessionId: input.sessionId, path, branch };
}

// 在给定位置建工作树与新分支（worker 与独立工作树共用）。决策 449：先算 .worktreeinclude 要复制的清单（列不出即不建，
// 不留半成品），建好工作树之后再复制；复制出错即删掉刚建的工作树与分支
export function createWorktreeAt(input: {
  repoRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  includeSource: string;
}): void {
  assertExplicitBranch(input.branch);
  if (input.baseRef.startsWith("-")) {
    throw new WorktreeError(`invalid base commit: ${input.baseRef}`);
  }
  const includes = listWorktreeIncludes(input.includeSource);
  // 建工作树要检出文件：只关钩子（post-checkout 等）与 fsmonitor，不加 --attr-source——检出照常按 .gitattributes
  // 做行尾转换与过滤，工作树里的文件与正常检出一致
  runGit(
    input.repoRoot,
    ["worktree", "add", "-b", input.branch, input.path, input.baseRef],
    GIT_HARDENING_CONFIG
  );
  if (includes !== undefined) {
    try {
      copyListedIncludes(includes, input.path);
    } catch (error) {
      try {
        removeWorktreeAndBranch({
          repoRoot: input.repoRoot,
          path: input.path,
          branch: input.branch,
        });
      } catch {
        // 回滚失败：工作树留着，由 /worktrees 列出
      }
      throw new WorktreeError(
        `copying .worktreeinclude files failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

// ls-files 列出的文件可能很多（.worktreeinclude 列了整个目录）：输出上限放宽到 256 MiB
const LIST_MAX_BUFFER = 256 * 1024 * 1024;

export interface WorktreeIncludes {
  // 来源所在仓库的顶层（清单里的路径都相对它；工作树的根与它对应）
  top: string;
  files: string[];
}

// 决策 449：来源工作目录所在仓库里，既匹配仓库顶层 .worktreeinclude 规则（gitignore 语法）、又被 git 忽略的文件（相对顶层）。
// 匹配借 git 自己：ls-files --others --ignored --exclude-from 只按 .worktreeinclude 的规则列出未跟踪的文件，
// 再经 check-ignore 留下真被忽略的（已跟踪的本就在检出里，不在 --others 之列）。.pigeon 下的、带 .git 段的不要。
// 没有 .worktreeinclude 即 undefined
export function listWorktreeIncludes(sourceRoot: string): WorktreeIncludes | undefined {
  const top = resolve(runGit(sourceRoot, ["rev-parse", "--show-toplevel"]).trim());
  const includeFile = join(top, WORKTREE_INCLUDE_FILE);
  if (!existsSync(includeFile)) {
    return undefined;
  }
  const matched = splitNul(
    runGit(
      top,
      ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${includeFile}`],
      undefined,
      LIST_MAX_BUFFER
    )
  ).filter((path) => !isUnderPigeonDir(path) && !insideGitMetadata(path));
  if (matched.length === 0) {
    return { top, files: [] };
  }
  const ignored = new Set(checkIgnored(top, matched));
  return { top, files: matched.filter((path) => ignored.has(path)) };
}

// 一路上没有符号链接或目录联接（逐段 lstat，不跟随）；某段还不存在即到此为止、算没有
function noLinkAlong(root: string, relative: string): boolean {
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      return true;
    }
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// 按清单复制进工作树的同一位置。带 .git 段的不复制（与写文件工具同一判断）；来源一路上不能有链接、真实路径须在来源仓库顶层之内、本身是普通文件；目标一路上不能有链接，
// 已存在的不覆盖（COPYFILE_EXCL）。单个文件读不了或已不在即跳过；其余错误上抛（由建工作树的一方回滚）。返回复制了的相对路径
function copyListedIncludes(includes: WorktreeIncludes, worktreePath: string): string[] {
  const realTop = realpathSync.native(includes.top);
  const copied: string[] = [];
  for (const file of includes.files) {
    if (insideGitMetadata(file)) continue;
    const from = join(includes.top, file);
    const to = join(worktreePath, file);
    let stat: ReturnType<typeof lstatSync>;
    try {
      if (!noLinkAlong(includes.top, file)) continue;
      stat = lstatSync(from);
      if (!stat.isFile()) continue;
      if (!inside(realTop, realpathSync.native(from))) continue;
    } catch {
      continue;
    }
    if (!noLinkAlong(worktreePath, file)) continue;
    mkdirSync(dirname(to), { recursive: true });
    try {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      copied.push(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
      throw error;
    }
  }
  return copied;
}

// 决策 449：把来源仓库里 .worktreeinclude 列出、又被忽略的文件复制进已建好的工作树（清单见 listWorktreeIncludes）
export function copyWorktreeIncludes(sourceRoot: string, worktreePath: string): string[] {
  const includes = listWorktreeIncludes(sourceRoot);
  return includes === undefined ? [] : copyListedIncludes(includes, worktreePath);
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
      maxBuffer: LIST_MAX_BUFFER,
    });
    return splitNul(output);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return [];
    }
    throw new WorktreeError(
      `git check-ignore failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((part) => part.length > 0);
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// 工作树在 git 里的登记目录（<共同目录>/worktrees/<名>）：按各登记的 gitdir 文件找指向 <path>/.git 的那一个
function worktreeAdminDir(repoRoot: string, path: string): string | undefined {
  const common = resolve(
    runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
  );
  const dir = join(common, "worktrees");
  if (!existsSync(dir)) return undefined;
  const target = join(resolve(path), ".git");
  for (const name of readdirSync(dir)) {
    let recorded: string;
    try {
      recorded = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    if (samePath(recorded, target)) return join(dir, name);
  }
  return undefined;
}

// 删一个目录树，不跟随符号链接与目录联接：先逐层把链接本身断开（只删链接），再删目录。
// 链接指向的目录（可能在工作树之外）一个文件都不碰
export function removeTreeNoFollow(root: string): void {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch {
    return;
  }
  if (rootStat.isSymbolicLink()) {
    unlinkLink(root);
    return;
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const entry = join(current, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entry);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        unlinkLink(entry);
      } else if (stat.isDirectory()) {
        stack.push(entry);
      }
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

// 删链接本身：文件符号链接用 unlink；目录符号链接与 Windows 目录联接 unlink 不成时用 rmdir（只删链接，不进目标）
function unlinkLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

// 删一个工作树：先断开里面的链接再删目录（不跟随，决策 448 的删除都经这里），再删 git 的登记目录（只删这一个工作树的，
// 不整库 prune）。被 git worktree lock 锁定的不删；目录里 .git 是目录（主检出或独立仓库，不是工作树）的拒删
export function removeWorktree(input: { repoRoot: string; path: string; force?: boolean }): void {
  const path = resolve(input.path);
  const admin = worktreeAdminDir(input.repoRoot, path);
  if (admin !== undefined && existsSync(join(admin, "locked"))) {
    throw new WorktreeError(`worktree is locked (git worktree lock); not removed: ${path}`);
  }
  try {
    if (lstatSync(join(path, ".git")).isDirectory()) {
      throw new WorktreeError(`${path} is not a git worktree (.git is a directory); not removed`);
    }
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
  }
  removeTreeNoFollow(path);
  if (admin !== undefined) {
    rmSync(admin, { recursive: true, force: true, maxRetries: 3 });
  }
}

// 删除工作树分支 pigeon/<名字>（M6.5 S2：Eval 每次运行收尾清理工作树与分支）。决策 279、483、486：与它同名的起点快照引用、
// 完整取回后前移的起点（面板会话的 panel/<名字>、子 agent 的 agent/<名字>）随分支一并删除（引用不存在也算删掉）。
// 面板会话的取回起点只在这里（清理工作树时）删，关会话不删（决策 494）
export function deleteBranch(input: { repoRoot: string; branch: string }): void {
  const tail = input.branch.startsWith(WORKER_BRANCH_PREFIX)
    ? input.branch.slice(WORKER_BRANCH_PREFIX.length)
    : "";
  assertBranchTail(tail);
  runGit(input.repoRoot, ["branch", "-D", input.branch]);
  dropTreeRefs(input.repoRoot, tail);
}

// 与工作树同名的起点引用与取回起点（worker-start/、agent/、panel/ 下）一并删（不存在也算删掉）。删树时删；新建同名的树之前
// 也先删——上一棵同名的树被人手删（git worktree remove、git branch -D）时它们会留下，新树不能接手别人的起点
export function dropTreeRefs(repoRoot: string, name: string): void {
  assertBranchTail(name);
  runGit(repoRoot, ["update-ref", "-d", worktreeStartRefFor(name)]);
  for (const scope of ["agent", "panel"]) {
    runGit(repoRoot, ["update-ref", "-d", `${TAKE_BASE_REF_ROOT}${scope}/${name}`]);
  }
}

// 决策 483、486：完整取回后前移的起点挂在这下面（panel/<工作树名>、agent/<工作树名>），删分支时一并删
const TAKE_BASE_REF_ROOT = "refs/pigeon/";

// 决策 448：删一个工作树连同它的分支。目录在不在都按登记删（目录已被手删的只删登记），不跟随链接；分支已不在不算失败；
// pigeon/ 下的分支连起点引用一并删（deleteBranch），其余（独立工作树的等）只删分支
export function removeWorktreeAndBranch(input: {
  repoRoot: string;
  path?: string;
  branch?: string;
}): void {
  if (input.path !== undefined) {
    removeWorktree({ repoRoot: input.repoRoot, path: input.path });
  }
  const branch = input.branch;
  if (branch === undefined || branch.startsWith("-")) return;
  const tail = branch.startsWith(WORKER_BRANCH_PREFIX)
    ? branch.slice(WORKER_BRANCH_PREFIX.length)
    : "";
  // 分支已不在：同名的引用照样清掉
  if (resolveCommit(input.repoRoot, `refs/heads/${branch}`) === undefined) {
    if (BRANCH_TAIL.test(tail)) dropTreeRefs(input.repoRoot, tail);
    return;
  }
  if (BRANCH_TAIL.test(tail)) {
    deleteBranch({ repoRoot: input.repoRoot, branch });
  } else {
    runGit(input.repoRoot, ["branch", "-D", branch]);
  }
}

// 路径所在仓库的主仓库根（M6.5 S2：任务 repo 为 "." 时）——从工作树里调用同样返回主检出，
// 工作树与分支都建在主仓库上
// 认法：仓库目录（common dir）就是 <顶层>/.git 时取它的上一级（普通仓库与它的链接工作树都回到主检出）；不是时
// （submodule 的 .git/modules/<名字>、--separate-git-dir、bare 仓库加 worktree）不能取上一级——那会落进 git 元数据目录、
// 工作区之外或几个仓库共用的目录：仓库配置里有 core.worktree（submodule）即取它，否则取当前检出的顶层（每个检出各放一处）
export function mainRepoRoot(path: string): string {
  const commonDir = resolve(
    runGit(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
  );
  if (basename(commonDir) === ".git") return dirname(commonDir);
  try {
    const configured = runGit(path, [
      "config",
      "--file",
      join(commonDir, "config"),
      "--get",
      "core.worktree",
    ]).trim();
    if (configured !== "") return resolve(commonDir, configured);
  } catch {
    // 没有 core.worktree：按当前检出的顶层
  }
  return resolve(runGit(path, ["rev-parse", "--show-toplevel"]).trim());
}

// 把一个 ref 解析成完整提交号（M8，决策 082）：worker 工作树建好后起点提交进派出记录，
// 回放据此精确回到"任务开始处"。解析不出（空仓库、ref 不存在）返回 undefined，由调用方决定是否降级
export function resolveCommit(repoRoot: string, ref: string): string | undefined {
  if (ref.startsWith("-")) {
    throw new WorktreeError(`invalid base commit: ${ref}`);
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
    throw new WorktreeError(`invalid base commit: ${base}`);
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

// 决策 448：工作树与起点一致——目录在、没有未提交改动（含未跟踪文件与子模块里的改动）、HEAD 仍是起点提交，
// 给了分支时分支也仍指向起点（提交之后把 HEAD 分离回起点的，分支上的提交仍算改动）
export function worktreePristine(
  worktreePath: string,
  baseCommit: string,
  branch?: string
): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = runGit(worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status !== "") return false;
  if (resolveCommit(worktreePath, "HEAD") !== baseCommit) return false;
  return (
    branch === undefined ||
    branch.startsWith("-") ||
    resolveCommit(worktreePath, `refs/heads/${branch}`) === baseCommit
  );
}

// 加固过的 git（tools/git-hardening.ts：不跑 fsmonitor、钩子与 .gitattributes 指派的过滤）；hardening 缺省为整套加固参数
function runGit(
  cwd: string,
  args: string[],
  hardening: readonly string[] = hardenedGitArgs(cwd),
  maxBuffer?: number
): string {
  try {
    return execFileSync("git", [...hardening, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(maxBuffer !== undefined ? { maxBuffer } : {}),
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new WorktreeError(`git ${args.join(" ")} failed: ${detail}`);
  }
}
