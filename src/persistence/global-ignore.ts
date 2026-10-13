// 程序状态的忽略规则写进使用者的全局 git 排除文件（决策 444，445 加工作树一行）：第一次在 git 仓库里建程序状态或写个人设置时，
// 若程序状态目录、个人设置文件、独立工作树目录尚未被忽略（git check-ignore），把对应的规则行（state/paths.ts 的
// GLOBAL_IGNORE_ENTRIES）追加进全局排除文件，已有的行不重复。
// 全局排除文件的取法与 git 实际读的一致：git config --global --includes --type=path --get core.excludesFile（跟 include、
// 按 HOME 展开 ~）；没设时 $XDG_CONFIG_HOME/git/ignore，未设 XDG 时 $HOME/.config/git/ignore（HOME 优先，与 checkpoint.ts
// 的取法一致）。设成相对路径时位置不明（git 也不读 XDG 文件），只提示、不写。写完用 check-ignore 复核，没生效照"没写成"提示。
// 非 git 目录什么都不写；写不进只提示，不挡运行。同一进程里同一目录只做一次；第一次调用没带提示口时，提示留给之后第一个带
// 提示口的调用补发（终端界面里输入历史先于会话文件写，提示仍能到消息区）。
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GLOBAL_IGNORE_ENTRIES } from "../state/paths.ts";

export { GLOBAL_IGNORE_ENTRIES as GLOBAL_IGNORE_RULES };

export interface GlobalIgnoreOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  // 写入成功、没生效或失败时的一行提示
  notice?: (line: string) => void;
}

export interface GlobalIgnoreResult {
  // 不是 git 仓库
  skipped?: "not-git";
  file?: string;
  added: string[];
  error?: string;
}

const ALL_RULES = GLOBAL_IGNORE_ENTRIES.map((entry) => entry.rule).join("、");

// git 只读调用：关掉 fsmonitor（core.fsmonitor 可配成任意命令）
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync("git", ["-c", "core.fsmonitor=", ...args], {
    cwd,
    env,
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 10_000,
  });
}

function insideWorkTree(root: string, env: NodeJS.ProcessEnv): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"], env).trim() === "true";
  } catch {
    return false;
  }
}

export type ExcludesLocation =
  | { kind: "file"; path: string }
  // core.excludesFile 设成了相对路径：git 读哪里不明（也不读 XDG 文件）
  | { kind: "relative"; value: string };

// 全局排除文件的位置（不论是否存在）
export function globalExcludesLocation(
  cwd: string,
  options: Pick<GlobalIgnoreOptions, "homeDir" | "env"> = {}
): ExcludesLocation {
  const env = options.env ?? process.env;
  let configured = "";
  try {
    configured = git(
      cwd,
      ["config", "--global", "--includes", "--type=path", "--get", "core.excludesFile"],
      env
    ).trim();
  } catch {
    configured = "";
  }
  if (configured !== "") {
    return isAbsolute(configured)
      ? { kind: "file", path: configured }
      : { kind: "relative", value: configured };
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") return { kind: "file", path: join(xdg, "git", "ignore") };
  const home =
    options.homeDir ?? (env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir());
  return { kind: "file", path: join(home, ".config", "git", "ignore") };
}

// 位置明确时给出路径（测试与说明用）；相对路径时为 undefined
export function globalExcludesFile(
  cwd: string,
  options: Pick<GlobalIgnoreOptions, "homeDir" | "env"> = {}
): string | undefined {
  const location = globalExcludesLocation(cwd, options);
  return location.kind === "file" ? location.path : undefined;
}

// 已被忽略的探测路径（--no-index：按规则判断，不看是否已跟踪）
function ignoredProbes(root: string, env: NodeJS.ProcessEnv): Set<string> {
  const probes = GLOBAL_IGNORE_ENTRIES.map((entry) => entry.probe);
  try {
    const output = git(
      root,
      ["check-ignore", "--no-index", "-z", "--stdin"],
      env,
      `${probes.join("\0")}\0`
    );
    return new Set(output.split("\0").filter((part) => part.length > 0));
  } catch (error) {
    // 一个都没被忽略时 git 以 1 退出
    if ((error as { status?: unknown }).status === 1) return new Set();
    throw error;
  }
}

function missingRules(root: string, env: NodeJS.ProcessEnv): string[] {
  const ignored = ignoredProbes(root, env);
  return GLOBAL_IGNORE_ENTRIES.filter((entry) => !ignored.has(entry.probe)).map(
    (entry) => entry.rule
  );
}

function presentLines(file: string): { text: string; lines: Set<string> } {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return { text, lines: new Set(text.split(/\r?\n/).map((line) => line.trim())) };
}

export function ensureGlobalIgnoreRules(
  root: string,
  options: GlobalIgnoreOptions = {}
): GlobalIgnoreResult {
  const env = options.env ?? process.env;
  if (!insideWorkTree(root, env)) return { skipped: "not-git", added: [] };
  let file: string | undefined;
  try {
    const missing = missingRules(root, env);
    if (missing.length === 0) return { added: [] };
    const location = globalExcludesLocation(root, options);
    if (location.kind === "relative") {
      options.notice?.(
        `git 的 core.excludesFile 设成了相对路径（${location.value}），全局排除文件的位置不明，Pigeon 没有写入；请自行把 ${missing.join("、")} 加入你的全局排除文件`
      );
      return { added: [], error: "relative" };
    }
    file = location.path;
    // 写之前再读一次（与同时首写的别的进程撞上时少写重复的行）
    const { lines } = presentLines(file);
    const added = missing.filter((rule) => !lines.has(rule));
    if (added.length > 0) {
      mkdirSync(dirname(file), { recursive: true });
      const current = presentLines(file);
      const toAdd = added.filter((rule) => !current.lines.has(rule));
      if (toAdd.length > 0) {
        const lead = current.text === "" || current.text.endsWith("\n") ? "" : "\n";
        appendFileSync(file, `${lead}${toAdd.join("\n")}\n`);
      }
    }
    // 复核：写进去之后 git 确实忽略了
    const still = missingRules(root, env);
    if (still.length > 0) {
      options.notice?.(
        `已把 Pigeon 程序状态的忽略规则写进 ${file}，但 git 仍没有忽略 ${still.join("、")}（全局排除文件可能另有设置）；请自行检查，把 ${ALL_RULES} 加入 git 实际读的全局排除文件`
      );
      return { file, added, error: "ineffective" };
    }
    return { file, added };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.notice?.(
      `没能把 Pigeon 程序状态的忽略规则写进 git 全局排除文件${file !== undefined ? ` ${file}` : ""}：${message}（程序状态可能出现在 git status 里，可自行加入 ${ALL_RULES}）`
    );
    return { ...(file !== undefined ? { file } : {}), added: [], error: message };
  }
}

// 同一进程里同一目录只做一次（各写入点都可放心调用）。没带提示口的那次产生的提示留着，交给之后第一个带提示口的调用
const ensured = new Map<string, string[]>();

export function ensureGlobalIgnoreRulesOnce(root: string, options: GlobalIgnoreOptions = {}): void {
  const key = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const pending = ensured.get(key);
  if (pending !== undefined) {
    if (options.notice !== undefined) {
      for (const line of pending.splice(0)) options.notice(line);
    }
    return;
  }
  const held: string[] = [];
  ensured.set(key, held);
  const notice = options.notice;
  ensureGlobalIgnoreRules(root, {
    ...options,
    notice: (line) => {
      if (notice !== undefined) notice(line);
      else held.push(line);
    },
  });
}

// 测试用：清掉"本进程已做过"的记录
export function resetGlobalIgnoreMemo(): void {
  ensured.clear();
}
