// 程序状态的忽略规则写进使用者的全局 git 排除文件（决策 444，445 加工作树一行）：第一次在 git 仓库里建程序状态或写个人设置时，
// 若 .pigeon/state/、.pigeon/settings.local.json、.pigeon/worktrees/ 尚未被忽略（git check-ignore），把对应的
// `**/.pigeon/...` 行追加进全局排除文件，已有的行不重复。全局排除文件的取法照 Claude Code：core.excludesFile 设为绝对路径或
// 以 ~ 开头时用它；否则 $XDG_CONFIG_HOME/git/ignore；未设 XDG 时 ~/.config/git/ignore（Windows 上 ~ 即用户目录）。
// 非 git 目录什么都不写；写不进只告警，不挡运行。同一进程里同一目录只做一次。项目里不再写 .pigeon/.gitignore（已有的不动）。
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// 全局排除文件里的三行与各自用来探测是否已被忽略的路径（相对治理根）
export const GLOBAL_IGNORE_RULES: readonly { rule: string; probe: string }[] = [
  { rule: "**/.pigeon/state/", probe: ".pigeon/state/probe" },
  { rule: "**/.pigeon/settings.local.json", probe: ".pigeon/settings.local.json" },
  { rule: "**/.pigeon/worktrees/", probe: ".pigeon/worktrees/probe" },
];

export interface GlobalIgnoreOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  // 写入成功或失败时的一行提示
  notice?: (line: string) => void;
}

export interface GlobalIgnoreResult {
  // 不是 git 仓库
  skipped?: "not-git";
  file?: string;
  added: string[];
  error?: string;
}

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

// 全局排除文件的位置（不论是否存在）
export function globalExcludesFile(
  cwd: string,
  options: Pick<GlobalIgnoreOptions, "homeDir" | "env"> = {}
): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  let configured = "";
  try {
    configured = git(cwd, ["config", "--global", "--get", "core.excludesFile"], env).trim();
  } catch {
    configured = "";
  }
  if (configured === "~") return home;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return join(home, configured.slice(2));
  }
  if (configured !== "" && isAbsolute(configured)) return configured;
  const xdg = env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg !== ""
    ? join(xdg, "git", "ignore")
    : join(home, ".config", "git", "ignore");
}

// 已被忽略的探测路径（--no-index：按规则判断，不看是否已跟踪）
function ignoredProbes(root: string, env: NodeJS.ProcessEnv): Set<string> {
  const probes = GLOBAL_IGNORE_RULES.map((entry) => entry.probe);
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

export function ensureGlobalIgnoreRules(
  root: string,
  options: GlobalIgnoreOptions = {}
): GlobalIgnoreResult {
  const env = options.env ?? process.env;
  if (!insideWorkTree(root, env)) return { skipped: "not-git", added: [] };
  let file: string | undefined;
  try {
    const ignored = ignoredProbes(root, env);
    const missing = GLOBAL_IGNORE_RULES.filter((entry) => !ignored.has(entry.probe));
    if (missing.length === 0) return { added: [] };
    file = globalExcludesFile(root, options);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
    const added = missing.map((entry) => entry.rule).filter((rule) => !present.has(rule));
    if (added.length === 0) return { file, added: [] };
    mkdirSync(dirname(file), { recursive: true });
    const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(file, `${lead}${added.join("\n")}\n`);
    options.notice?.(
      `已在 git 全局排除文件 ${file} 加入 Pigeon 程序状态的忽略规则：${added.join("、")}（各仓库与工作树里的 .pigeon 程序状态与个人设置不进 git status）`
    );
    return { file, added };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.notice?.(
      `没能把 Pigeon 程序状态的忽略规则写进 git 全局排除文件${file !== undefined ? ` ${file}` : ""}：${message}（.pigeon/state/ 等可能出现在 git status 里，可自行加入 ${GLOBAL_IGNORE_RULES.map((entry) => entry.rule).join("、")}）`
    );
    return { ...(file !== undefined ? { file } : {}), added: [], error: message };
  }
}

// 同一进程里同一目录只做一次（各写入点都可放心调用）
const ensured = new Set<string>();

export function ensureGlobalIgnoreRulesOnce(root: string, options: GlobalIgnoreOptions = {}): void {
  const key = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  if (ensured.has(key)) return;
  ensured.add(key);
  ensureGlobalIgnoreRules(root, options);
}

// 测试用：清掉"本进程已做过"的记录
export function resetGlobalIgnoreMemo(): void {
  ensured.clear();
}
