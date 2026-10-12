// 程序状态的忽略规则写进全局 git 排除文件（决策 444、445）：全局配置、XDG 目录与 HOME 一律指到临时目录，绝不碰真实用户目录。
// 非 git 不写；缺哪行补哪行、已有的不重复；已被项目规则忽略的不写；core.excludesFile 的取法与 git 实际读的一致（include、
// ~ 按 HOME 展开）；相对路径只提示不写；写完复核、没生效如实提示；写不进只提示不抛；同一进程同一目录只做一次，
// 第一次没带提示口时提示补发给之后带提示口的调用。
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
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import { GLOBAL_IGNORE_ENTRIES } from "../state/paths.ts";
import {
  ensureGlobalIgnoreRules,
  ensureGlobalIgnoreRulesOnce,
  globalExcludesFile,
  globalExcludesLocation,
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

// 隔离的 git 环境：空的全局配置、临时 XDG、临时 HOME
function sandbox(options: { xdg?: boolean } = {}) {
  const base = temp("pigeon-gi-env-");
  const home = join(base, "home");
  const xdg = join(base, "xdg");
  mkdirSync(home);
  mkdirSync(xdg);
  const globalConfig = join(base, "gitconfig");
  writeFileSync(globalConfig, "");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, HOME: home };
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

function gitConfig(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): void {
  execFileSync("git", ["config", "--global", ...args], { cwd, env });
}

const ALL = GLOBAL_IGNORE_ENTRIES.map((entry) => entry.rule);

test("git 仓库里三行都缺：写进 $XDG_CONFIG_HOME/git/ignore，提示一行；之后程序状态被忽略；再调一次不重复", () => {
  const s = sandbox();
  const root = repo(s.env);
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(root, {
    env: s.env,
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
  const again = ensureGlobalIgnoreRules(root, { env: s.env, notice: (line) => notices.push(line) });
  assert.deepEqual(again.added, []);
  assert.equal(notices.length, 1);
  assert.equal(readFileSync(file, "utf8"), `${ALL.join("\n")}\n`);
  assert.equal(existsSync(join(s.home, ".config")), false, "没有碰 HOME");
});

test("已有的行不重复、没有末尾换行的先补换行、CRLF 的已有文件照样认；项目自己已忽略的不写（旧仓库只缺工作树一行）", () => {
  const s = sandbox();
  const root = repo(s.env);
  const file = join(s.xdg, "git", "ignore");
  mkdirSync(join(s.xdg, "git"), { recursive: true });
  writeFileSync(file, "*.log\r\n**/.pigeon/settings.local.json");
  mkdirSync(join(root, ".pigeon"));
  writeFileSync(join(root, ".pigeon", ".gitignore"), "state/\nsettings.local.json\n");
  const result = ensureGlobalIgnoreRules(root, { env: s.env });
  assert.deepEqual(result.added, ["**/.pigeon/worktrees/"]);
  assert.equal(
    readFileSync(file, "utf8"),
    "*.log\r\n**/.pigeon/settings.local.json\n**/.pigeon/worktrees/\n"
  );
  // 已有的那行在 CRLF 文件里：缺它时也不重复写
  rmSync(join(root, ".pigeon", ".gitignore"));
  writeFileSync(
    file,
    "**/.pigeon/state/\r\n**/.pigeon/settings.local.json\r\n**/.pigeon/worktrees/\r\n"
  );
  assert.deepEqual(ensureGlobalIgnoreRules(root, { env: s.env }).added, []);
});

test("不是 git 仓库：什么都不写", () => {
  const s = sandbox();
  const plain = temp("pigeon-gi-plain-");
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(plain, {
    env: s.env,
    notice: (line) => notices.push(line),
  });
  assert.equal(result.skipped, "not-git");
  assert.equal(existsSync(join(s.xdg, "git")), false);
  assert.deepEqual(notices, []);
});

test("全局排除文件的取法：绝对路径用它；~ 开头按 HOME 展开（git 的取法）；没设时用 XDG；未设 XDG 用 $HOME/.config/git/ignore；相对路径为位置不明", () => {
  const s = sandbox();
  const root = repo(s.env);
  const absolute = join(s.base, "custom", "excludes");
  gitConfig(s.env, root, "core.excludesFile", absolute);
  assert.equal(resolve(globalExcludesFile(root, { env: s.env }) ?? ""), absolute);
  gitConfig(s.env, root, "core.excludesFile", "~/my-excludes");
  assert.equal(
    resolve(globalExcludesFile(root, { env: s.env }) ?? ""),
    join(s.home, "my-excludes")
  );
  gitConfig(s.env, root, "core.excludesFile", "relative/excludes");
  assert.deepEqual(globalExcludesLocation(root, { env: s.env }), {
    kind: "relative",
    value: "relative/excludes",
  });
  assert.equal(globalExcludesFile(root, { env: s.env }), undefined);
  gitConfig(s.env, root, "--unset", "core.excludesFile");
  assert.equal(globalExcludesFile(root, { env: s.env }), join(s.xdg, "git", "ignore"));
  const noXdg = sandbox({ xdg: false });
  assert.equal(
    globalExcludesFile(root, { env: noXdg.env }),
    join(noXdg.home, ".config", "git", "ignore")
  );
});

test("core.excludesFile 设在 include 进来的配置里：跟着 include 写到 git 实际读的文件，且 git 认得", () => {
  const s = sandbox();
  const root = repo(s.env);
  const local = join(s.base, "local.gitconfig");
  const target = join(s.base, "custom", "excludes");
  writeFileSync(local, `[core]\n\texcludesFile = ${target.replaceAll("\\", "/")}\n`);
  writeFileSync(s.globalConfig, `[include]\n\tpath = ${local.replaceAll("\\", "/")}\n`);
  const result = ensureGlobalIgnoreRules(root, { env: s.env });
  assert.equal(resolve(result.file ?? ""), target);
  assert.equal(readFileSync(target, "utf8"), `${ALL.join("\n")}\n`);
  assert.equal(ignored(root, s.env, ".pigeon/state/x"), true);
  assert.equal(existsSync(join(s.xdg, "git")), false);
});

test("相对路径的 core.excludesFile：不写任何文件，提示自行加入", () => {
  const s = sandbox();
  const root = repo(s.env);
  gitConfig(s.env, root, "core.excludesFile", "relative/excludes");
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(root, {
    env: s.env,
    notice: (line) => notices.push(line),
  });
  assert.equal(result.error, "relative");
  assert.equal(existsSync(join(s.xdg, "git")), false);
  assert.equal(existsSync(join(root, "relative")), false);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /相对路径.*没有写入；请自行把/);
});

test("写进去了 git 却没有忽略（仓库里有取反规则）：如实提示，再调也不重复写", () => {
  const s = sandbox();
  const root = repo(s.env);
  writeFileSync(join(root, ".gitignore"), "!.pigeon/\n!.pigeon/**\n");
  const notices: string[] = [];
  const first = ensureGlobalIgnoreRules(root, { env: s.env, notice: (line) => notices.push(line) });
  assert.equal(first.error, "ineffective");
  assert.match(notices[0] ?? "", /git 仍没有忽略/);
  const file = join(s.xdg, "git", "ignore");
  const second = ensureGlobalIgnoreRules(root, {
    env: s.env,
    notice: (line) => notices.push(line),
  });
  assert.deepEqual(second.added, []);
  assert.equal(readFileSync(file, "utf8"), `${ALL.join("\n")}\n`);
});

test("写不进（目标位置是个目录）：只提示一行（带自行加入的说明），不抛", () => {
  const s = sandbox();
  const root = repo(s.env);
  mkdirSync(join(s.xdg, "git", "ignore"), { recursive: true });
  const notices: string[] = [];
  const result = ensureGlobalIgnoreRules(root, {
    env: s.env,
    notice: (line) => notices.push(line),
  });
  assert.ok(result.error !== undefined);
  assert.equal(notices.length, 1);
  assert.match(
    notices[0] ?? "",
    /没能把 Pigeon 程序状态的忽略规则写进 git 全局排除文件.*可自行加入/
  );
});

// 在本进程的环境下跑（ensureGlobalIgnoreRulesOnce 与 ensureProjectStateDir 不带 env）
function withEnv<T>(env: NodeJS.ProcessEnv, body: () => T): T {
  const keys = ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "HOME"] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return body();
  } finally {
    keys.forEach((key, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

test("同一进程同一目录只做一次；第一次没带提示口时，提示补发给之后第一个带提示口的调用（终端界面先写输入历史的情形）", () => {
  const s = sandbox();
  const root = repo(s.env);
  const file = join(s.xdg, "git", "ignore");
  withEnv(s.env, () => {
    // 第一次：输入历史一类的写入点不带提示口
    ensureStateDirOf(join(root, ".pigeon", "state", "tui-history.json"), undefined, s.home);
    assert.ok(existsSync(join(root, ".pigeon", "state")));
    assert.equal(readFileSync(file, "utf8"), `${ALL.join("\n")}\n`);
    // 之后建会话文件时带提示口：补发那一行，且只补一次
    const notices: string[] = [];
    ensureProjectStateDir(root, (line) => notices.push(line));
    ensureProjectStateDir(root, (line) => notices.push(line));
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /已在 git 全局排除文件/);
    rmSync(file);
    ensureGlobalIgnoreRulesOnce(root);
    assert.equal(existsSync(file), false, "记过一次：同一进程不再写");
    // 用户级：HOME 下的 .pigeon/state 只当普通目录，不跑忽略规则
    const homeRepo = repo(s.env);
    ensureStateDirOf(join(homeRepo, ".pigeon", "state", "memory.md"), undefined, homeRepo);
    assert.equal(existsSync(file), false);
    // 不在 .pigeon/state 之下的路径不动
    ensureStateDirOf(join(root, "elsewhere", "x"), undefined, s.home);
    assert.equal(existsSync(join(root, "elsewhere")), false);
  });
});
