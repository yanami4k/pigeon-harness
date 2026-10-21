// 决策 496：/clear 原地换新对话、/new [path] 在 path 开新会话——装配方（main.ts）建好新会话核，壳换绑过去；旧的当前会话还在
// 干活时由装配方退到面板接着跑（不在本文件覆盖，那一段在 main.ts）。本文件断言壳这一侧：命令分发、用法、交给装配方的请求、
// 没有入口时与沙箱里的如实说明、换绑后会话号与花费换成新会话的；另测 /new 的路径解析（~ 展开、不存在报错、不建目录）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { SLASH_COMMANDS } from "./command-table.ts";
import type { NewSessionRequest } from "./commands.ts";
import { launchPlaceOf, newSessionDir, newSessionPlace } from "./new-session-dir.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function recording() {
  const requests: NewSessionRequest[] = [];
  const nextId = newSessionId();
  return {
    requests,
    nextId,
    newSession: {
      create: async (request: NewSessionRequest) => {
        requests.push(request);
        return { sessionId: nextId, binding: { runtime: new ScriptedRuntime(nextId) } };
      },
    },
  };
}

async function submit(term: MockTerminal, line: string): Promise<void> {
  term.input(line);
  term.input("\r");
  await settle(200);
}

function makeShell(extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-new-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 24);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, ...extra });
  shell.start();
  return {
    shell,
    term,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("命令表：/clear 与 /new [path] 运行中可用、作用于当前会话", () => {
  for (const [name, usage] of [
    ["clear", "/clear"],
    ["new", "/new [path]"],
  ] as const) {
    const spec = SLASH_COMMANDS.find((entry) => entry.name === name);
    assert.ok(spec !== undefined, `/${name} 应在命令表里`);
    assert.equal(spec.usage, usage);
    assert.equal(spec.whileRunning.allow, true);
    assert.equal(spec.scope, "session");
  }
  assert.equal(
    SLASH_COMMANDS.some((entry) => entry.name === "move"),
    false,
    "/move 已删除"
  );
});

test("/new：换到装配方建好的新会话；不给 path 即交给装配方按项目根开", async () => {
  const rec = recording();
  const { shell, term, cleanup } = makeShell({ newSession: rec.newSession });
  try {
    await settle();
    await submit(term, "/new");
    assert.deepEqual(rec.requests, [{ kind: "new" }]);
    assert.equal(shell.sessionId(), rec.nextId);
  } finally {
    cleanup();
  }
});

test("/new <path>：path 原样交给装配方（可以有空格）", async () => {
  const rec = recording();
  const { term, cleanup } = makeShell({ newSession: rec.newSession });
  try {
    await settle();
    await submit(term, "/new ~/code/my app");
    assert.deepEqual(rec.requests, [{ kind: "new", path: "~/code/my app" }]);
  } finally {
    cleanup();
  }
});

test("/clear：原地换新对话；给了参数即写用法，不建会话", async () => {
  const rec = recording();
  const { shell, term, cleanup } = makeShell({ newSession: rec.newSession });
  try {
    await settle();
    await submit(term, "/clear 多余");
    assert.equal(rec.requests.length, 0);
    assert.match(screenText(term), /usage: \/clear/);
    await submit(term, "/clear");
    assert.deepEqual(rec.requests, [{ kind: "clear" }]);
    assert.equal(shell.sessionId(), rec.nextId);
  } finally {
    cleanup();
  }
});

test("装配方开不成（路径不对等）：写一行报错，留在原会话", async () => {
  const { shell, term, cleanup } = makeShell({
    newSession: {
      create: async () => {
        throw new Error("no such directory: ~/nowhere");
      },
    },
  });
  try {
    await settle();
    const before = shell.sessionId();
    await submit(term, "/new ~/nowhere");
    assert.match(screenText(term), /no such directory: ~\/nowhere/);
    assert.equal(shell.sessionId(), before);
  } finally {
    cleanup();
  }
});

test("没有入口时如实说明（不当成未知命令）", async () => {
  const { term, cleanup } = makeShell();
  try {
    await settle();
    await submit(term, "/new");
    assert.match(screenText(term), /\/new is not available in this session/);
    await submit(term, "/clear");
    assert.match(screenText(term), /\/clear is not available in this session/);
  } finally {
    cleanup();
  }
});

test("沙箱会话里 /clear 与 /new 不可用（同 /resume），一句英文说明", async () => {
  const rec = recording();
  const { term, cleanup } = makeShell({
    newSession: rec.newSession,
    sandbox: { exportChanges: async () => "" },
  });
  try {
    await settle();
    await submit(term, "/new");
    await submit(term, "/clear");
    assert.equal(rec.requests.length, 0);
    const screen = screenText(term);
    assert.match(screen, /\/new not available in the sandbox/);
    assert.match(screen, /\/clear not available in the sandbox/);
  } finally {
    cleanup();
  }
});

test("/new 的路径：~ 展开、相对当前工作目录解析；不存在或不是目录即报错，不建目录", () => {
  const base = mkdtempSync(join(tmpdir(), "pigeon-new-dir-"));
  try {
    const home = join(base, "home");
    const cwd = join(base, "cwd");
    mkdirSync(join(home, "code", "myapp"), { recursive: true });
    mkdirSync(join(cwd, "packages", "web"), { recursive: true });
    writeFileSync(join(cwd, "notes.txt"), "x");
    assert.equal(newSessionDir(cwd, "~", home), home);
    assert.equal(newSessionDir(cwd, "~/code/myapp", home), join(home, "code", "myapp"));
    assert.equal(newSessionDir(cwd, "~\\code\\myapp", home), join(home, "code", "myapp"));
    // Tab 补全给带空格的路径加了引号
    mkdirSync(join(cwd, "my app"));
    assert.equal(newSessionDir(cwd, '"my app/"', home), join(cwd, "my app"));
    assert.equal(newSessionDir(cwd, "packages/web", home), join(cwd, "packages", "web"));
    assert.throws(() => newSessionDir(cwd, "missing", home), /no such directory: .*missing/);
    assert.equal(existsSync(join(cwd, "missing")), false, "不建目录");
    assert.throws(() => newSessionDir(cwd, "notes.txt", home), /not a directory: .*notes\.txt/);
    // 与启动时同一套：项目根就是那个目录，工作目录同它
    const place = launchPlaceOf(join(cwd, "packages", "web"));
    assert.equal(place.root, realpathSync(join(cwd, "packages", "web")));
    assert.equal(place.workspace, place.root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("新会话的位置：/clear 工作目录不变；/new 不给 path 即项目根；path 在本仓库的工作树里（含子目录）归主检出这个项目", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pigeon-new-place-")));
  try {
    const repo = join(base, "myapp");
    mkdirSync(repo);
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "."]);
    git(repo, ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    const tree = join(repo, ".pigeon", "trees", "feature-x");
    git(repo, ["worktree", "add", "-q", "-b", "pigeon/feature-x", tree]);
    mkdirSync(join(tree, "packages", "web"), { recursive: true });
    const previous = { root: repo, workspace: tree };
    assert.deepEqual(newSessionPlace({ kind: "clear" }, previous, base), previous);
    assert.deepEqual(newSessionPlace({ kind: "new" }, previous, base), {
      root: repo,
      workspace: repo,
    });
    // 树里的子目录：项目仍是主检出，工作目录是那个子目录
    const inTree = newSessionPlace({ kind: "new", path: "packages/web" }, previous, base);
    assert.equal(inTree.root, realpathSync(repo));
    assert.equal(inTree.workspace, realpathSync(join(tree, "packages", "web")));
    // 启动时同一套：在树里启动即归主检出；沙箱会话不认工作树
    assert.equal(launchPlaceOf(tree).root, realpathSync(repo));
    assert.equal(launchPlaceOf(tree, { trees: false }).root, realpathSync(tree));
    // 不在工作树里的目录：项目根就是那个目录
    const other = join(base, "other");
    mkdirSync(other);
    assert.deepEqual(newSessionPlace({ kind: "new", path: other }, previous, base), {
      root: realpathSync(other),
      workspace: realpathSync(other),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
