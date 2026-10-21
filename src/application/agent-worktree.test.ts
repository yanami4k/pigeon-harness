// 子 agent 的临时工作树（决策 480、486、494）：名字撞了让路（<名字>-2…），起点快照引用与树同名、写读删用同一个名字；
// 关掉时没有改动即删（连同分支与起点引用），别人还持着在用标记的不删。另测面板派出时从缺省显示名派生树名的清洗（审计 9）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, test } from "vitest";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import { newSessionId } from "../state/ids.ts";
import { worktreesDirOf } from "../state/paths.ts";
import { agentWorktreeAt, closeAgentWorktree, openAgentWorktree } from "./agent-worktree.ts";
import { assertWorktreeName, worktreeNameFrom } from "./named-worktree.ts";
import { defaultSessionName } from "./session-name.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function repo(): string {
  const dir = temp("pigeon-agent-wt-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  return dir;
}

test("同名子 agent 的树让路成 <名字>-2；起点快照引用与树同名，取回时读得到；关掉时连同分支与引用删掉", () => {
  const root = repo();
  const home = temp("pigeon-agent-home-");
  // 派出方有未提交的改动：起点快照里带着它
  writeFileSync(join(root, "a.txt"), "dirty\n");
  const first = openAgentWorktree({
    parentWorkspace: root,
    governanceRoot: root,
    sessionId: newSessionId(),
    name: "Fixer",
    homeDir: home,
  });
  const second = openAgentWorktree({
    parentWorkspace: root,
    governanceRoot: root,
    sessionId: newSessionId(),
    name: "fixer",
    homeDir: home,
  });
  assert.equal(first.path, join(worktreesDirOf(root), "fixer"));
  assert.equal(second.path, join(worktreesDirOf(root), "fixer-2"), "撞名让路");
  assert.equal(second.branch, "pigeon/fixer-2");
  for (const tree of [first, second]) {
    const name = basename(tree.path);
    assert.equal(git(root, ["rev-parse", `refs/pigeon/worker-start/${name}`]), tree.base);
    const lookup = agentWorktreeAt({ workspace: tree.path, sessionId: "x" });
    assert.ok(lookup.ok);
    assert.equal(lookup.ok && lookup.base, tree.base, "取回按同名的起点引用读");
  }
  assert.equal(closeAgentWorktree(first, false), false, "没有改动即删");
  assert.equal(git(root, ["branch", "--list", "pigeon/fixer"]), "");
  assert.equal(git(root, ["for-each-ref", "refs/pigeon/worker-start/fixer"]), "", "起点引用一并删");
  assert.notEqual(git(root, ["for-each-ref", "refs/pigeon/worker-start/fixer-2"]), "");
  assert.equal(closeAgentWorktree(second, false), false);
  assert.equal(git(root, ["for-each-ref", "refs/pigeon/worker-start/"]), "");
});

test("关掉时别人还持着这棵树的在用标记（同名的树被别的会话打开了）：不删", () => {
  const root = repo();
  const home = temp("pigeon-agent-home-");
  const tree = openAgentWorktree({
    parentWorkspace: root,
    governanceRoot: root,
    sessionId: newSessionId(),
    name: "busy",
    homeDir: home,
  });
  const other = holdWorktreeInUse(tree.path, home);
  try {
    assert.equal(closeAgentWorktree(tree, false), true, "在用即保留");
    assert.match(git(root, ["branch", "--list", "pigeon/busy"]), /pigeon\/busy/);
  } finally {
    other();
  }
});

test("面板派出的树名从缺省显示名派生：小写、别的字符换成 -、去掉开头的 - 与 _，为空用 session", () => {
  const id = newSessionId();
  const tail = id.slice(-4).toLowerCase();
  const cases: Array<[string, string]> = [
    ["my.app", `my-app-${tail}`],
    ["中文目录", tail],
    ["_tmp", `tmp-${tail}`],
  ];
  for (const [dir, expected] of cases) {
    const name = worktreeNameFrom(defaultSessionName(join(tmpdir(), dir), id));
    assert.equal(name, expected, dir);
    assert.doesNotThrow(() => assertWorktreeName(name), dir);
  }
  assert.equal(worktreeNameFrom("..."), "session");
  assert.equal(worktreeNameFrom("_"), "session");
});

test("上一棵同名的树被人手删、留下了取回起点与起点引用：新树不接手，取回按这次派出的起点", () => {
  const root = repo();
  const home = temp("pigeon-agent-home-");
  const old = git(root, ["rev-parse", "HEAD"]);
  // 手删留下的同名引用（指向一个与新树无关的提交）
  git(root, ["update-ref", "refs/pigeon/agent/stale", old]);
  git(root, ["update-ref", "refs/pigeon/panel/stale", old]);
  writeFileSync(join(root, "a.txt"), "newer\n");
  git(root, ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-qam", "newer"]);
  const tree = openAgentWorktree({
    parentWorkspace: root,
    governanceRoot: root,
    sessionId: newSessionId(),
    name: "stale",
    homeDir: home,
  });
  assert.equal(git(root, ["for-each-ref", "refs/pigeon/agent/", "refs/pigeon/panel/"]), "");
  const lookup = agentWorktreeAt({ workspace: tree.path, sessionId: "x" });
  assert.ok(lookup.ok);
  assert.equal(lookup.ok && lookup.base, tree.base);
  assert.notEqual(tree.base, old);
  closeAgentWorktree(tree, false);
});
