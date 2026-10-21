// 决策 495、496：新会话开在哪里。/clear 工作目录不变；/new 不给 path 即项目根（主检出）；/new <path> 与在那里启动 pigeon
// 同一套认法（launchPlaceOf，启动时也走它）：path 在某个仓库的工作树（.pigeon/trees/<名字>，含子目录）里即归那个仓库的
// 主检出这个项目、工作目录是 path；否则项目根就是那个目录。path 先剥掉补全加的成对引号、展开 ~、相对当前工作目录解析；
// 不存在或不是目录即报错（不建目录）
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { insideNamedWorktree, namedWorktreeRepoRoot } from "../application/named-worktree.ts";
import { prepareWorkspace } from "../application/workspace.ts";
import type { NewSessionRequest } from "./commands.ts";
import { tildePath } from "./welcome.ts";

export interface SessionPlace {
  // 项目根（治理根）
  root: string;
  // 工作目录
  workspace: string;
}

export function newSessionDir(cwd: string, raw: string, home: string): string {
  // 路径里有空格时补全会给它加上双引号（"My Projects/"）
  const unquoted =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  const expanded =
    unquoted === "~"
      ? home
      : /^~[/\\]/.test(unquoted)
        ? resolve(home, unquoted.slice(2))
        : unquoted;
  const target = resolve(cwd, expanded);
  let directory: boolean;
  try {
    directory = statSync(target).isDirectory();
  } catch {
    throw new Error(`no such directory: ${tildePath(target, home)}`);
  }
  if (!directory) throw new Error(`not a directory: ${tildePath(target, home)}`);
  return target;
}

// 在某个目录启动 pigeon 时的项目与工作目录（realpath 规范化）。trees 为 false 时不认工作树（沙箱会话照旧以那个目录为项目）
export function launchPlaceOf(dir: string, options: { trees?: boolean } = {}): SessionPlace {
  const workspace = prepareWorkspace(dir);
  if (options.trees !== false) {
    let repo: string | undefined;
    try {
      repo = prepareWorkspace(namedWorktreeRepoRoot(workspace));
    } catch {
      repo = undefined;
    }
    if (repo !== undefined && insideNamedWorktree(repo, workspace))
      return { root: repo, workspace };
  }
  return { root: workspace, workspace };
}

// /clear 与 /new [path] 的新会话位置；previous 是当前会话的项目与工作目录
export function newSessionPlace(
  request: NewSessionRequest,
  previous: SessionPlace,
  home: string
): SessionPlace {
  if (request.kind === "clear") return { ...previous };
  if (request.path === undefined) return { root: previous.root, workspace: previous.root };
  return launchPlaceOf(newSessionDir(previous.workspace, request.path, home));
}
