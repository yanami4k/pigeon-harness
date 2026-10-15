// 独立工作树（决策 445、446）：pigeon --worktree <名字> 与模型的 enter_worktree 工具共用。
// - 位置 <主仓库根>/.pigeon/wt/<名字>，分支 pigeon-wt/<名字>（与 worker 的 pigeon/<会话号后 8 位>-<名字> 分开；
//   不放在 pigeon/ 之下，免得与 worker 分支的目录式引用冲突）。同名目录已在即打开它，不重建。
// - 起点缺省为远端默认分支（origin/HEAD 指向的分支）：远端引用超过 24 小时没取过就先 fetch，限时约 5 秒、不许交互；
//   没有远端、取不到或超时即用当前 HEAD。设置 worktree.baseRef 为 "head" 时直接用当前 HEAD。
// - 建立时按 .worktreeinclude 复制被忽略的文件（449，见 orchestration/worktree.ts 的 createWorktreeAt），并确保全局排除
//   文件里有 **/.pigeon/wt/（444、445）。
// - 退出时：没有改动（没有未提交改动与未跟踪文件、HEAD 与分支仍指向起点）即删工作树与分支；有改动由调用方问保留还是删除。
// 会话记录、设置与记忆仍在主仓库根的 .pigeon（治理根是主仓库），工作区是工作树。
import { execFile, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  createWorktreeAt,
  listWorktrees,
  mainRepoRoot,
  removeWorktreeAndBranch,
  resolveCommit,
  worktreePristine,
} from "../orchestration/worktree.ts";
import { ensureGlobalIgnoreRulesOnce } from "../persistence/global-ignore.ts";
import { worktreeInUseByOthers } from "../persistence/worktree-in-use.ts";
import { namedWorktreesDirOf } from "../state/paths.ts";
import { GIT_HARDENING_CONFIG } from "../tools/git-hardening.ts";

export const NAMED_WORKTREE_BRANCH_PREFIX = "pigeon-wt/";
// 名字：小写字母或数字开头，小写字母、数字、下划线与连字符，最长 64（Windows 上分支引用不分大小写，只收小写免得撞名）
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// 远端引用多久没取过就先取一次
export const FETCH_STALE_MS = 24 * 60 * 60_000;
export const FETCH_TIMEOUT_MS = 5_000;

export class NamedWorktreeError extends Error {}

export type WorktreeBaseMode = "fresh" | "head";

export interface NamedWorktree {
  name: string;
  // 主仓库根（治理根）
  repoRoot: string;
  path: string;
  branch: string;
  // 起点提交（重新打开的取分支建立时的那条引用日志；取不到为 undefined，退出时按有改动对待）
  base?: string;
  // 起点的说法（"origin/main"、"HEAD"，或"HEAD (fetching origin failed)" 一类）
  baseLabel: string;
  // 新建时取远端默认分支失败或超时、退回了 HEAD（没有远端默认分支不算）
  fetchFailed?: boolean;
  // 这次新建的（false = 打开已有的）
  created: boolean;
  // 工作树当前不在自己的分支 pigeon-wt/<名字> 上时为它当前的分支（或"分离头指针"）：退出时按有改动对待，删除只删自己的分支
  currentBranch?: string;
}

export function assertWorktreeName(name: string): void {
  if (!NAME.test(name)) {
    throw new NamedWorktreeError(`invalid worktree name: ${JSON.stringify(name)}`);
  }
}

export function namedWorktreeBranch(name: string): string {
  return `${NAMED_WORKTREE_BRANCH_PREFIX}${name}`;
}

function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}
): string {
  return execFileSync("git", [...GIT_HARDENING_CONFIG, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
}

// 不许交互的 git 环境：不弹终端提示、不弹凭据窗口；ssh 以批处理方式——只在使用者没有自己指定 ssh 时加
//（GIT_SSH_COMMAND、GIT_SSH 与 core.sshCommand 都没设）
export function nonInteractiveGitEnv(
  base: NodeJS.ProcessEnv = process.env,
  sshConfigured = false
): NodeJS.ProcessEnv {
  const ownSsh = sshConfigured || base.GIT_SSH_COMMAND !== undefined || base.GIT_SSH !== undefined;
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    ...(ownSsh ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
  };
}

function sshCommandConfigured(repoRoot: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    const value = git(
      repoRoot,
      ["config", "--get", "core.sshCommand"],
      env !== undefined ? { env } : {}
    );
    return value.trim() !== "";
  } catch {
    return false;
  }
}

// 决策 445：建立时把起点提交记在仓库配置里（branch.<分支>.pigeonBase，删分支时 git 一并删掉这一节）；
// 判"有没有新提交"按它，取不到即"不明"（按有改动对待）
function recordBase(repoRoot: string, branch: string, commit: string): void {
  git(repoRoot, ["config", "--local", `branch.${branch}.pigeonBase`, commit]);
}

function recordedBase(repoRoot: string, branch: string): string | undefined {
  try {
    const value = git(repoRoot, ["config", "--local", "--get", `branch.${branch}.pigeonBase`]);
    return /^[0-9a-f]{40,64}$/.test(value.trim()) ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

// 已有的独立工作树：分支一律按 pigeon-wt/<名字>；当前不在这个分支上时记下当前分支；起点取记下的那个
function existingNamedWorktree(
  repoRoot: string,
  path: string,
  name: string
): NamedWorktree | undefined {
  const registered = listWorktrees(repoRoot).find((entry) => samePath(entry.path, path));
  if (registered === undefined) return undefined;
  const branch = namedWorktreeBranch(name);
  const base = recordedBase(repoRoot, branch);
  return {
    name,
    repoRoot,
    path: resolve(path),
    branch,
    ...(base !== undefined ? { base } : {}),
    baseLabel: base !== undefined ? `commit ${base.slice(0, 12)}` : "unknown",
    created: false,
    ...(registered.branch !== branch ? { currentBranch: registered.branch ?? "(detached)" } : {}),
  };
}

export interface BaseResolution {
  commit: string;
  label: string;
  fetchFailed?: boolean;
}

// 起点：fresh = 远端默认分支（必要时先 fetch），取不到即 HEAD；head = 当前 HEAD
export function resolveWorktreeBase(
  repoRoot: string,
  mode: WorktreeBaseMode,
  options: { env?: NodeJS.ProcessEnv; now?: () => number; timeoutMs?: number } = {}
): BaseResolution {
  const head = resolveCommit(repoRoot, "HEAD");
  if (head === undefined) {
    throw new NamedWorktreeError("repository has no commits; can't create a worktree");
  }
  if (mode === "head") return { commit: head, label: "HEAD" };
  let remoteHead: string;
  try {
    remoteHead = git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
  } catch {
    return { commit: head, label: "HEAD (no remote default branch)" };
  }
  const branch = remoteHead.replace(/^refs\/remotes\/origin\//, "");
  if (branch === "" || branch.startsWith("-"))
    return { commit: head, label: "HEAD (no remote default branch)" };
  const commonDir = resolve(
    git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
  );
  const fetchHead = join(commonDir, "FETCH_HEAD");
  const now = options.now?.() ?? Date.now();
  const stale = !existsSync(fetchHead) || now - statSync(fetchHead).mtimeMs > FETCH_STALE_MS;
  if (stale) {
    try {
      git(repoRoot, ["fetch", "--quiet", "--no-tags", "origin", branch], {
        env: nonInteractiveGitEnv(options.env, sshCommandConfigured(repoRoot, options.env)),
        timeout: options.timeoutMs ?? FETCH_TIMEOUT_MS,
      });
    } catch (error) {
      const reason =
        error instanceof Error && /ETIMEDOUT|timed out/i.test(error.message)
          ? "timed out"
          : "failed";
      return { commit: head, label: `HEAD (fetching origin ${reason})`, fetchFailed: true };
    }
  }
  const commit = resolveCommit(repoRoot, `refs/remotes/origin/${branch}`);
  return commit !== undefined
    ? { commit, label: `origin/${branch}` }
    : { commit: head, label: "HEAD (no remote default branch)" };
}

// 打开或新建 <主仓库根>/.pigeon/wt/<名字>
export function openNamedWorktree(input: {
  cwd: string;
  name: string;
  baseMode?: WorktreeBaseMode;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchTimeoutMs?: number;
  // 写全局排除规则时的一行提示
  notice?: (line: string) => void;
}): NamedWorktree {
  assertWorktreeName(input.name);
  let repoRoot: string;
  try {
    repoRoot = mainRepoRoot(input.cwd);
  } catch {
    throw new NamedWorktreeError("not in a git repository; can't create a worktree");
  }
  const path = join(namedWorktreesDirOf(repoRoot), input.name);
  const branch = namedWorktreeBranch(input.name);
  if (existsSync(path)) {
    const existing = existingNamedWorktree(repoRoot, path, input.name);
    if (existing === undefined) {
      throw new NamedWorktreeError(`${path} exists but is not a worktree of this repository`);
    }
    return existing;
  }
  ensureGlobalIgnoreRulesOnce(repoRoot, input.notice !== undefined ? { notice: input.notice } : {});
  const resolution = resolveWorktreeBase(repoRoot, input.baseMode ?? "fresh", {
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.fetchTimeoutMs !== undefined ? { timeoutMs: input.fetchTimeoutMs } : {}),
  });
  createWorktreeAt({ repoRoot, path, branch, baseRef: resolution.commit, includeSource: repoRoot });
  try {
    recordBase(repoRoot, branch, resolution.commit);
  } catch {
    // 记不下：之后退出时起点按"不明"处理（会问，不自动删）
  }
  return {
    name: input.name,
    repoRoot,
    path,
    branch,
    base: resolution.commit,
    baseLabel: resolution.label,
    ...(resolution.fetchFailed === true ? { fetchFailed: true } : {}),
    created: true,
  };
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// 退出时：没有改动（目录在、干净、HEAD 与分支仍指向起点）；起点不明按有改动
export function namedWorktreeUnchanged(worktree: NamedWorktree): boolean {
  if (worktree.base === undefined || worktree.currentBranch !== undefined) return false;
  try {
    return worktreePristine(worktree.path, worktree.base, worktree.branch);
  } catch {
    return false;
  }
}

export function removeNamedWorktree(worktree: NamedWorktree): void {
  removeWorktreeAndBranch({
    repoRoot: worktree.repoRoot,
    path: worktree.path,
    branch: worktree.branch,
  });
}

// 主检出里未提交的改动（含未跟踪文件）的文件数：移进工作树时这些不会带过去（446）
export function uncommittedCount(cwd: string): number {
  try {
    return git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      .split("\0")
      .filter((part) => part.length > 3).length;
  } catch {
    return 0;
  }
}

// 退出时的清理（决策 445）：没有改动即删工作树与分支；有改动问保留还是删除（ask 不给即没有终端可问，保留）。
// 问答在壳退出之后的终端行内进行（照启动时确认配置的写法），EOF 按保留。删除不跟随链接（worktree.ts）
export async function closeNamedWorktree(
  worktree: NamedWorktree,
  io: {
    ask?: (prompt: string) => Promise<string | null>;
    write: (line: string) => void;
    // 别的仍在的进程开着这个工作树（缺省查在用锁）
    inUseByOthers?: () => boolean;
    // 另外也算没有改动的（面板会话完整取回之后再没有改动，决策 483）
    unchanged?: () => boolean;
  }
): Promise<"removed" | "kept"> {
  if ((io.inUseByOthers ?? (() => worktreeInUseByOthers(worktree.path)))()) {
    io.write(`worktree ${worktree.name} is open in another session; kept`);
    return "kept";
  }
  const kept = (): "kept" => {
    io.write(`worktree ${worktree.name} kept at ${worktree.path}`);
    return "kept";
  };
  const remove = (): "removed" | "kept" => {
    try {
      removeNamedWorktree(worktree);
      return "removed";
    } catch (error) {
      io.write(
        `removing worktree ${worktree.name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return kept();
    }
  };
  if (namedWorktreeUnchanged(worktree) || io.unchanged?.() === true) return remove();
  if (io.ask === undefined) return kept();
  for (;;) {
    const answer = await io.ask(
      `worktree ${worktree.name} (${worktree.path}) ${
        worktree.currentBranch !== undefined
          ? `is on ${worktree.currentBranch} (delete removes only ${worktree.branch})`
          : "has changes or new commits"
      }: k keep | d delete (changes and commits on ${worktree.branch} are lost)\n> `
    );
    if (answer === null) return kept();
    const choice = answer.trim().toLowerCase();
    if (choice === "k" || choice === "") return kept();
    if (choice === "d") return remove();
    io.write("k or d");
  }
}

// --worktree 的治理根：所在仓库的主仓库根（不在 git 仓库里即报错）
export function namedWorktreeRepoRoot(cwd: string): string {
  try {
    return mainRepoRoot(cwd);
  } catch {
    throw new NamedWorktreeError("not in a git repository; can't use --worktree");
  }
}

// 路径在本仓库的独立工作树里（.pigeon/wt/<名字> 之下）
export function insideNamedWorktree(repoRoot: string, path: string): boolean {
  const rel = relative(namedWorktreesDirOf(repoRoot), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// 决策 446：会话移进工作树之后再打开它（续接、/reload）：按记下的路径找回，目录还在且仍是本仓库登记的工作树才算
export function reopenNamedWorktree(repoRoot: string, path: string): NamedWorktree | undefined {
  if (!insideNamedWorktree(repoRoot, path) || !existsSync(path)) return undefined;
  return existingNamedWorktree(repoRoot, path, basename(resolve(path)));
}

// 独立工作树记下的起点（/worktrees 列出时按它算改动；取不到为 undefined）
export function namedWorktreeBase(repoRoot: string, name: string): string | undefined {
  return recordedBase(repoRoot, namedWorktreeBranch(name));
}

// 决策 443：会话面板派出时先在后台取远端默认分支（与 resolveWorktreeBase 同一个判断：超过 24 小时没取过才取，限时、不许交互），
// 界面不卡；取过之后 openNamedWorktree 不再同步 fetch。取不到返回 false（调用方改用 HEAD 起点，与取远端失败时一致）
export async function prefetchWorktreeBase(
  repoRoot: string,
  options: { env?: NodeJS.ProcessEnv; now?: () => number; timeoutMs?: number } = {}
): Promise<boolean> {
  let branch: string;
  try {
    branch = git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
      .trim()
      .replace(/^refs\/remotes\/origin\//, "");
  } catch {
    return true;
  }
  if (branch === "" || branch.startsWith("-")) return true;
  const commonDir = resolve(
    git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
  );
  const fetchHead = join(commonDir, "FETCH_HEAD");
  const now = options.now?.() ?? Date.now();
  if (existsSync(fetchHead) && now - statSync(fetchHead).mtimeMs <= FETCH_STALE_MS) return true;
  const env = nonInteractiveGitEnv(options.env, sshCommandConfigured(repoRoot, options.env));
  return new Promise<boolean>((resolvePromise) => {
    execFile(
      "git",
      [...GIT_HARDENING_CONFIG, "fetch", "--quiet", "--no-tags", "origin", branch],
      { cwd: repoRoot, env, timeout: options.timeoutMs ?? FETCH_TIMEOUT_MS, windowsHide: true },
      (error) => resolvePromise(error === null)
    );
  });
}
