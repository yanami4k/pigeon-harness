// 留下的工作树的列出与删除（决策 448、494、497）：真实 git 仓库上核对四类条目、在用（在用标记、面板工作清单）与未取走的改动；
// 挑选规则（缺省只挑没有可丢东西的、--all、点名、在用不挑）；终端界面的一次 y/N；命令行没有终端时须 --yes。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { addWorktree } from "../orchestration/worktree.ts";
import { addToSessionIndex } from "../persistence/session-index.ts";
import { holdWorktreeInUse } from "../persistence/worktree-in-use.ts";
import { newSessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { sessionsDirOf } from "./workspace.ts";
import {
  createTuiWorktreesFace,
  executeClean,
  formatCleanPlan,
  formatLeftoverList,
  isGitWorkspace,
  type LeftoverWorktree,
  listLeftoverWorktrees,
  planClean,
  runWorktreesCommand,
  WorktreeCleanupError,
  type WorktreeScope,
} from "./worktree-cleanup.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const dirs: string[] = [];
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
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

// 用户级主目录（在用标记与面板工作清单在这里），每个用例一份
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pigeon-wt-home-"));
  dirs.push(home);
  return home;
}

// 决策 497：会话面板工作清单里挂着一个在这棵树里干活的会话（会话文件要在，清单才列它）
async function listInPanel(repo: string, tree: string, home: string): Promise<string> {
  const sessionId = newSessionId();
  const writer = createFixtureSession({ sessionsDir: sessionsDirOf(repo), sessionId, cwd: tree });
  writer.append({
    customType: SessionEntryType.RunStart,
    data: { version: SESSION_ENTRY_VERSION, runId: "r1", input: "做点事", at: 1 },
  } as never);
  await writer.close();
  addToSessionIndex({ sessionId, governanceRoot: repo, workspaceRoot: tree }, home);
  return sessionId;
}

function fixture() {
  const repo = makeRepo();
  const home = makeHome();
  // 1. 有未取走的改动
  const dirty = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "dirty" });
  writeFileSync(join(dirty.path, "a.txt"), "worker\n");
  // 2. 改动已叠回主工作目录（内容一致）
  const taken = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "taken" });
  writeFileSync(join(taken.path, "n.txt"), "same\n");
  writeFileSync(join(repo, "n.txt"), "same\n");
  // 3. 在跑：会话开着它，持有用户级在用标记（没有改动，但裸 clean 与 --all 都不挑）
  const busy = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "busy" });
  const releaseBusy = holdWorktreeInUse(busy.path, home);
  releases.push(releaseBusy);
  // 4. 分支被人换掉的工作树（不在自己的分支上）：改动按"不明"
  const movedPath = join(repo, ".pigeon", "trees", "moved");
  git(repo, ["worktree", "add", "-q", "-b", "pigeon/moved", movedPath]);
  git(movedPath, ["switch", "-q", "-c", "moved-elsewhere"]);
  // 5. 只剩分支：旧分支（无提交）与有新提交的
  git(repo, ["branch", "pigeon/stale"]);
  git(repo, ["branch", "pigeon/ahead"]);
  git(repo, ["checkout", "-q", "pigeon/ahead"]);
  writeFileSync(join(repo, "c.txt"), "c\n");
  git(repo, ["add", "c.txt"]);
  git(repo, ["commit", "-q", "-m", "ahead"]);
  git(repo, ["checkout", "-q", "main"]);
  // 6. git 不认的残留目录
  mkdirSync(join(repo, ".pigeon", "trees", "junk"), { recursive: true });
  writeFileSync(join(repo, ".pigeon", "trees", "junk", "x"), "12345");
  const scope: WorktreeScope = { workspaceRoot: repo, homeDir: home };
  return { repo, home, scope, dirty, taken, busy, releaseBusy, movedPath };
}

function byName(items: readonly LeftoverWorktree[], name: string): LeftoverWorktree {
  const item = items.find((entry) => entry.name === name);
  assert.ok(item, `${name}: ${JSON.stringify(items.map((entry) => entry.name))}`);
  return item;
}

// 决策 494：一棵树 = .pigeon/trees/<名字> + 分支 pigeon/<名字>，没有"独立/内部"之分
test("列出：一棵树、只剩分支、残留目录；未取走的改动、在用与占用", () => {
  const f = fixture();
  const items = listLeftoverWorktrees(f.scope);
  assert.deepEqual(items.map((item) => item.name).sort(), [
    "ahead",
    "busy",
    "dirty",
    "junk",
    "moved",
    "stale",
    "taken",
  ]);
  assert.equal(byName(items, "dirty").kind, "worktree");
  assert.equal(byName(items, "dirty").untaken, 1);
  assert.ok(byName(items, "dirty").bytes > 0);
  assert.equal(byName(items, "taken").untaken, 0, "内容已与主工作目录一致");
  assert.equal(byName(items, "moved").untaken, "unknown", "不在自己的分支上按不明");
  assert.equal(byName(items, "stale").kind, "branch-only");
  assert.equal(byName(items, "ahead").untaken, "commits");
  assert.equal(byName(items, "junk").kind, "orphan-dir");
  assert.equal(byName(items, "busy").inUseReason, "session open");
  const text = formatLeftoverList(items);
  assert.match(text, /leftover worktrees and branches \(7\)/);
  assert.match(text, /dirty .*untaken changes: 1 file/);
  assert.match(text, /stale .*branch pigeon\/stale \(worktree gone\)/);
  assert.match(text, /busy .*in use \(session open\)/);
  // 决策 494：没有"所属会话"一列，也不再标旧命名
  assert.doesNotMatch(text, /session unknown|old naming/);
});

test("挑选：缺省只挑没有可丢东西且不在用的；--all 挑全部不在用的；点名照挑；在用的与不认得的列为不删", () => {
  const f = fixture();
  const items = listLeftoverWorktrees(f.scope);
  const names = (plan: { remove: LeftoverWorktree[] }) =>
    plan.remove.map((item) => item.name).sort();
  // taken/stale 没有未取走的改动；busy 也没有但在用；dirty 有、moved 不明、ahead 有提交、junk 不明
  assert.deepEqual(names(planClean(items, [])), ["stale", "taken"]);
  assert.deepEqual(names(planClean(items, ["--all"])), [
    "ahead",
    "dirty",
    "junk",
    "moved",
    "stale",
    "taken",
  ]);
  const named = planClean(items, ["dirty", "busy", "nope"]);
  assert.deepEqual(names(named), ["dirty"]);
  assert.deepEqual(named.refused, ["busy: in use (session open)", "nope: not found"]);
});

test("终端界面 /worktrees：clean 先给清单并写明会丢的改动，问一次 y/N 才删", () => {
  const f = fixture();
  const face = createTuiWorktreesFace(f.scope);
  assert.doesNotMatch(face.run([]), /usage:/, "列表后不附删除用法");
  const plan = face.run(["clean", "dirty"]);
  assert.match(plan, /dirty \(pigeon\/dirty\): untaken changes: 1 file, lost on removal/);
  // 问句只在状态行（界面那一侧），清单里不另写
  assert.doesNotMatch(plan, /\[y\/N\]/);
  assert.equal(face.hasPending(), true);
  assert.ok(existsSync(f.dirty.path), "确认之前不删");
  face.run(["list"]);
  assert.equal(face.hasPending(), false, "再打别的 /worktrees 即作罢");
  assert.match(face.confirmPending(), /nothing pending to confirm/);
  face.run(["clean", "dirty"]);
  assert.match(face.confirmPending(), /removed 1 item: dirty/);
  assert.equal(existsSync(f.dirty.path), false);
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/dirty"]), "");
  // 缺省清理：没有可丢东西且不在用的两项（在跑的 busy 不删）
  face.run(["clean"]);
  assert.match(face.confirmPending(), /removed 2 items/);
  assert.equal(existsSync(f.taken.path), false);
  assert.ok(existsSync(f.busy.path), "在用的不删");
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/stale"]), "");
  assert.equal(git(f.repo, ["branch", "--list", "pigeon/ahead"]), "pigeon/ahead");
  assert.match(face.run(["clean", "--bogus"]), /unknown option/);
});

test("命令行 pigeon worktrees：list 列出；clean 没有终端时不删、提示加 --yes；--yes 直接删", async () => {
  const f = fixture();
  const scope = f.scope;
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
  assert.ok(existsSync(f.busy.path), "--all 也不删在用的");
  assert.equal(existsSync(join(f.repo, ".pigeon", "trees", "junk")), false);
  await assert.rejects(runWorktreesCommand(["nope"], scope), /usage/);
});

test("没有留下的：列出一句；不是 git 仓库时 /worktrees 不提供", () => {
  const repo = makeRepo();
  assert.equal(
    formatLeftoverList(listLeftoverWorktrees({ workspaceRoot: repo, homeDir: makeHome() })),
    "no leftover worktrees or branches"
  );
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-plain-")));
  dirs.push(plain);
  assert.equal(isGitWorkspace(repo), true);
  assert.equal(isGitWorkspace(plain), false);
});

test("在工作树里执行：拒绝列出与删除（比较基准与删除都要从主检出做）", async () => {
  const f = fixture();
  const inside = { workspaceRoot: f.dirty.path, homeDir: f.home };
  assert.throws(() => listLeftoverWorktrees(inside), WorktreeCleanupError);
  await assert.rejects(
    runWorktreesCommand(["clean", "--yes"], inside),
    /run from the main checkout/
  );
  assert.match(createTuiWorktreesFace(inside).run(["clean"]), /run from the main checkout/);
  assert.ok(existsSync(f.dirty.path));
});

test("起点取不到：未取走的改动记为不明，按有改动对待，缺省清理不删", () => {
  const repo = makeRepo();
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "nolog" });
  writeFileSync(join(w.path, "a.txt"), "worker\n");
  git(repo, ["config", "--local", "--unset", `branch.${w.branch}.pigeonBase`]);
  const items = listLeftoverWorktrees({ workspaceRoot: repo, homeDir: makeHome() });
  assert.equal(byName(items, "nolog").untaken, "unknown");
  assert.deepEqual(planClean(items, []).remove, []);
  assert.match(formatLeftoverList(items), /untaken changes: unknown/);
});

test("按完整分支名点名可用；不认得的名字列为不删", () => {
  const repo = makeRepo();
  const a = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "fix" });
  const items = listLeftoverWorktrees({ workspaceRoot: repo, homeDir: makeHome() });
  const byBranch = planClean(items, [a.branch]);
  assert.deepEqual(
    byBranch.remove.map((item) => item.branch),
    [a.branch]
  );
  assert.deepEqual(planClean(items, ["nope"]).refused, ["nope: not found"]);
});

test("确认之后、删之前重新核一遍：期间又改了文件的剔除并说明", () => {
  const f = fixture();
  const face = createTuiWorktreesFace(f.scope);
  face.run(["clean"]);
  assert.equal(face.hasPending(), true);
  writeFileSync(join(f.taken.path, "late.txt"), "late\n");
  const done = face.confirmPending();
  assert.match(done, /taken: changed since listing/);
  assert.ok(existsSync(f.taken.path), "又有改动的没删");
  assert.match(done, /removed \d+ items?/);
});

test("在用：用户级在用标记（会话开着它）一律不删；标记撤掉即可删；列出之后才持有的真删前再看一次", () => {
  const repo = makeRepo();
  const home = makeHome();
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "busy" });
  const scope = { workspaceRoot: repo, homeDir: home };
  const release = holdWorktreeInUse(w.path, home);
  try {
    const items = listLeftoverWorktrees(scope);
    assert.equal(byName(items, "busy").inUseReason, "session open");
    assert.deepEqual(planClean(items, []).remove, []);
    assert.deepEqual(planClean(items, ["--all"]).remove, []);
  } finally {
    release();
  }
  const after = listLeftoverWorktrees(scope);
  assert.equal(byName(after, "busy").inUse, false);
  assert.deepEqual(
    planClean(after, []).remove.map((item) => item.name),
    ["busy"]
  );
  // 列出（与确认）之后才有会话打开它：真删的那一刻看到在用标记即不删
  const face = createTuiWorktreesFace(scope);
  face.run(["clean"]);
  const late = holdWorktreeInUse(w.path, home);
  releases.push(late);
  assert.match(face.confirmPending(), /busy: now in use/);
  assert.ok(existsSync(w.path));
});

// 决策 497：面板工作清单里仍挂着的会话，它的树按在用——裸 clean、--all 都不挑，点名写明属于面板里的哪个会话
test("面板清单里的会话的树：裸 clean、--all、点名都不删；点名时说明是哪个会话", async () => {
  const repo = makeRepo();
  const home = makeHome();
  const scope = { workspaceRoot: repo, homeDir: home };
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "feature-x" });
  const sessionId = await listInPanel(repo, w.path, home);
  const items = listLeftoverWorktrees(scope);
  const item = byName(items, "feature-x");
  assert.equal(item.inUse, true);
  assert.match(item.inUseReason ?? "", new RegExp(`in the session panel: .*\\(${sessionId}\\)`));
  assert.deepEqual(planClean(items, []).remove, []);
  assert.deepEqual(planClean(items, ["--all"]).remove, []);
  const named = planClean(items, ["feature-x"]);
  assert.deepEqual(named.remove, []);
  assert.equal(named.refused.length, 1);
  assert.match(
    named.refused[0] ?? "",
    new RegExp(
      `^feature-x: belongs to session .*\\(${sessionId}\\) in the session panel; remove it from the panel first$`
    )
  );
  const face = createTuiWorktreesFace(scope);
  assert.match(face.run(["clean", "feature-x"]), /kept feature-x: belongs to session/);
  assert.ok(existsSync(w.path));
});

// 审计 14：目录已不在、登记还在、它临时换到用户自己分支上的树——只删登记与它自己的 pigeon/<名字>，用户的分支不动
test("目录已不在的树：只删登记与 pigeon/<名字>，登记时所在的别的分支不动", () => {
  const repo = makeRepo();
  const scope = { workspaceRoot: repo, homeDir: makeHome() };
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "gone" });
  git(w.path, ["switch", "-q", "-c", "my-work"]);
  rmSync(w.path, { recursive: true, force: true });
  const items = listLeftoverWorktrees(scope);
  const item = byName(items, "gone");
  assert.equal(item.kind, "missing-dir");
  assert.equal(item.branch, "my-work");
  assert.equal(item.untaken, 0, "自己的分支没有新提交，删了不丢东西");
  const face = createTuiWorktreesFace(scope);
  face.run(["clean", "gone"]);
  assert.match(face.confirmPending(), /removed 1 item: gone/);
  assert.equal(git(repo, ["branch", "--list", "pigeon/gone"]), "");
  assert.equal(git(repo, ["branch", "--list", "my-work"]), "my-work", "用户的分支不动");
});

test("真删的那一刻再看一次在用标记：拿着旧清单直接执行，列出之后才被打开的不删", () => {
  const repo = makeRepo();
  const home = makeHome();
  const scope = { workspaceRoot: repo, homeDir: home };
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "late" });
  const plan = planClean(listLeftoverWorktrees(scope), ["late"]);
  assert.equal(plan.remove.length, 1);
  releases.push(holdWorktreeInUse(w.path, home));
  const result = executeClean(scope, plan);
  assert.deepEqual(result.removed, []);
  assert.match(result.failed[0] ?? "", /removing late failed: in use/);
  assert.ok(existsSync(w.path));
});

test("面板清单里的会话在树的子目录里干活同样算；清单文件读不成时每棵树都按在用", async () => {
  const repo = makeRepo();
  const home = makeHome();
  const scope = { workspaceRoot: repo, homeDir: home };
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "nested" });
  const sub = join(w.path, "packages", "web");
  mkdirSync(sub, { recursive: true });
  await listInPanel(repo, sub, home);
  assert.match(byName(listLeftoverWorktrees(scope), "nested").inUseReason ?? "", /session panel/);
  // 清单文件写坏了：不因读不到就删
  const other = makeHome();
  mkdirSync(join(other, ".pigeon", "state"), { recursive: true });
  writeFileSync(join(other, ".pigeon", "state", "session-index.json"), "{ not json");
  const broken = listLeftoverWorktrees({ workspaceRoot: repo, homeDir: other });
  assert.equal(byName(broken, "nested").inUse, true);
  assert.match(byName(broken, "nested").inUseReason ?? "", /work list can't be read/);
  assert.deepEqual(planClean(broken, ["--all"]).remove, []);
});

test("确认清单写真正要删的分支：目录已不在、登记在用户分支上的写 pigeon/<名字>", () => {
  const repo = makeRepo();
  const scope = { workspaceRoot: repo, homeDir: makeHome() };
  const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "gone2" });
  git(w.path, ["switch", "-q", "-c", "my-work2"]);
  rmSync(w.path, { recursive: true, force: true });
  const text = formatCleanPlan(planClean(listLeftoverWorktrees(scope), ["gone2"]));
  assert.match(text, /gone2 \(pigeon\/gone2\)/);
  assert.doesNotMatch(text, /my-work2/);
});
