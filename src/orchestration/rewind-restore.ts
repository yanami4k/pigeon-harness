// 会话回退的代码写回（决策 433、436）：按快照把工作区里的指定文件写回目标内容或删掉。只动调用方列出的文件（agent 改过的），
// 每个文件写之前再核对一次现状与规划时一致，护栏：
// - 路径带 .pigeon 段的、目标是符号链接或子模块的、磁盘上是符号链接或目录的不碰；
// - 路径上任何一级目录是符号链接或目录联接（Windows）、或实际位置落到仓库之外的不碰（不跟随链接写到工作区外）；
// - 磁盘上有、现状快照里没有的（被忽略、过大的未跟踪文件）不碰；
// - 现状与规划时不同（规划之后又被改过）的不碰。
// 被覆盖或删掉的文件先按原样字节（不经行尾转换）存进对象库并记下：切回时规范化内容相同即写回原样字节，往返逐字节一致；
// 没有记下的：磁盘上现有的文件没有 CRLF 即照它的行尾写，否则按 git 检出的规则写（行尾按仓库配置转换）。
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { PIGEON_DIR } from "../state/paths.ts";
import { hardenedGitArgs } from "../tools/git-hardening.ts";

const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const CRLF = Buffer.from([0x0d, 0x0a]);

export class RewindRestoreError extends Error {}

function gitBuffer(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", [...hardenedGitArgs(cwd), ...args], {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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

function git(cwd: string, args: string[]): string {
  return gitBuffer(cwd, args).toString("utf8");
}

export interface TreeFile {
  mode: string;
  blob: string;
}

// 快照树的读取（同一实例内按提交缓存）。路径相对仓库根、以 / 分隔
export class SnapshotTrees {
  readonly top: string;
  readonly #files = new Map<string, Map<string, TreeFile>>();

  constructor(workspaceRoot: string) {
    this.top = realpathSync(git(workspaceRoot, ["rev-parse", "--show-toplevel"]).trim());
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

  // 两份快照之间变了的文件（不认改名）
  changed(from: string, to: string): string[] {
    return git(this.top, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to])
      .split("\0")
      .filter((path) => path !== "");
  }

  // 提交的父提交；没有为 undefined
  parentOf(commit: string): string | undefined {
    try {
      return git(this.top, ["rev-parse", "--verify", "--quiet", `${commit}^`]).trim() || undefined;
    } catch {
      return undefined;
    }
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
}

function hasProgramSegment(path: string): boolean {
  return path.split("/").includes(PIGEON_DIR);
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
  const parts = path.split("/");
  let at = top;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const stat = lstatOrUndefined(at);
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink()) return "上级目录是符号链接或目录联接";
    if (!stat.isDirectory()) return "上级路径不是目录";
    if (!inside(top, realpathSync(at))) return "上级目录实际在仓库之外";
  }
  return undefined;
}

export function restoreFiles(input: {
  trees: SnapshotTrees;
  actions: readonly RestoreAction[];
  // 早先回退存下的原样字节（新的在后）
  saved?: readonly SavedBlob[];
}): RestoreResult {
  const { trees } = input;
  const top = trees.top;
  const result: RestoreResult = { written: [], removed: [], skipped: [], saved: [] };
  const skip = (path: string, reason: string) => result.skipped.push({ path, reason });
  // filters：按仓库规则规范化（与快照同一口径，只算不写）；否则原样字节写进对象库
  const hashOf = (absolute: string, path: string, filters: boolean): string =>
    git(top, [
      "hash-object",
      ...(filters ? [`--path=${path}`] : ["--no-filters", "-w"]),
      "--",
      absolute,
    ]).trim();
  for (const action of input.actions) {
    const { path } = action;
    if (hasProgramSegment(path)) {
      skip(path, `${PIGEON_DIR} 下的文件不碰`);
      continue;
    }
    if (
      action.target !== undefined &&
      action.target.mode !== "100644" &&
      action.target.mode !== "100755"
    ) {
      skip(path, "目标是符号链接或子模块，不写");
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
    // 现状核对：规划时不存在而现在有（被忽略、过大没进快照，或之后新建的），或内容与规划时不同，都不碰
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
      if (hashOf(absolute, path, true) !== action.current.blob) {
        skip(path, "规划之后又被改过");
        continue;
      }
      result.saved.push({
        path,
        raw: hashOf(absolute, path, false),
        normalized: action.current.blob,
      });
    }
    const target = action.target;
    if (target === undefined) {
      if (stat !== undefined) {
        rmSync(absolute, { force: true });
        result.removed.push(path);
        // 删空了的上级目录一并删（agent 新建的目录），到仓库根为止
        let dir = dirname(path.split("/").join(sep));
        while (dir !== "." && dir !== "") {
          try {
            if (readdirSync(join(top, dir)).length > 0) break;
            rmdirSync(join(top, dir));
          } catch {
            break;
          }
          dir = dirname(dir);
        }
      }
      continue;
    }
    const raw = [...(input.saved ?? [])]
      .reverse()
      .find((saved) => saved.path === path && saved.normalized === target.blob)?.raw;
    // 没有存下的原样字节：磁盘上的这个文件没有 CRLF 即照它的行尾写（不经检出转换），否则按检出规则写
    const keepLf =
      raw === undefined && stat !== undefined && !readFileSync(absolute).includes(CRLF);
    const content =
      raw !== undefined
        ? gitBuffer(top, ["cat-file", "blob", raw])
        : keepLf
          ? gitBuffer(top, ["cat-file", "blob", target.blob])
          : gitBuffer(top, ["cat-file", "--filters", `--path=${path}`, target.blob]);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
    if (process.platform !== "win32") {
      chmodSync(absolute, target.mode === "100755" ? 0o755 : 0o644);
    }
    result.written.push(path);
  }
  return result;
}
