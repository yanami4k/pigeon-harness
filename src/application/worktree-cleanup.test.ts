// 留下的工作树的列出与删除（决策 448）：真实 git 仓库上核对三类条目、所属会话、在用、未取走的改动与旧命名；挑选规则
//（缺省只挑没有可丢东西的、--all、点名、在用不挑）；终端界面的二次确认；命令行没有终端时须 --yes。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { addWorktree } from "../orchestration/worktree.ts";
import { sessionFileLockPath } from "../persistence/session-lock.ts";
import { sessionDirectoryName, sessionFileName } from "../persistence/session-reader.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  createTuiWorktreesFace,
  formatLeftoverList,
  isGitWorkspace,
  type LeftoverWorktree,
  listLeftoverWorktrees,
  planClean,
  runWorktreesCommand,
} from "./worktree-cleanup.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-clean-")));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

// worker 会话文件：只写文件头（所属会话从这里读）；locked 时写一把本进程持有的锁（算在用）
function writeWorkerSession(
  repo: string,
  workerId: SessionId,
  parentId: SessionId,
  locked = false
): void {
  const dir = join(sessionsDirOf(repo), sessionDirectoryName(repo));
  mkdirSync(dir, { recursive: true });
  const createdAt = Date.now();
  const file = join(dir, sessionFileName(createdAt, workerId));
  writeFileSync(
    file,
    `${JSON.stringify({ kind: "header", version: 4, id: workerId, createdAt, cwd: repo, parentSessionId: parentId })}\n`
  );
  if (locked) {
    writeFileSync(
      sessionFileLockPath(file),
      `${JSON.stringify({ pid: process.pid, acquiredAt: 0 })}\n`
    );
  }
}

function fixture() {
  const repo = makeRepo();
  const parent = newSessionId();
  // 1. 有未取走的改动
  const dirtyId = newSessionId();
  const dirty = addWorktree({ repoRoot: repo, sessionId: dirtyId, name: "dirty" });
  writeFileSync(join(dirty.path, "a.txt"), "worker\n");
  writeWorkerSession(repo, dirtyId, parent);
  // 2. 改动已叠回主工作目录（内容一致）
  const takenId = newSessionId();
  const taken = addWorktree({ repoRoot: repo, sessionId: takenId, name: "taken" });
  writeFileSync(join(taken.path, "n.txt"), "same\n");
  writeFileSync(join(repo, "n.txt"), "same\n");
  writeWorkerSession(repo, takenId, parent);
  // 3. 在跑
  const busyId = newSessionId();
  const busy = addWorktree({ repoRoot: repo, sessionId: busyId, name: "busy" });
  writeWorkerSession(repo, busyId, parent, true);
  // 4. 旧命名的工作树（分支 pigeon/<名字>），没有会话文件
  const legacyId = newSessionId();
  const legacyPath = join(repo, ".pigeon", "state", "worktrees", `${legacyId}-old`);
  git(repo, ["worktree", "add", "-q", "-b", "pigeon/old", legacyPath]);
  // 5. 只剩分支：旧分支（无提交）与有新提交的
  git(repo, ["branch", "pigeon/stale"]);
  git(repo, ["branch", "pigeon/ahead"]);
  git(repo, ["checkout", "-q", "pigeon/ahead"]);
  writeFileSync(join(repo, "c.txt"), "c\n");
  git(repo, ["add", "c.txt"]);
  git(repo, ["commit", "-q", "-m", "ahead"]);
  git(repo, ["checkout", "-q", "main"]);
  // 6. git 不认的残留目录
  mkdirSync(join(repo, ".pigeon", "state", "worktrees", "junk"), { recursive: true });
  writeFileSync(join(repo, ".pigeon", "state", "worktrees", "junk", "x"), "12345");
  return { repo, parent, dirty, taken, busy, legacyPath };
}

function byName(items: readonly LeftoverWorktree[], name: string): LeftoverWorktree {
  const item = items.find((entry) => entry.name === name);
  assert.ok(item, `${name}: ${JSON.stringify(items.map((entry) => entry.name))}`);
  return item;
}

test("列出：三类条目、所属会话、在用、未取走的改动、旧命名与占用", () => {
  const f = fixture();
  const items = listLeftoverWorktrees({ workspaceRoot: f.repo });
  assert.deepEqual(items.map((item) => item.name).sort(), [
    "ahead",
    "busy",
    "dirty",
    "junk",
    "old",
    "stale",
    "taken",
  ]);
  const dirty = byName(items, "dirty");
  assert.equal(dirty.kind, "worktree");
  assert.equal(dirty.ownerSessionId, f.parent);
  assert.equal(dirty.untaken, 1);
  assert.equal(dirty.legacy, false);
  assert.ok(dirty.bytes > 0);
  assert.equal(byName(items, "taken").untaken, 0, "内容已与主工作目录一致");
  assert.equal(byName(items, "busy").inUse, true);
  const old = byName(items, "old");
  assert.equal(old.legacy, true);
  assert.equal(old.ownerSessionId, undefined);
  assert.equal(old.untaken, 0);
  assert.equal(byName(items, "stale").kind, "branch-only");
  assert.equal(byName(items, "stale").untaken, 0);
  assert.equal(byName(items, "ahead").untaken, "commits");
  assert.equal(byName(items, "junk").kind, "orphan-dir");
  const text = formatLeftoverList(items);
  assert.match(text, /留下的 worker 工作树与分支（7 项）/);
  assert.match(text, /dirty .*未取走的改动 1 个文件/);
  assert.match(text, /old（旧命名）/);
  assert.match(text, /stale（旧命名） {2}分支 pigeon\/stale（工作树已不在）/);
  assert.match(text, /busy .*在用（worker 在跑），不能删/);
});

test("挑选：缺省只挑没有可丢东西且不在用的；--all 挑全部不在用的；点名照挑；在用的、不认得的列为不删", () => {
  const f = fixture();
  const items = listLeftoverWorktrees({ workspaceRoot: f.repo });
  const names = (plan: { remove: LeftoverWorktree[] }) =>
    plan.remove.map((item) => item.name).sort();
  assert.deepEqual(names(planClean(items, [])), ["old", "stale", "taken"]);
  assert.deepEqual(names(planClean(items, ["--all"])), [
    "ahead",
    "dirty",
    "junk",
    "old",
    "stale",
    "taken",
  ]);
  const index = items.findIndex((item) => item.name === "dirty") + 1;
  const named = planClean(items, [String(index), "busy", "nope"]);
  assert.deepEqual(names(named), ["dirty"]);
  assert.deepEqual(named.refused, ["busy：在用（worker 在跑），不删", "nope：没有这一项"]);
});

test("终端界面 /worktrees：clean 先给清单并写明会丢的改动，confirm 才删；中间打别的 /worktrees 即作罢", () => {
  const f = fixture();
  const face = createTuiWorktreesFace({ workspaceRoot: f.repo });
  assert.match(face.run([]), /删除：\/worktrees clean/);
  const plan = face.run(["clean", "dirty"]);
  assert.match(plan, /dirty（pigeon\/[0-9a-z]{8}-dirty）——未取走的改动 1 个文件，删除后丢失/);
  assert.match(plan, /\/worktrees confirm/);
  assert.ok(existsSync(f.dirty.path), "确认之前不删");
  face.run(["list"]);
  assert.match(face.run(["confirm"]), /没有待确认的删除/);
  face.run(["clean", "dirty"]);
  assert.match(face.run(["confirm"]), /已删除 1 项：dirty/);
  assert.equal(existsSync(f.dirty.path), false);
  assert.equal(git(f.repo, ["branch", "--list", f.dirty.branch]), "");
  // 缺省清理：没有可丢东西的三项
  face.run(["clean"]);
  assert.match(face.run(["confirm"]), /已删除 3 项/);
  assert.equal(existsSync(f.taken.path), false);
  assert.equal(existsSync(f.legacyPath), false);
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/old"]), "");
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/stale"]), "");
  assert.ok(existsSync(f.busy.path), "在用的不动");
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/ahead"]), "pigeon/ahead");
  assert.match(face.run(["clean", "--bogus"]), /未知参数/);
});

test("命令行 pigeon worktrees：list 列出；clean 没有终端时不删、提示加 --yes；--yes 直接删；确认被拒即不删", async () => {
  const f = fixture();
  const scope = { workspaceRoot: f.repo };
  assert.match(await runWorktreesCommand(["list"], scope), /pigeon worktrees clean/);
  assert.match(await runWorktreesCommand(["clean", "--all"], scope), /加 --yes/);
  assert.ok(existsSync(f.dirty.path));
  assert.match(
    await runWorktreesCommand(["clean", "--all"], scope, async () => false),
    /已取消，没有删除/
  );
  assert.ok(existsSync(f.dirty.path));
  const done = await runWorktreesCommand(["clean", "--all", "--yes"], scope);
  assert.match(done, /删除后丢失/);
  assert.match(done, /已删除 6 项/);
  assert.equal(existsSync(f.dirty.path), false);
  assert.equal(existsSync(join(f.repo, ".pigeon", "state", "worktrees", "junk")), false);
  assert.ok(existsSync(f.busy.path));
  assert.match(await runWorktreesCommand(["list"], scope), /（1 项）/);
  await assert.rejects(runWorktreesCommand(["nope"], scope), /用法/);
});

test("没有留下的：列出一句；不是 git 仓库时 /worktrees 不提供", () => {
  const repo = makeRepo();
  assert.equal(
    formatLeftoverList(listLeftoverWorktrees({ workspaceRoot: repo })),
    "没有留下的 worker 工作树与分支"
  );
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-plain-")));
  dirs.push(plain);
  assert.equal(isGitWorkspace(repo), true);
  assert.equal(isGitWorkspace(plain), false);
});
