// 留下的工作树的列出与删除（决策 448）：真实 git 仓库上核对三类条目、所属会话、在用、未取走的改动与旧命名；挑选规则
//（缺省只挑没有可丢东西的、--all、点名、在用不挑）；终端界面的二次确认；命令行没有终端时须 --yes。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { addWorktree } from "../orchestration/worktree.ts";
import { sessionFileLockPath } from "../persistence/session-lock.ts";
import { sessionDirectoryName, sessionFileName } from "../persistence/session-reader.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
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
  WorktreeCleanupError,
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
  return { repo, parent, dirty, dirtyId, taken, busy, legacyPath };
}

// 夹具里的工作树都是刚建的：按"刚建、还没有 worker 会话记录"会算在用；用晚一小时的时钟看它们
const later = () => Date.now() + 3_600_000;

function byName(items: readonly LeftoverWorktree[], name: string): LeftoverWorktree {
  const item = items.find((entry) => entry.name === name);
  assert.ok(item, `${name}: ${JSON.stringify(items.map((entry) => entry.name))}`);
  return item;
}

test("列出：三类条目、所属会话、在用、未取走的改动、旧命名与占用", () => {
  const f = fixture();
  const items = listLeftoverWorktrees({ workspaceRoot: f.repo, now: later });
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
  assert.match(text, /leftover worktrees and branches \(7\)/);
  assert.match(text, /dirty .*untaken changes: 1 file/);
  assert.match(text, /old \(old naming\)/);
  assert.match(text, /stale \(old naming\) {2}branch pigeon\/stale \(worktree gone\)/);
  assert.match(text, /busy .*in use \(session open\)/);
});

test("挑选：缺省只挑没有可丢东西且不在用的；--all 挑全部不在用的；点名照挑；在用的、不认得的列为不删", () => {
  const f = fixture();
  const items = listLeftoverWorktrees({ workspaceRoot: f.repo, now: later });
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
  assert.deepEqual(named.refused, ["busy: in use (session open)", "nope: not found"]);
});

test("终端界面 /worktrees：clean 先给清单并写明会丢的改动，confirm 才删；中间打别的 /worktrees 即作罢", () => {
  const f = fixture();
  const face = createTuiWorktreesFace({ workspaceRoot: f.repo, now: later });
  assert.doesNotMatch(face.run([]), /usage:/, "列表后不附删除用法");
  const plan = face.run(["clean", "dirty"]);
  assert.match(
    plan,
    /dirty \(pigeon\/[0-9a-z]{8}-dirty\): untaken changes: 1 file, lost on removal/
  );
  assert.match(plan, /\/worktrees confirm/);
  assert.ok(existsSync(f.dirty.path), "确认之前不删");
  face.run(["list"]);
  assert.match(face.run(["confirm"]), /nothing pending to confirm/);
  face.run(["clean", "dirty"]);
  assert.match(face.run(["confirm"]), /removed 1 item: dirty/);
  assert.equal(existsSync(f.dirty.path), false);
  assert.equal(git(f.repo, ["branch", "--list", f.dirty.branch]), "");
  // 缺省清理：没有可丢东西的三项
  face.run(["clean"]);
  assert.match(face.run(["confirm"]), /removed 3 items/);
  assert.equal(existsSync(f.taken.path), false);
  assert.equal(existsSync(f.legacyPath), false);
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/old"]), "");
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/stale"]), "");
  assert.ok(existsSync(f.busy.path), "在用的不动");
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/ahead"]), "pigeon/ahead");
  assert.match(face.run(["clean", "--bogus"]), /unknown option/);
});

test("命令行 pigeon worktrees：list 列出；clean 没有终端时不删、提示加 --yes；--yes 直接删；确认被拒即不删", async () => {
  const f = fixture();
  const scope = { workspaceRoot: f.repo, now: later };
  assert.doesNotMatch(await runWorktreesCommand(["list"], scope), /usage:/);
  assert.match(await runWorktreesCommand(["clean", "--all"], scope), /rerun with --yes/);
  assert.ok(existsSync(f.dirty.path));
  assert.match(
    await runWorktreesCommand(["clean", "--all"], scope, async () => false),
    /cancelled/
  );
  assert.ok(existsSync(f.dirty.path));
  const done = await runWorktreesCommand(["clean", "--all", "--yes"], scope);
  assert.match(done, /lost on removal/);
  assert.match(done, /removed 6 items/);
  assert.equal(existsSync(f.dirty.path), false);
  assert.equal(existsSync(join(f.repo, ".pigeon", "state", "worktrees", "junk")), false);
  assert.ok(existsSync(f.busy.path));
  assert.match(await runWorktreesCommand(["list"], scope), /\(1\):/);
  await assert.rejects(runWorktreesCommand(["nope"], scope), /usage/);
});

test("没有留下的：列出一句；不是 git 仓库时 /worktrees 不提供", () => {
  const repo = makeRepo();
  assert.equal(
    formatLeftoverList(listLeftoverWorktrees({ workspaceRoot: repo })),
    "no leftover worktrees or branches"
  );
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-plain-")));
  dirs.push(plain);
  assert.equal(isGitWorkspace(repo), true);
  assert.equal(isGitWorkspace(plain), false);
});

// 审查补修：比较基准与执行位置、起点不明、派出记录的起点、同名点名、确认后复核、在用的几种情形
test("在 worker 工作树里执行：拒绝列出与删除（比较基准与删除都要从主检出做）", async () => {
  const f = fixture();
  const inside = { workspaceRoot: f.dirty.path, now: later };
  assert.throws(() => listLeftoverWorktrees(inside), WorktreeCleanupError);
  await assert.rejects(
    runWorktreesCommand(["clean", "--yes"], inside),
    /run from the main checkout/
  );
  assert.match(createTuiWorktreesFace(inside).run(["clean"]), /run from the main checkout/);
  assert.ok(existsSync(f.dirty.path));
});

test("起点取不到（没有引用日志、也没有派出记录）：未取走的改动记为不明，按有改动对待，缺省清理不删", () => {
  const repo = makeRepo();
  git(repo, ["config", "core.logAllRefUpdates", "false"]);
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "nolog" });
  writeFileSync(join(w.path, "a.txt"), "worker\n");
  git(w.path, ["commit", "-q", "-am", "worker"]);
  const items = listLeftoverWorktrees({ workspaceRoot: repo, now: later });
  const item = byName(items, "nolog");
  assert.equal(item.untaken, "unknown");
  assert.deepEqual(planClean(items, []).remove, []);
  assert.match(formatLeftoverList(items), /untaken changes: unknown/);
});

test("按名字点名：同名多项时不删，要求给编号或完整分支名；完整分支名可用", () => {
  const repo = makeRepo();
  const a = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "fix" });
  const b = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "fix" });
  writeFileSync(join(b.path, "new.txt"), "b\n");
  const items = listLeftoverWorktrees({ workspaceRoot: repo, now: later });
  const plan = planClean(items, ["fix"]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.refused, ["fix: ambiguous (2 matches)"]);
  const byBranch = planClean(items, [a.branch]);
  assert.deepEqual(
    byBranch.remove.map((item) => item.branch),
    [a.branch]
  );
});

test("确认之后、删之前重新核一遍：期间又改了文件的、变成在用的都剔除并说明", async () => {
  const f = fixture();
  const scope = { workspaceRoot: f.repo, now: later };
  const face = createTuiWorktreesFace(scope);
  // 选中没有改动的 taken 与旧命名的 old；确认之前 taken 又写了文件（worker 补批续做之后）
  assert.match(face.run(["clean"]), /\/worktrees confirm/);
  writeFileSync(join(f.taken.path, "late.txt"), "late\n");
  const done = face.run(["confirm"]);
  assert.match(done, /taken: changed since listing/);
  assert.ok(existsSync(f.taken.path), "又有改动的没删");
  assert.match(done, /removed \d+ items?/);
  // 命令行：确认期间 dirty 的 worker 开跑了（会话被锁）
  const answered = await runWorktreesCommand(["clean", "dirty"], scope, async () => {
    const dir = join(sessionsDirOf(f.repo), sessionDirectoryName(f.repo));
    const file = readdirSync(dir).find((name) => name.endsWith(`${f.dirtyId}.jsonl`));
    assert.ok(file !== undefined);
    writeFileSync(
      sessionFileLockPath(join(dir, file)),
      `${JSON.stringify({ pid: process.pid, acquiredAt: 0 })}\n`
    );
    return true;
  });
  assert.match(answered, /dirty: now in use \(session open\)/);
  assert.ok(existsSync(f.dirty.path));
});

test("在用的另几种：所属会话被另一个仍在的进程打开、刚建还没有会话记录、本进程持有在用锁的", () => {
  const repo = makeRepo();
  const owner = newSessionId();
  const workerId = newSessionId();
  const w = addWorktree({ repoRoot: repo, sessionId: workerId, name: "owned" });
  writeWorkerSession(repo, workerId, owner);
  // 所属会话的锁被另一个仍在的进程持有（用父进程号代替）
  const dir = join(sessionsDirOf(repo), sessionDirectoryName(repo));
  const ownerFile = join(dir, sessionFileName(Date.now(), owner));
  writeFileSync(
    ownerFile,
    `${JSON.stringify({ kind: "header", version: 4, id: owner, createdAt: Date.now(), cwd: repo })}\n`
  );
  writeFileSync(
    sessionFileLockPath(ownerFile),
    `${JSON.stringify({ pid: process.ppid, acquiredAt: 0 })}\n`
  );
  const fresh = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "fresh" });
  const items = listLeftoverWorktrees({ workspaceRoot: repo });
  assert.equal(byName(items, "owned").inUseReason, "owner session is open");
  assert.equal(byName(items, "fresh").inUseReason, "just created, no session yet");
  assert.deepEqual(planClean(items, ["--all"]).remove, []);
  // 决策 480：子 agent 的临时工作树开着期间持有在用锁（它的会话不在会话根下，按会话号找不到）
  const release = holdWorktreeInUse(fresh.path);
  try {
    const live = listLeftoverWorktrees({ workspaceRoot: repo, now: later });
    assert.equal(byName(live, "fresh").inUseReason, "session open");
  } finally {
    release();
  }
  void w;
});
