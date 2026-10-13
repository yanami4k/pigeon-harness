// 会话回退的代码写回（决策 433、436）：按快照把工作区里的指定文件写回目标内容或删掉。只动调用方列出的文件（agent 改过的）。
// 总原则：拿不准就不写，列出来交给人。先把要写的内容全部从 git 取到内存，再逐文件"核对 → 立即写"，每个文件的结果交给
// 调用方当场落盘（中途退出也有据可查、可撤销），出错即停。护栏：
// - 路径带 .pigeon 段的（不分大小写）、带 .git 段的（与写文件工具同一判断，含 8.3 短名）、目标是符号链接或子模块的、磁盘上是符号链接、目录或有别的硬链接的不碰；
// - 路径上任何一级目录是符号链接或目录联接（Windows）、或实际位置落到仓库之外的不碰（不跟随链接写到工作区外）；
// - 磁盘上有、现状快照里没有的（被忽略、过大的未跟踪文件）不碰；内容与规划时的现状不同的不碰；
// - 写之前再 lstat 一次、再读一次比对原样字节，期间被换成链接或被改过的不碰；POSIX 上以 O_NOFOLLOW 打开；
// - 文件系统不分大小写时，只差大小写的几条动作一律不写。
// 内容：覆盖或删掉之前把原样字节（不经任何转换）存进对象库，切回时规范化内容相同即写回原样字节；读不到（被回收）的只这一个
// 文件列为无法保真。没有存下的，取快照里的对象——快照复用使用者索引里 stat 干净的条目，那是过滤与编码转换之后的形态，
// 所以按工作区当前的属性（含 .git/info/attributes，只读不执行）判断：有 filter、working-tree-encoding，或内容是 LFS 指针的，
// 列为无法保真、不写；-text（或 binary）而 core.autocrlf 不为 false 的文本（快照时已被规范化）同样不写；其余按 eol、text
// 与 core.autocrlf 自己转换行尾。git 不认 --attr-source 时快照可能被过滤器改过，没有存下原样字节的一律不写。
// 权限：覆盖已有文件不改它的权限位；恢复被删的（新建）一律 0600，快照里可执行的给属主加执行位（宁窄勿宽）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PIGEON_DIR } from "../state/paths.ts";
import {
  attrSourceSupported,
  GIT_HARDENING_CONFIG,
  hardenedGitArgs,
} from "../tools/git-hardening.ts";
import { insideGitMetadata } from "../tools/paths.ts";

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const NUL = 0;
const CR = 0x0d;
const LF = 0x0a;
const LFS_POINTER = Buffer.from("version https://git-lfs.github.com/spec/");

export class RewindRestoreError extends Error {}

function run(cwd: string, prefix: string[], args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("git", [...prefix, ...args], {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(input !== undefined ? { input } : {}),
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      Buffer.isBuffer(stderr) && stderr.length > 0
        ? stderr.toString("utf8").trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new RewindRestoreError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

// 与快照同一口径（以空树为属性来源，不跑过滤器与钩子）
function gitBuffer(cwd: string, args: string[], input?: Buffer): Buffer {
  return run(cwd, hardenedGitArgs(cwd), args, input);
}

function git(cwd: string, args: string[], input?: Buffer): string {
  return gitBuffer(cwd, args, input).toString("utf8");
}

export interface TreeFile {
  mode: string;
  blob: string;
}

// 工作区当前对一个路径的属性（只读，不执行任何驱动）
export interface PathAttributes {
  text: string;
  eol: string;
  filter: string;
  encoding: string;
}

// 快照树的读取（同一实例内按提交缓存）与仓库的几项配置。路径相对仓库根、以 / 分隔
export class SnapshotTrees {
  readonly top: string;
  // 文件系统不分大小写（git 建仓时探测的 core.ignorecase）
  readonly ignoreCase: boolean;
  // 快照写树时没有跑过滤器（git 认 --attr-source）
  readonly faithful: boolean;
  // core.autocrlf（小写；没配为空）
  readonly autocrlf: string;
  readonly #files = new Map<string, Map<string, TreeFile>>();

  constructor(workspaceRoot: string) {
    this.top = realpathSync(git(workspaceRoot, ["rev-parse", "--show-toplevel"]).trim());
    this.ignoreCase = this.#config("core.ignorecase") === "true";
    this.autocrlf = this.#config("core.autocrlf").toLowerCase();
    this.faithful = attrSourceSupported(this.top);
  }

  #config(key: string): string {
    try {
      return git(this.top, ["config", "--get", key]).trim();
    } catch {
      return "";
    }
  }

  files(commit: string): Map<string, TreeFile> {
    const cached = this.#files.get(commit);
    if (cached !== undefined) return cached;
    const files = new Map<string, TreeFile>();
    for (const line of git(this.top, ["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0")) {
      if (line === "") continue;
      const tab = line.indexOf("\t");
      const [mode = "", , blob = ""] = line.slice(0, tab).split(" ");
      files.set(line.slice(tab + 1), { mode, blob });
    }
    this.#files.set(commit, files);
    return files;
  }

  file(commit: string, path: string): TreeFile | undefined {
    return this.files(commit).get(path);
  }

  // 快照里这个目录下有没有文件
  hasDir(commit: string, dir: string): boolean {
    const prefix = `${dir}/`;
    for (const path of this.files(commit).keys()) if (path.startsWith(prefix)) return true;
    return false;
  }

  // 两份快照之间变了的文件（不认改名）
  changed(from: string, to: string): string[] {
    return git(this.top, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to])
      .split("\0")
      .filter((path) => path !== "");
  }

  // 按工作区当前的忽略规则是否被忽略
  ignored(path: string): boolean {
    try {
      run(this.top, [...GIT_HARDENING_CONFIG], ["check-ignore", "-q", "--no-index", "--", path]);
      return true;
    } catch {
      return false;
    }
  }

  // 工作区当前的属性（.gitattributes、.git/info/attributes 与全局属性；只读，不执行过滤驱动）
  attributesOf(path: string): PathAttributes {
    const attrs: PathAttributes = {
      text: "unspecified",
      eol: "unspecified",
      filter: "unspecified",
      encoding: "unspecified",
    };
    try {
      const out = run(
        this.top,
        [...GIT_HARDENING_CONFIG],
        ["check-attr", "-z", "eol", "text", "filter", "working-tree-encoding", "--", path]
      )
        .toString("utf8")
        .split("\0");
      for (let index = 0; index + 2 < out.length; index += 3) {
        const value = out[index + 2] ?? "unspecified";
        if (out[index + 1] === "eol") attrs.eol = value;
        if (out[index + 1] === "text") attrs.text = value;
        if (out[index + 1] === "filter") attrs.filter = value;
        if (out[index + 1] === "working-tree-encoding") attrs.encoding = value;
      }
    } catch {
      // 读不到属性：按有过滤处理（拿不准就不写）
      attrs.filter = "unknown";
    }
    return attrs;
  }

  // 提交里对象的原样内容（不经过滤与行尾转换）
  blob(blob: string): Buffer {
    return gitBuffer(this.top, ["cat-file", "blob", blob]);
  }

  // 一段内容按仓库规则规范化之后的对象号（与快照同一口径）；write 为真时原样（不转换）写进对象库并返回原样对象号
  hash(path: string, content: Buffer, write = false): string {
    return git(
      this.top,
      write
        ? ["hash-object", "--no-filters", "-w", "--stdin"]
        : ["hash-object", `--path=${path}`, "--stdin"],
      content
    ).trim();
  }

  // 把存下的原样对象挂到一个引用上（防 git gc 回收）：引用指向一个只含这些对象的提交
  pin(ref: string, blobs: readonly string[]): void {
    if (blobs.length === 0) return;
    const listing = [...new Set(blobs)]
      .map((blob, index) => `100644 blob ${blob}\t${index}`)
      .join("\0");
    const tree = git(this.top, ["mktree", "-z"], Buffer.from(`${listing}\0`)).trim();
    const commit = git(
      this.top,
      [
        "-c",
        "user.name=pigeon",
        "-c",
        "user.email=pigeon@localhost",
        "commit-tree",
        tree,
        "-m",
        "pigeon rewind saved bytes",
      ],
      undefined
    ).trim();
    git(this.top, ["update-ref", ref, commit]);
  }
}

// 被覆盖或删掉之前存下的原样字节：raw 是不经任何转换的对象，normalized 是按仓库规则规范化后的对象（与快照里的同一口径）
export interface SavedBlob {
  path: string;
  raw: string;
  normalized: string;
}

export interface RestoreAction {
  path: string;
  // 写成什么；没有即删掉
  target?: TreeFile;
  // 规划时的现状（现状快照里的）；没有即规划时不存在
  current?: TreeFile;
}

export interface RestoreSkip {
  path: string;
  reason: string;
}

// 一个文件的结果（逐个交给调用方落盘）
export interface RestoreStep {
  path: string;
  done: "written" | "removed" | "failed";
  // 动手之前存下的原样字节
  saved?: SavedBlob;
  reason?: string;
  // 出错之后这个文件的样子（规范化后的对象号，"absent" 为不存在）；读不到即缺省（不明）
  observed?: string;
}

export interface RestoreResult {
  written: string[];
  removed: string[];
  skipped: RestoreSkip[];
  saved: SavedBlob[];
  // 删掉的目录（删 agent 新建的文件后变空、且是这段时间里新建的）
  removedDirs: string[];
  // 出错即停：出错的那个文件与原因（可能已被截断，属于撤销范围）；之后的没有动
  failed?: RestoreSkip;
}

export function hasProgramSegment(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === PIGEON_DIR);
}

// 目录的建立时刻：取不到（为 0），或与 ctime 相同（老 Linux 上没有 statx 时 libuv 以 ctime 充当）即按取不到给 0
export function bornAtOf(stat: { birthtimeMs: number; ctimeMs: number }): number {
  if (stat.birthtimeMs <= 0 || Math.abs(stat.birthtimeMs - stat.ctimeMs) < 1) return 0;
  return stat.birthtimeMs;
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// 路径上各级目录：都必须是真目录（不是符号链接或目录联接），实际位置在仓库之内。不存在的那几级之后会新建，也算安全
function parentProblem(top: string, path: string): string | undefined {
  let at = top;
  for (const part of path.split("/").slice(0, -1)) {
    at = join(at, part);
    const stat = lstatOrUndefined(at);
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink()) return "parent directory is a symlink or junction";
    if (!stat.isDirectory()) return "parent path is not a directory";
    if (!inside(top, realpathSync(at))) return "parent directory is outside the repository";
  }
  return undefined;
}

function sha1(content: Buffer): string {
  return createHash("sha1").update(content).digest("hex");
}

function isText(content: Buffer): boolean {
  return !content.subarray(0, 8000).includes(NUL);
}

function hasCrlf(content: Buffer): boolean {
  for (let index = 1; index < content.length; index += 1) {
    if (content[index] === LF && content[index - 1] === CR) return true;
  }
  return false;
}

// LF → CRLF（已是 CRLF 的不动）
function toCrlf(content: Buffer): Buffer {
  const out: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const byte = content[index] ?? 0;
    if (byte === LF && (index === 0 || content[index - 1] !== CR)) out.push(CR);
    out.push(byte);
  }
  return Buffer.from(out);
}

const UNFAITHFUL = "can't restore faithfully";

// 写回的字节：存下过原样字节的写它；否则取快照里的对象，按工作区当前的属性判断能不能保真、怎么转换行尾
function contentFor(
  trees: SnapshotTrees,
  path: string,
  target: TreeFile,
  saved: readonly SavedBlob[],
  existing: Buffer | undefined,
  requireSaved: string | undefined
): Buffer | RestoreSkip {
  const raw = [...saved]
    .reverse()
    .find((item) => item.path === path && item.normalized === target.blob)?.raw;
  if (raw !== undefined) {
    try {
      return trees.blob(raw);
    } catch {
      return { path, reason: `${UNFAITHFUL} (saved original bytes were garbage-collected)` };
    }
  }
  // 属性在这段里变过：快照里的形态与现在的属性对不上，没有原样字节即不写
  if (requireSaved !== undefined) return { path, reason: `${UNFAITHFUL} (${requireSaved})` };
  if (!trees.faithful) {
    return {
      path,
      reason: `${UNFAITHFUL} (this git has no --attr-source; the snapshot may have been filtered)`,
    };
  }
  const attrs = trees.attributesOf(path);
  if (attrs.filter !== "unspecified" && attrs.filter !== "unset") {
    return {
      path,
      reason: `${UNFAITHFUL} (a filter is set in attributes; the snapshot may be filtered)`,
    };
  }
  if (attrs.encoding !== "unspecified" && attrs.encoding !== "unset") {
    return { path, reason: `${UNFAITHFUL} (working-tree-encoding is set in attributes)` };
  }
  const content = trees.blob(target.blob);
  if (content.subarray(0, LFS_POINTER.length).equals(LFS_POINTER)) {
    return { path, reason: `${UNFAITHFUL} (the snapshot holds an LFS pointer)` };
  }
  if (!isText(content)) return content;
  const autocrlf = trees.autocrlf === "true" || trees.autocrlf === "input";
  if (attrs.text === "unset") {
    // -text：快照时按没有属性规范化过行尾，原来的行尾找不回
    return autocrlf
      ? {
          path,
          reason: `${UNFAITHFUL} (line endings of this -text file were normalized in the snapshot)`,
        }
      : content;
  }
  if (hasCrlf(content)) return content;
  if (attrs.eol === "crlf") return toCrlf(content);
  if (attrs.eol === "lf") return content;
  if (attrs.text === "set") return trees.autocrlf === "true" ? toCrlf(content) : content;
  if (trees.autocrlf === "true") {
    // 行尾转换开着、属性没写：照磁盘上现有文件的行尾；没有现有文件按检出规则（CRLF）
    return existing !== undefined && !hasCrlf(existing) ? content : toCrlf(content);
  }
  return content;
}

export async function restoreFiles(input: {
  trees: SnapshotTrees;
  actions: readonly RestoreAction[];
  // 早先回退存下的原样字节（新的在后）
  saved?: readonly SavedBlob[];
  // 删 agent 新建的文件后变空的目录可不可以删（dir 相对仓库根；bornAt 为目录的建立时刻，取不到为 0）
  removableDir?: (dir: string, bornAt: number) => boolean;
  // 每个文件动手之后当场交给调用方落盘（写了、删了、出错）；返回之后才做下一个
  onStep?: (step: RestoreStep) => Promise<void>;
  // 给出即只写存下过原样字节的文件（属性在这段里变过等），值为原因
  requireSaved?: string;
}): Promise<RestoreResult> {
  const { trees } = input;
  const top = trees.top;
  const result: RestoreResult = {
    written: [],
    removed: [],
    skipped: [],
    saved: [],
    removedDirs: [],
  };
  const skip = (path: string, reason: string) => result.skipped.push({ path, reason });
  // 不分大小写的文件系统上只差大小写的几条：一律不写
  const keyOf = (path: string) => (trees.ignoreCase ? path.toLowerCase() : path);
  const counts = new Map<string, number>();
  for (const action of input.actions) {
    counts.set(keyOf(action.path), (counts.get(keyOf(action.path)) ?? 0) + 1);
  }
  const actions = input.actions.filter((action) => {
    if ((counts.get(keyOf(action.path)) ?? 0) > 1) {
      skip(action.path, "differs only in case from another path on this file system; not written");
      return false;
    }
    return true;
  });
  // 先把要写的内容取到内存（磁盘上现有的内容只用来定行尾，写前另有核对）；某个文件取不到只跳过它
  const prepared = new Map<string, Buffer | RestoreSkip>();
  for (const action of actions) {
    if (action.target === undefined) continue;
    if (action.target.mode !== "100644" && action.target.mode !== "100755") continue;
    try {
      const absolute = join(top, ...action.path.split("/"));
      const stat = lstatOrUndefined(absolute);
      const existing = stat?.isFile() === true ? readFileSync(absolute) : undefined;
      prepared.set(
        action.path,
        contentFor(
          trees,
          action.path,
          action.target,
          input.saved ?? [],
          existing,
          input.requireSaved
        )
      );
    } catch (error) {
      prepared.set(action.path, {
        path: action.path,
        reason: `reading snapshot content failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const deletedParents = new Set<string>();
  for (const action of actions) {
    const { path } = action;
    let saved: SavedBlob | undefined;
    try {
      if (hasProgramSegment(path)) {
        skip(path, `files under ${PIGEON_DIR} are not touched`);
        continue;
      }
      // 快照树与现状里本不会有 .git（git 不收），这里再显式挡一道：版本库元数据能让 git 执行任意命令
      if (insideGitMetadata(path)) {
        skip(path, "repository metadata (.git) is not touched");
        continue;
      }
      const target = action.target;
      if (target !== undefined && target.mode !== "100644" && target.mode !== "100755") {
        skip(path, "target is a symlink or submodule; not written");
        continue;
      }
      const content = target !== undefined ? prepared.get(path) : undefined;
      if (content !== undefined && !Buffer.isBuffer(content)) {
        skip(path, content.reason);
        continue;
      }
      const problem = parentProblem(top, path);
      if (problem !== undefined) {
        skip(path, problem);
        continue;
      }
      const absolute = join(top, ...path.split("/"));
      const stat = lstatOrUndefined(absolute);
      if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) {
        skip(path, "symlink or directory on disk; not touched");
        continue;
      }
      if (stat !== undefined && stat.nlink > 1) {
        skip(path, "has other hard links; not touched");
        continue;
      }
      let rawHash: string | undefined;
      if (stat === undefined) {
        if (action.current !== undefined) {
          skip(path, "deleted after planning");
          continue;
        }
      } else {
        if (action.current === undefined) {
          skip(path, "not in the current snapshot (ignored, too large or just created)");
          continue;
        }
        const bytes = readFileSync(absolute);
        if (trees.hash(path, bytes) !== action.current.blob) {
          skip(path, "changed after planning");
          continue;
        }
        rawHash = sha1(bytes);
        saved = { path, raw: trees.hash(path, bytes, true), normalized: action.current.blob };
        result.saved.push(saved);
      }
      // 写前最后一次核对：仍是普通文件、没有别的硬链接、字节没变（或仍不存在）
      const again = lstatOrUndefined(absolute);
      if (
        stat === undefined
          ? again !== undefined
          : again?.isFile() !== true || again.isSymbolicLink() || again.nlink > 1
      ) {
        skip(path, "changed or replaced after checking");
        continue;
      }
      if (rawHash !== undefined && sha1(readFileSync(absolute)) !== rawHash) {
        skip(path, "changed after checking");
        continue;
      }
      if (target === undefined) {
        rmSync(absolute);
        result.removed.push(path);
        deletedParents.add(path);
        await input.onStep?.({ path, done: "removed", ...(saved !== undefined ? { saved } : {}) });
        continue;
      }
      if (content === undefined) continue;
      // POSIX 上以 O_NOFOLLOW 打开（被换成链接即打不开）；Windows 上数字形式的打开标志不能用（EINVAL），用 "wx" 与 "r+"，
      // 靠写前的 lstat 核对
      const posix = process.platform !== "win32";
      const nofollow = posix ? (constants.O_NOFOLLOW ?? 0) : 0;
      let fd: number;
      if (stat === undefined) {
        mkdirSync(dirname(absolute), { recursive: true });
        // 恢复被删的文件一律 0600（宁窄勿宽），快照里可执行的给属主加执行位
        fd = openSync(
          absolute,
          posix ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow : "wx",
          0o600
        );
      } else {
        fd = openSync(absolute, posix ? constants.O_WRONLY | constants.O_TRUNC | nofollow : "r+");
      }
      try {
        if (!posix && stat !== undefined) ftruncateSync(fd, 0);
        writeFileSync(fd, content);
        if (stat === undefined && posix) fchmodSync(fd, target.mode === "100755" ? 0o700 : 0o600);
      } finally {
        closeSync(fd);
      }
      result.written.push(path);
      await input.onStep?.({ path, done: "written", ...(saved !== undefined ? { saved } : {}) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.failed = { path, reason };
      // 出错之后它是什么样子（可能已被截断）：撤销时据此判断之后有没有再被改过
      let observed: string | undefined;
      try {
        const absolute = join(top, ...path.split("/"));
        const now = lstatOrUndefined(absolute);
        observed =
          now === undefined
            ? "absent"
            : now.isFile() && !now.isSymbolicLink()
              ? trees.hash(path, readFileSync(absolute))
              : undefined;
      } catch {
        observed = undefined;
      }
      await input.onStep?.({
        path,
        done: "failed",
        reason,
        ...(saved !== undefined ? { saved } : {}),
        ...(observed !== undefined ? { observed } : {}),
      });
      break;
    }
  }
  // 删空了的上级目录：只删调用方认定是这段时间里 agent 新建的
  const removable = input.removableDir;
  if (removable !== undefined) {
    for (const path of deletedParents) {
      let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      while (dir !== "") {
        const absolute = join(top, ...dir.split("/"));
        try {
          const stat = lstatSync(absolute);
          if (!stat.isDirectory() || readdirSync(absolute).length > 0) break;
          if (!removable(dir, bornAtOf(stat))) break;
          rmdirSync(absolute);
          result.removedDirs.push(dir);
        } catch {
          break;
        }
        dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      }
    }
  }
  return result;
}

// .git/info/attributes 现在内容的散列（"none" 为没有该文件）；发消息时的快照记下它，会话回退据此判断属性在这段里变没变。
// 取不到（不是 git 工作区等）为 undefined
export function infoAttributesDigest(workspaceRoot: string): string | undefined {
  try {
    const common = git(workspaceRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim();
    const file = join(common, "info", "attributes");
    const stat = lstatOrUndefined(file);
    return stat === undefined ? "none" : sha1(readFileSync(file));
  } catch {
    return undefined;
  }
}
