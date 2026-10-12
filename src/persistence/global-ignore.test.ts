// 程序状态的忽略规则写进全局 git 排除文件（决策 444、445）：全局配置、XDG 目录与家目录一律指到临时目录，绝不碰真实用户目录。
// 非 git 不写；三行缺哪行补哪行、已有的不重复；已被项目规则忽略的不写；core.excludesFile 的绝对路径、~ 开头与相对路径三种取法；
// 未设 XDG 时落在 ~/.config/git/ignore；写不进只提示不抛；同一进程同一目录只做一次。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  ensureGlobalIgnoreRules,
  ensureGlobalIgnoreRulesOnce,
  GLOBAL_IGNORE_RULES,
  globalExcludesFile,
  resetGlobalIgnoreMemo,
} from "./global-ignore.ts";
import { ensureProjectStateDir, ensureStateDirOf } from "./settings.ts";

const dirs: string[] = [];
afterEach(() => {
  resetGlobalIgnoreMemo();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

// 隔离的 git 环境：空的全局配置、临时 XDG、临时家目录
function sandbox(options: { xdg?: boolean } = {}) {
  const base = temp("pigeon-gi-env-");
  const home = join(base, "home");
  const xdg = join(base, "xdg");
  mkdirSync(home);
  mkdirSync(xdg);
  const globalConfig = join(base, "gitconfig");
  writeFileSync(globalConfig, "");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
  if (options.xdg !== false) env.XDG_CONFIG_HOME = xdg;
  else delete env.XDG_CONFIG_HOME;
  return { base, home, xdg, globalConfig, env };
}

function repo(env: NodeJS.ProcessEnv): string {
  const root = temp("pigeon-gi-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
  return root;
}

function ignored(root: string, env: NodeJS.ProcessEnv, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root, env });
    return true;
  } catch {
    return false;
  }
}

const ALL = GLOBAL_IGNORE_RULES.map((entry) => entry.rule);

test("git 仓库里三行都缺：写进 $XDG_CONFIG_HOME/git/ignore，提示一行；之后 .pigeon 的程序状态被忽略；再调一次不重复", () => {
  const s = sandbox();
  const root = repo(s.env);
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(root, {
    env: s.env,
    homeDir: s.home,
    notice: (line) => notices.push(line),
  });
  const file = join(s.xdg, "git", "ignore");
  assert.equal(result.file, file);
  assert.deepEqual(result.added, ALL);
  assert.equal(readFileSync(file, "utf8"), `${ALL.join("\n")}\n`);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /已在 git 全局排除文件 .* 加入 Pigeon 程序状态的忽略规则/);
  for (const path of [
    ".pigeon/state/sessions/x.jsonl",
    ".pigeon/settings.local.json",
    ".pigeon/worktrees/w/a.txt",
    "sub/.pigeon/state/x",
  ]) {
    assert.equal(ignored(root, s.env, path), true, path);
  }
  assert.equal(ignored(root, s.env, ".pigeon/settings.json"), false, "项目共享设置照常可提交");
  const again = ensureGlobalIgnoreRules(root, {
    env: s.env,
    homeDir: s.home,
    notice: (line) => notices.push(line),
  });
  assert.deepEqual(again.added, []);
  assert.equal(notices.length, 1);
  assert.equal(readFileSync(file, "utf8"), `${ALL.join("\n")}\n`);
  assert.equal(existsSync(join(s.home, ".config")), false, "没有碰家目录");
});

test("已有的行不重复、没有末尾换行的先补换行；项目自己已忽略的不写（旧仓库的 .pigeon/.gitignore 只缺工作树一行）", () => {
  const s = sandbox();
  const root = repo(s.env);
  const file = join(s.xdg, "git", "ignore");
  mkdirSync(join(s.xdg, "git"), { recursive: true });
  writeFileSync(file, "*.log\n**/.pigeon/settings.local.json");
  // 旧仓库：.pigeon/.gitignore 已忽略 state/ 与 settings.local.json
  mkdirSync(join(root, ".pigeon"));
  writeFileSync(join(root, ".pigeon", ".gitignore"), "state/\nsettings.local.json\n");
  const result = ensureGlobalIgnoreRules(root, { env: s.env, homeDir: s.home });
  assert.deepEqual(result.added, ["**/.pigeon/worktrees/"]);
  assert.equal(
    readFileSync(file, "utf8"),
    "*.log\n**/.pigeon/settings.local.json\n**/.pigeon/worktrees/\n"
  );
});

test("不是 git 仓库：什么都不写", () => {
  const s = sandbox();
  const plain = temp("pigeon-gi-plain-");
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(plain, {
    env: s.env,
    homeDir: s.home,
    notice: (line) => notices.push(line),
  });
  assert.equal(result.skipped, "not-git");
  assert.equal(existsSync(join(s.xdg, "git")), false);
  assert.deepEqual(notices, []);
});

test("全局排除文件的取法：core.excludesFile 为绝对路径、~ 开头时用它；相对路径与未设时用 XDG；未设 XDG 用 ~/.config/git/ignore", () => {
  const s = sandbox();
  const root = repo(s.env);
  const absolute = join(s.base, "custom", "excludes");
  execFileSync("git", ["config", "--global", "core.excludesFile", absolute], {
    cwd: root,
    env: s.env,
  });
  assert.equal(globalExcludesFile(root, { env: s.env, homeDir: s.home }), absolute);
  execFileSync("git", ["config", "--global", "core.excludesFile", "~/my-excludes"], {
    cwd: root,
    env: s.env,
  });
  assert.equal(
    globalExcludesFile(root, { env: s.env, homeDir: s.home }),
    join(s.home, "my-excludes")
  );
  execFileSync("git", ["config", "--global", "core.excludesFile", "relative/excludes"], {
    cwd: root,
    env: s.env,
  });
  assert.equal(
    globalExcludesFile(root, { env: s.env, homeDir: s.home }),
    join(s.xdg, "git", "ignore")
  );
  execFileSync("git", ["config", "--global", "--unset", "core.excludesFile"], {
    cwd: root,
    env: s.env,
  });
  assert.equal(
    globalExcludesFile(root, { env: s.env, homeDir: s.home }),
    join(s.xdg, "git", "ignore")
  );
  const noXdg = sandbox({ xdg: false });
  assert.equal(
    globalExcludesFile(root, { env: noXdg.env, homeDir: noXdg.home }),
    join(noXdg.home, ".config", "git", "ignore")
  );
});

test("core.excludesFile 指向的文件：规则写进去且 git 认得", () => {
  const s = sandbox();
  const root = repo(s.env);
  const absolute = join(s.base, "custom", "excludes");
  execFileSync("git", ["config", "--global", "core.excludesFile", absolute], {
    cwd: root,
    env: s.env,
  });
  const result = ensureGlobalIgnoreRules(root, { env: s.env, homeDir: s.home });
  assert.equal(result.file, absolute);
  assert.equal(readFileSync(absolute, "utf8"), `${ALL.join("\n")}\n`);
  assert.equal(ignored(root, s.env, ".pigeon/state/x"), true);
  assert.equal(existsSync(join(s.xdg, "git")), false);
});

test("写不进（目标位置是个目录）：只提示一行，不抛", () => {
  const s = sandbox();
  const root = repo(s.env);
  mkdirSync(join(s.xdg, "git", "ignore"), { recursive: true });
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(root, {
    env: s.env,
    homeDir: s.home,
    notice: (line) => notices.push(line),
  });
  assert.ok(result.error !== undefined);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /没能把 Pigeon 程序状态的忽略规则写进 git 全局排除文件/);
});

test("同一进程同一目录只做一次；ensureProjectStateDir 建目录并确保规则；ensureStateDirOf 找到所属的根，用户级目录不动", () => {
  const s = sandbox();
  const root = repo(s.env);
  const file = join(s.xdg, "git", "ignore");
  const previous = { xdg: process.env.XDG_CONFIG_HOME, global: process.env.GIT_CONFIG_GLOBAL };
  process.env.XDG_CONFIG_HOME = s.env.XDG_CONFIG_HOME;
  process.env.GIT_CONFIG_GLOBAL = s.env.GIT_CONFIG_GLOBAL;
  try {
    ensureStateDirOf(join(root, ".pigeon", "state", "search-cache"), undefined, s.home);
    assert.ok(existsSync(join(root, ".pigeon", "state")));
    assert.equal(readFileSync(file, "utf8"), `${ALL.join("\n")}\n`);
    // 记过一次：删掉文件后同一进程不再写
    rmSync(file);
    ensureProjectStateDir(root);
    ensureGlobalIgnoreRulesOnce(root);
    assert.equal(existsSync(file), false);
    // 用户级：家目录下的 .pigeon/state 只当普通目录，不跑忽略规则
    const homeRepo = repo(s.env);
    ensureStateDirOf(join(homeRepo, ".pigeon", "state", "memory.md"), undefined, homeRepo);
    assert.equal(existsSync(file), false);
    // 不在 .pigeon/state 之下的路径不动
    ensureStateDirOf(join(root, "elsewhere", "x"), undefined, s.home);
    assert.equal(existsSync(join(root, "elsewhere")), false);
  } finally {
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    if (previous.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous.global;
  }
});
