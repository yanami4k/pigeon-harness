// 独立工作树（决策 445、446）：真实 git 仓库与本机"远端"（裸仓库）。位置与分支、起点（远端默认分支、24 小时内不取、
// 过期即取、取不到退回 HEAD、head 档）、同名已在即打开、不是工作树的同名目录拒绝、退出判断（干净即可删、有改动/有提交/
// 起点不明按有改动）、删除连分支、全局排除规则与 .worktreeinclude。全局 git 配置与 XDG 已由测试总装指到临时位置。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { globalExcludesFile } from "../persistence/global-ignore.ts";
import { findLegacyLayout } from "../persistence/legacy-layout.ts";
import { sessionDirectoryName, sessionFileName } from "../persistence/session-reader.ts";
import {
  holdWorktreeInUse,
  worktreeInUse,
  worktreeInUseByOthers,
} from "../persistence/worktree-in-use.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  assertWorktreeName,
  closeNamedWorktree,
  NamedWorktreeError,
  namedWorktreeUnchanged,
  nonInteractiveGitEnv,
  openNamedWorktree,
  removeNamedWorktree,
  resolveWorktreeBase,
  uncommittedCount,
} from "./named-worktree.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import {
  executeClean,
  formatCleanResult,
  formatLeftoverList,
  listLeftoverWorktrees,
  planClean,
} from "./worktree-cleanup.ts";

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

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, ["add", file]);
  git(cwd, ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

// 远端（裸仓库）+ 克隆；克隆之后远端又多一个提交，本地 HEAD 也另有一个本地提交
function cloned(): { origin: string; repo: string; remoteTip: string; localHead: string } {
  const seed = temp("pigeon-nwt-seed-");
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "core.autocrlf", "false"]);
  commit(seed, "a.txt", "one\n", "one");
  const origin = temp("pigeon-nwt-origin-");
  git(origin, ["clone", "-q", "--bare", seed, "."]);
  const repo = temp("pigeon-nwt-repo-");
  git(repo, ["clone", "-q", "-c", "core.autocrlf=false", origin, "."]);
  commit(seed, "a.txt", "two\n", "two");
  git(seed, ["push", "-q", origin, "main"]);
  const remoteTip = git(seed, ["rev-parse", "HEAD"]);
  const localHead = commit(repo, "local.txt", "local\n", "local");
  return { origin, repo, remoteTip, localHead };
}

function plainRepo(): string {
  const repo = temp("pigeon-nwt-plain-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  commit(repo, "a.txt", "a\n", "init");
  return repo;
}

test("位置 .pigeon/wt/<名字>、分支 pigeon-wt/<名字>；起点缺省为远端默认分支，远端引用过期就先取", () => {
  const { repo, remoteTip } = cloned();
  const wt = openNamedWorktree({ cwd: repo, name: "feat-x" });
  assert.equal(wt.path, join(repo, ".pigeon", "wt", "feat-x"));
  assert.equal(wt.branch, "pigeon-wt/feat-x");
  assert.equal(wt.created, true);
  assert.equal(wt.base, remoteTip, "克隆之后从未取过：先取，起点是远端最新");
  assert.equal(wt.baseLabel, "origin/main");
  assert.equal(git(wt.path, ["rev-parse", "HEAD"]), remoteTip);
  assert.equal(git(wt.path, ["branch", "--show-current"]), "pigeon-wt/feat-x");
  // 全局排除规则（临时 XDG）里有工作树一行，主检出的 git status 不列 .pigeon
  assert.match(readFileSync(globalExcludesFile(repo) ?? "", "utf8"), /\*\*\/\.pigeon\/wt\//);
  assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=all"]), "");
});

test("起点：24 小时内取过就不取；取不到（远端不可达）退回 HEAD 并写明；没有远端用 HEAD；head 档用 HEAD", () => {
  const { repo, origin, localHead } = cloned();
  // 刚取过（FETCH_HEAD 新）：不取，用本地已有的 origin/main（克隆时的那个提交）
  git(repo, ["fetch", "-q", "origin", "main"]);
  const known = git(repo, ["rev-parse", "origin/main"]);
  const recent = resolveWorktreeBase(repo, "fresh");
  assert.equal(recent.commit, known);
  // 过期且远端不可达：退回 HEAD
  const fetchHead = join(repo, ".git", "FETCH_HEAD");
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(fetchHead, old, old);
  rmSync(origin, { recursive: true, force: true });
  const failed = resolveWorktreeBase(repo, "fresh");
  assert.equal(failed.commit, localHead);
  assert.match(failed.label, /^HEAD \(fetching origin/);
  assert.deepEqual(resolveWorktreeBase(repo, "head"), { commit: localHead, label: "HEAD" });
  const plain = plainRepo();
  const none = resolveWorktreeBase(plain, "fresh");
  assert.equal(none.commit, git(plain, ["rev-parse", "HEAD"]));
  assert.equal(none.label, "HEAD (no remote default branch)");
});

test("同名目录已在即打开（不重建），起点取分支建立时的那条；不是本仓库工作树的同名目录拒绝", () => {
  const repo = plainRepo();
  const first = openNamedWorktree({ cwd: repo, name: "keep" });
  writeFileSync(join(first.path, "work.txt"), "in progress\n");
  const again = openNamedWorktree({ cwd: repo, name: "keep" });
  assert.equal(again.created, false);
  assert.equal(again.path, first.path);
  assert.equal(again.base, first.base);
  assert.ok(existsSync(join(again.path, "work.txt")), "没有重建");
  mkdirSync(join(repo, ".pigeon", "wt", "stray"), { recursive: true });
  assert.throws(() => openNamedWorktree({ cwd: repo, name: "stray" }), NamedWorktreeError);
  for (const bad of ["", "-x", "a/b", "../x", "a b", "Feat", "x".repeat(65)]) {
    assert.throws(() => assertWorktreeName(bad), NamedWorktreeError, bad);
  }
  assert.throws(
    () => openNamedWorktree({ cwd: temp("pigeon-nwt-nogit-"), name: "x" }),
    /not in a git repository/
  );
});

test("退出判断：干净即无改动、删工作树与分支；未提交改动、未跟踪文件、新提交、起点不明都算有改动", () => {
  const repo = plainRepo();
  const clean = openNamedWorktree({ cwd: repo, name: "clean" });
  assert.equal(namedWorktreeUnchanged(clean), true);
  removeNamedWorktree(clean);
  assert.equal(existsSync(clean.path), false);
  assert.equal(git(repo, ["branch", "--list", clean.branch]), "");

  const dirty = openNamedWorktree({ cwd: repo, name: "dirty" });
  writeFileSync(join(dirty.path, "a.txt"), "changed\n");
  assert.equal(namedWorktreeUnchanged(dirty), false);
  const untracked = openNamedWorktree({ cwd: repo, name: "untracked" });
  writeFileSync(join(untracked.path, "new.txt"), "n\n");
  assert.equal(namedWorktreeUnchanged(untracked), false);
  const committed = openNamedWorktree({ cwd: repo, name: "committed" });
  commit(committed.path, "c.txt", "c\n", "c");
  assert.equal(namedWorktreeUnchanged(committed), false);
  const { base: _base, ...unknown } = openNamedWorktree({ cwd: repo, name: "unknown" });
  assert.equal(namedWorktreeUnchanged(unknown), false);
});

test("建立时按 .worktreeinclude 复制被忽略的文件；主检出里未提交的改动数（移入时不带过去）", () => {
  const repo = plainRepo();
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
  git(repo, ["add", ".gitignore", ".worktreeinclude"]);
  git(repo, ["-c", "user.email=t@e.invalid", "-c", "user.name=t", "commit", "-q", "-m", "inc"]);
  writeFileSync(join(repo, ".env"), "K=1\n");
  writeFileSync(join(repo, "a.txt"), "edited in main\n");
  writeFileSync(join(repo, "b.txt"), "new in main\n");
  assert.equal(uncommittedCount(repo), 2);
  const wt = openNamedWorktree({ cwd: repo, name: "inc", baseMode: "head" });
  assert.equal(readFileSync(join(wt.path, ".env"), "utf8"), "K=1\n");
  assert.equal(readFileSync(join(wt.path, "a.txt"), "utf8"), "a\n", "未提交的改动没带过来");
  assert.equal(existsSync(join(wt.path, "b.txt")), false);
});

test("退出清理：没有改动即删并说明；有改动时问——k 保留并给出下次进入的命令，d 删除，EOF 按保留；没有终端可问即保留", async () => {
  const repo = plainRepo();
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const clean = openNamedWorktree({ cwd: repo, name: "c1" });
  assert.equal(await closeNamedWorktree(clean, { write }), "removed");
  assert.equal(existsSync(clean.path), false);
  assert.equal(lines.length, 0, "没有改动即删，不说");

  const changed = openNamedWorktree({ cwd: repo, name: "c2" });
  writeFileSync(join(changed.path, "x.txt"), "x\n");
  assert.equal(await closeNamedWorktree(changed, { write }), "kept", "没有终端可问即保留");
  assert.match(lines.at(-1) ?? "", /^worktree c2 kept at /);
  const answers = ["?", "k"];
  assert.equal(
    await closeNamedWorktree(changed, { ask: async () => answers.shift() ?? null, write }),
    "kept"
  );
  assert.ok(lines.includes("k or d"));
  assert.equal(await closeNamedWorktree(changed, { ask: async () => null, write }), "kept");
  assert.equal(await closeNamedWorktree(changed, { ask: async () => "d", write }), "removed");
  assert.equal(existsSync(changed.path), false);
  assert.equal(git(repo, ["branch", "--list", changed.branch]), "");
});

test("独立工作树在 .pigeon/wt 下，不触发旧布局检查；.pigeon/worktrees 仍按目录在即旧布局", () => {
  const repo = plainRepo();
  openNamedWorktree({ cwd: repo, name: "keep-me" });
  assert.deepEqual(findLegacyLayout(repo), []);
  mkdirSync(join(repo, ".pigeon", "worktrees"), { recursive: true });
  assert.equal(
    findLegacyLayout(repo).some((item) => item.name === "worktrees"),
    true
  );
});

test("只删自己的分支 pigeon-wt/<名字>：工作树换到别的分支即按有改动，删除时别的分支不动", async () => {
  const repo = plainRepo();
  const wt = openNamedWorktree({ cwd: repo, name: "sw" });
  git(wt.path, ["switch", "-q", "-c", "foreign"]);
  const reopened = openNamedWorktree({ cwd: repo, name: "sw" });
  assert.equal(reopened.branch, "pigeon-wt/sw");
  assert.equal(reopened.currentBranch, "foreign");
  assert.equal(namedWorktreeUnchanged(reopened), false, "不在自己的分支上按有改动");
  const asked: string[] = [];
  assert.equal(
    await closeNamedWorktree(reopened, {
      ask: async (prompt) => {
        asked.push(prompt);
        return "d";
      },
      write: () => {},
      inUseByOthers: () => false,
    }),
    "removed"
  );
  assert.match(asked[0] ?? "", /is on foreign/);
  assert.match(git(repo, ["branch", "--list", "foreign"]), /foreign/);
  assert.equal(git(repo, ["branch", "--list", "pigeon-wt/sw"]), "");
});

test("起点建立时记在仓库配置里；记录丢了按不明（有改动），不再从分支历史猜", () => {
  const repo = plainRepo();
  const wt = openNamedWorktree({ cwd: repo, name: "rb" });
  assert.equal(
    git(repo, ["config", "--local", "--get", "branch.pigeon-wt/rb.pigeonBase"]),
    wt.base
  );
  assert.equal(namedWorktreeUnchanged(openNamedWorktree({ cwd: repo, name: "rb" })), true);
  git(repo, ["config", "--local", "--unset", "branch.pigeon-wt/rb.pigeonBase"]);
  const lost = openNamedWorktree({ cwd: repo, name: "rb" });
  assert.equal(lost.base, undefined);
  assert.equal(lost.baseLabel, "unknown");
  assert.equal(namedWorktreeUnchanged(lost), false);
});

test("别的进程开着这个工作树（在用锁）时退出清理不删；本进程的锁不算别人；进程已不在的锁清掉", async () => {
  const repo = plainRepo();
  const home = temp("pigeon-wt-use-");
  const wt = openNamedWorktree({ cwd: repo, name: "lk" });
  const lines: string[] = [];
  assert.equal(
    await closeNamedWorktree(wt, { write: (line) => lines.push(line), inUseByOthers: () => true }),
    "kept"
  );
  assert.match(lines.at(-1) ?? "", /worktree lk is open in another session; kept/);
  assert.equal(existsSync(wt.path), true);
  const release = holdWorktreeInUse(wt.path, home);
  assert.equal(worktreeInUseByOthers(wt.path, { homeDir: home }), false);
  assert.equal(worktreeInUse(wt.path, { homeDir: home }), true);
  release();
  release();
  assert.equal(worktreeInUse(wt.path, { homeDir: home }), false);
  const dir = join(home, ".pigeon", "state", "worktree-use");
  assert.deepEqual(readdirSync(dir), []);
  // 别的进程留下的锁：仍在即算别人在用，已不在即清掉
  const other = holdWorktreeInUse(wt.path, home);
  const mine = readdirSync(dir)[0] ?? "";
  other();
  const foreign = mine.replace(`-${process.pid}.`, "-424242.");
  writeFileSync(join(dir, foreign), `${JSON.stringify({ pid: 424242 })}\n`);
  assert.equal(worktreeInUseByOthers(wt.path, { homeDir: home, alive: () => true }), true);
  assert.equal(worktreeInUseByOthers(wt.path, { homeDir: home, alive: () => false }), false);
  assert.deepEqual(readdirSync(dir), [], "已不在的进程的锁被清掉");
});

test("/worktrees 列出独立工作树、标明独立工作树；clean 缺省与 --all 都不挑，点名才删（不跟随链接的删除）", () => {
  const repo = plainRepo();
  const wt = openNamedWorktree({ cwd: repo, name: "solo" });
  writeFileSync(join(wt.path, "w.txt"), "w\n");
  // 没有改动的独立工作树：缺省清理同样不挑（它有自己的退出清理）
  openNamedWorktree({ cwd: repo, name: "idle" });
  const scope = { workspaceRoot: repo, now: () => Date.now() + 3_600_000 };
  const items = listLeftoverWorktrees(scope);
  assert.equal(items.find((item) => item.name === "idle")?.untaken, 0);
  const named = items.find((item) => item.name === "solo");
  assert.ok(named !== undefined, JSON.stringify(items));
  assert.equal(named.name, "solo");
  assert.equal(named.untaken, 1);
  assert.match(formatLeftoverList(items), /solo {2}worktree, branch pigeon-wt\/solo/);
  assert.deepEqual(planClean(items, []).remove, []);
  assert.deepEqual(planClean(items, ["--all"]).remove, []);
  const plan = planClean(items, ["solo"]);
  assert.deepEqual(
    plan.remove.map((item) => item.name),
    ["solo"]
  );
  assert.match(formatCleanResult(executeClean(scope, plan)), /removed 1 item: solo/);
  assert.equal(existsSync(wt.path), false);
  assert.equal(git(repo, ["branch", "--list", wt.branch]), "");
});

test("/worktrees：有进程开着的独立工作树（在用锁，含没有会话文件的）点名也不删；换到别的分支的只删 pigeon-wt/<名字>", () => {
  const repo = plainRepo();
  const busy = openNamedWorktree({ cwd: repo, name: "busy" });
  const release = holdWorktreeInUse(busy.path, temp("pigeon-wt-use-"));
  const scope = { workspaceRoot: repo, now: () => Date.now() + 3_600_000 };
  try {
    const items = listLeftoverWorktrees(scope);
    const held = items.find((item) => item.name === "busy");
    assert.equal(held?.inUse, true);
    const plan = planClean(items, ["busy"]);
    assert.deepEqual(plan.remove, []);
    assert.match(plan.refused.join("\n"), /busy: in use \(a session is open in it\)/);
  } finally {
    release();
  }
  assert.equal(
    listLeftoverWorktrees(scope).find((item) => item.name === "busy")?.inUse,
    false,
    "释放之后不再在用"
  );
  const moved = openNamedWorktree({ cwd: repo, name: "moved" });
  git(moved.path, ["switch", "-q", "-c", "foreign"]);
  const item = listLeftoverWorktrees(scope).find((entry) => entry.name === "moved");
  assert.equal(item?.branch, "pigeon-wt/moved");
  assert.equal(item?.untaken, "unknown", "不在自己的分支上：改动按不明");
  executeClean(scope, planClean(listLeftoverWorktrees(scope), ["moved"]));
  assert.equal(existsSync(moved.path), false);
  assert.equal(git(repo, ["branch", "--list", "pigeon-wt/moved"]), "");
  assert.match(git(repo, ["branch", "--list", "foreign"]), /foreign/);
});

test("续接开在独立工作树里的会话：工作区回到那个工作树（会话文件头记的工作目录）；工作树已不在即回到主检出", () => {
  const repo = plainRepo();
  const wt = openNamedWorktree({ cwd: repo, name: "resume-me" });
  const sessionId = newSessionId();
  const dir = join(sessionsDirOf(repo), sessionDirectoryName(wt.path));
  mkdirSync(dir, { recursive: true });
  const createdAt = Date.now();
  writeFileSync(
    join(dir, sessionFileName(createdAt, sessionId)),
    `${JSON.stringify({ kind: "header", version: 4, id: sessionId, createdAt, cwd: wt.path })}\n`
  );
  assert.equal(sessionRuntimeScope(repo, sessionId).workspaceRoot, wt.path);
  removeNamedWorktree(wt);
  assert.equal(sessionRuntimeScope(repo, sessionId).workspaceRoot, repo);
});

test("取远端时的 ssh：使用者没指定 ssh 才加批处理方式；GIT_SSH_COMMAND、GIT_SSH、core.sshCommand 任一设了即沿用", () => {
  assert.equal(nonInteractiveGitEnv({}).GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
  assert.equal(nonInteractiveGitEnv({ GIT_SSH_COMMAND: "my-ssh" }).GIT_SSH_COMMAND, "my-ssh");
  assert.equal(nonInteractiveGitEnv({ GIT_SSH: "plink" }).GIT_SSH_COMMAND, undefined);
  assert.equal(nonInteractiveGitEnv({}, true).GIT_SSH_COMMAND, undefined);
  assert.equal(nonInteractiveGitEnv({}).GIT_TERMINAL_PROMPT, "0");
});
