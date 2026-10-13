// 会话回退的代码写回（决策 433、436）：按快照把工作区里的指定文件写回目标内容或删掉。只动调用方列出的文件（agent 改过的）。
// 先把要写的内容全部从 git 取到内存，再逐文件"核对 → 立即写"，出错即停（已写的照实返回，调用方记进会话）。护栏：
// - 路径带 .pigeon 段的（不分大小写）、目标是符号链接或子模块的、磁盘上是符号链接或目录的不碰；
// - 路径上任何一级目录是符号链接或目录联接（Windows）、或实际位置落到仓库之外的不碰（不跟随链接写到工作区外）；
// - 磁盘上有、现状快照里没有的（被忽略、过大的未跟踪文件）不碰；内容与规划时的现状不同的不碰；
// - 写之前再 lstat 一次、再读一次比对原样字节，期间被换成链接或被改过的不碰；POSIX 上以 O_NOFOLLOW 打开；
// - 文件系统不分大小写时，只差大小写的几条动作一律不写。
// 行尾：覆盖或删掉之前把原样字节（不经行尾转换）存进对象库，切回时规范化内容相同即写回原样字节；没有存下的，取快照里的
// 原样对象（快照写树时以空树为属性来源，不跑过滤器），按工作区当前的 .gitattributes（只读 eol 与 text，不执行过滤驱动）
// 与 core.autocrlf 自己转换行尾。git 不认 --attr-source 时快照里的内容可能已被过滤器改过，没有存下原样字节的不写。
// 权限：覆盖已有文件不改它的权限位；新建的按 umask 缺省，快照里可执行的另加可执行位（只加在有读权限的那几类上）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PIGEON_DIR } from "../state/paths.ts";
import {
  attrSourceSupported,
  GIT_HARDENING_CONFIG,
  hardenedGitArgs,
} from "../tools/git-hardening.ts";

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const NUL = 0;
const CR = 0x0d;
const LF = 0x0a;

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
    throw new RewindRestoreError(`git ${args.join(" ")} 失败：${detail}`);
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

export type EolRule = "lf" | "crlf" | "binary" | "auto";

// 快照树的读取（同一实例内按提交缓存）与仓库的几项配置。路径相对仓库根、以 / 分隔
export class SnapshotTrees {
  readonly top: string;
  // 文件系统不分大小写（git 建仓时探测的 core.ignorecase）
  readonly ignoreCase: boolean;
  // 快照里存的是工作区原样内容（git 认 --attr-source）
  readonly faithful: boolean;
  readonly #autocrlf: string;
  readonly #files = new Map<string, Map<string, TreeFile>>();

  constructor(workspaceRoot: string) {
    this.top = realpathSync(git(workspaceRoot, ["rev-parse", "--show-toplevel"]).trim());
    this.ignoreCase = this.#config("core.ignorecase") === "true";
    this.#autocrlf = this.#config("core.autocrlf").toLowerCase();
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

  // 按工作区当前的 .gitattributes 定这个路径的行尾（只读 eol 与 text，不执行过滤驱动）
  eolOf(path: string): EolRule {
    let text = "unspecified";
    let eol = "unspecified";
    try {
      const out = run(
        this.top,
        [...GIT_HARDENING_CONFIG],
        ["check-attr", "-z", "eol", "text", "--", path]
      )
        .toString("utf8")
        .split("\0");
      for (let index = 0; index + 2 < out.length; index += 3) {
        if (out[index + 1] === "eol") eol = out[index + 2] ?? eol;
        if (out[index + 1] === "text") text = out[index + 2] ?? text;
      }
    } catch {
      // 读不到属性按没有设
    }
    if (text === "unset") return "binary";
    if (eol === "lf" || eol === "crlf") return eol;
    if (text === "set") return this.#autocrlf === "true" ? "crlf" : "lf";
    return this.#autocrlf === "true" ? "auto" : "binary";
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
}

// 被覆盖或删掉之前存下的原样字节：raw 是不经行尾转换的对象，normalized 是按仓库规则规范化后的对象（与快照里的同一口径）
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

export interface RestoreResult {
  written: string[];
  removed: string[];
  skipped: RestoreSkip[];
  saved: SavedBlob[];
  // 删掉的目录（删 agent 新建的文件后变空、且是这段时间里新建的）
  removedDirs: string[];
  // 出错即停：出错的那个文件与原因；之后的没有动
  failed?: RestoreSkip;
}

export function hasProgramSegment(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === PIGEON_DIR);
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
    if (stat.isSymbolicLink()) return "上级目录是符号链接或目录联接";
    if (!stat.isDirectory()) return "上级路径不是目录";
    if (!inside(top, realpathSync(at))) return "上级目录实际在仓库之外";
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

// 写回的字节：存下过原样字节的写它；否则取快照里的原样对象，按工作区当前的规则转换行尾（existing 是磁盘上现有的内容）
function contentFor(
  trees: SnapshotTrees,
  path: string,
  target: TreeFile,
  saved: readonly SavedBlob[],
  existing: Buffer | undefined
): Buffer | RestoreSkip {
  const raw = [...saved]
    .reverse()
    .find((item) => item.path === path && item.normalized === target.blob)?.raw;
  if (raw !== undefined) return trees.blob(raw);
  if (!trees.faithful) {
    return {
      path,
      reason: "这个 git 不支持 --attr-source，快照内容可能被过滤器改过，没有存下原样字节，不写",
    };
  }
  const content = trees.blob(target.blob);
  if (!isText(content) || hasCrlf(content)) return content;
  const rule = trees.eolOf(path);
  if (rule === "crlf") return toCrlf(content);
  if (rule === "auto") {
    // 行尾转换开着、属性没写：照磁盘上现有文件的行尾；没有现有文件按检出规则（CRLF）
    return existing !== undefined && !hasCrlf(existing) ? content : toCrlf(content);
  }
  return content;
}

export function restoreFiles(input: {
  trees: SnapshotTrees;
  actions: readonly RestoreAction[];
  // 早先回退存下的原样字节（新的在后）
  saved?: readonly SavedBlob[];
  // 删 agent 新建的文件后变空的目录可不可以删（dir 相对仓库根；bornAt 为目录的建立时刻，取不到为 0）
  removableDir?: (dir: string, bornAt: number) => boolean;
}): RestoreResult {
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
      skip(action.path, "与另一条只差大小写（这个文件系统不分大小写），不写");
      return false;
    }
    return true;
  });
  // 先把要写的内容取到内存（磁盘上现有的内容只用来定行尾，写前另有核对）
  const prepared = new Map<string, Buffer | RestoreSkip>();
  try {
    for (const action of actions) {
      if (action.target === undefined) continue;
      if (action.target.mode !== "100644" && action.target.mode !== "100755") continue;
      const absolute = join(top, ...action.path.split("/"));
      const stat = lstatOrUndefined(absolute);
      const existing = stat?.isFile() === true ? readFileSync(absolute) : undefined;
      prepared.set(
        action.path,
        contentFor(trees, action.path, action.target, input.saved ?? [], existing)
      );
    }
  } catch (error) {
    result.failed = {
      path: "",
      reason: `取快照内容失败，没有写任何文件：${error instanceof Error ? error.message : String(error)}`,
    };
    return result;
  }
  const deletedParents = new Set<string>();
  for (const action of actions) {
    const { path } = action;
    try {
      if (hasProgramSegment(path)) {
        skip(path, `${PIGEON_DIR} 下的文件不碰`);
        continue;
      }
      const target = action.target;
      if (target !== undefined && target.mode !== "100644" && target.mode !== "100755") {
        skip(path, "目标是符号链接或子模块，不写");
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
        skip(path, "磁盘上是符号链接或目录，不碰");
        continue;
      }
      let rawHash: string | undefined;
      if (stat === undefined) {
        if (action.current !== undefined) {
          skip(path, "规划之后已被删掉");
          continue;
        }
      } else {
        if (action.current === undefined) {
          skip(path, "没进现状快照（被忽略、过大或刚新建）");
          continue;
        }
        const bytes = readFileSync(absolute);
        if (trees.hash(path, bytes) !== action.current.blob) {
          skip(path, "规划之后又被改过");
          continue;
        }
        rawHash = sha1(bytes);
        result.saved.push({
          path,
          raw: trees.hash(path, bytes, true),
          normalized: action.current.blob,
        });
      }
      // 写前最后一次核对：仍是普通文件、字节没变（或仍不存在）
      const again = lstatOrUndefined(absolute);
      if (stat === undefined ? again !== undefined : again?.isFile() !== true) {
        skip(path, "核对之后被改动或换成了别的东西");
        continue;
      }
      if (rawHash !== undefined && sha1(readFileSync(absolute)) !== rawHash) {
        skip(path, "核对之后又被改过");
        continue;
      }
      if (target === undefined) {
        rmSync(absolute);
        result.removed.push(path);
        deletedParents.add(path);
        continue;
      }
      if (content === undefined) continue;
      // POSIX 上以 O_NOFOLLOW 打开（被换成链接即打不开）；Windows 上数字形式的打开标志不能用（EINVAL），用 "wx" 与 "r+"
      //（都不新建链接目标之外的东西），靠写前的 lstat 核对
      const posix = process.platform !== "win32";
      const nofollow = posix ? (constants.O_NOFOLLOW ?? 0) : 0;
      if (stat === undefined) {
        mkdirSync(dirname(absolute), { recursive: true });
        const fd = openSync(
          absolute,
          posix ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow : "wx",
          0o666
        );
        try {
          writeSync(fd, content);
          if (target.mode === "100755" && process.platform !== "win32") {
            const mode = fstatSync(fd).mode & 0o777;
            fchmodSync(fd, mode | ((mode & 0o444) >> 2));
          }
        } finally {
          closeSync(fd);
        }
      } else {
        const fd = openSync(
          absolute,
          posix ? constants.O_WRONLY | constants.O_TRUNC | nofollow : "r+"
        );
        try {
          if (!posix) ftruncateSync(fd, 0);
          writeSync(fd, content);
        } finally {
          closeSync(fd);
        }
      }
      result.written.push(path);
    } catch (error) {
      result.failed = { path, reason: error instanceof Error ? error.message : String(error) };
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
          if (!removable(dir, stat.birthtimeMs)) break;
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
