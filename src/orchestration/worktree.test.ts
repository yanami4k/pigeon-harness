// worker 工作树管理（M5.5 S1，决策 040）：真实 git 仓库上验证目录布局、分支命名、清单、
// 隔离写入与移除；名字先校验再进 git 参数。决策 447：分支带会话号；448：删工作树连分支；449：.worktreeinclude。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import {
  addWorktree,
  branchTailFor,
  copyWorktreeIncludes,
  deleteBranch,
  listWorktrees,
  removeWorktree,
  removeWorktreeAndBranch,
  WorktreeError,
  worktreeBranchFor,
  worktreePathFor,
  worktreePristine,
  worktreeStartRefFor,
} from "./worktree.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): { repo: string; cleanup: () => void } {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-")));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "pigeon@example.invalid"]);
  git(repo, ["config", "user.name", "pigeon-test"]);
  // 夹具不受本机全局换行转换配置影响（检出内容逐字节可比）
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "alpha\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

// 决策 447：分支名 pigeon/<会话号后 8 位，小写>-<名字>
test("工作树：目录在 .pigeon/state/worktrees/<会话>-<名字>、分支 pigeon/<会话号后 8 位>-<名字>，隔离写入，移除后清单不再列出", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const sessionId = newSessionId();
    const handle = addWorktree({ repoRoot: repo, sessionId, name: "fix-a" });
    const branch = `pigeon/${sessionId.slice(-8).toLowerCase()}-fix-a`;
    assert.equal(handle.path, join(repo, ".pigeon", "state", "worktrees", `${sessionId}-fix-a`));
    assert.equal(handle.branch, branch);
    assert.equal(worktreeBranchFor(sessionId, "fix-a"), branch);
    assert.equal(readFileSync(join(handle.path, "a.txt"), "utf8"), "alpha\n");
    assert.equal(git(handle.path, ["branch", "--show-current"]).trim(), branch);

    const listed = listWorktrees(repo).find((entry) => resolve(entry.path) === handle.path);
    assert.ok(listed, JSON.stringify(listWorktrees(repo)));
    assert.equal(listed.branch, branch);

    // 工作树内改文件：主工作区已跟踪文件零改动
    writeFileSync(join(handle.path, "a.txt"), "changed in worker\n");
    assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "alpha\n");
    assert.equal(git(repo, ["status", "--porcelain", "--untracked-files=no"]), "");

    removeWorktree({ repoRoot: repo, path: handle.path, force: true });
    assert.equal(existsSync(handle.path), false);
    assert.equal(
      listWorktrees(repo).some((entry) => resolve(entry.path) === handle.path),
      false
    );
  } finally {
    cleanup();
  }
});

// 决策 447：以前同名分支由 git 拒绝（另一个会话派过同名 worker，再派即失败）；分支带会话号后两个会话的同名 worker 各建各的
test("工作树：目录名与分支名都带会话编号，两个会话的同名 worker 都建得起来；显式给的同名分支仍由 git 响亮拒绝", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const first = newSessionId();
    const second = newSessionId();
    assert.notEqual(worktreePathFor(repo, first, "x"), worktreePathFor(repo, second, "x"));
    const a = addWorktree({ repoRoot: repo, sessionId: first, name: "x" });
    const b = addWorktree({ repoRoot: repo, sessionId: second, name: "x" });
    assert.notEqual(a.branch, b.branch);
    assert.throws(
      () => addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "x", branch: a.branch }),
      (error: unknown) => error instanceof WorktreeError && error.message.includes(a.branch)
    );
  } finally {
    cleanup();
  }
});

test("工作树：非法名字在调用 git 之前拒绝", () => {
  const { repo, cleanup } = makeRepo();
  try {
    for (const name of ["", "../evil", "-f", "a b", "A", "x/y", "a".repeat(41)]) {
      assert.throws(
        () => addWorktree({ repoRoot: repo, sessionId: newSessionId(), name }),
        WorktreeError,
        name
      );
    }
    for (const branch of ["-x", "Pigeon/x", "pigeon//x", "pigeon/x/", "a..b"]) {
      assert.throws(
        () => addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "ok", branch }),
        WorktreeError,
        branch
      );
    }
    assert.equal(existsSync(join(repo, ".pigeon")), false);
  } finally {
    cleanup();
  }
});

// 决策 279：worker 起点快照的引用与分支同名，随分支一并删除
test("起点引用 refs/pigeon/worker-start/<会话号后 8 位>-<名>：删分支时一并删除；没有引用的分支照删；旧命名照删；非法名字拒绝", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const sessionId = newSessionId();
    const tail = branchTailFor(sessionId, "fix-a");
    const ref = worktreeStartRefFor(tail);
    assert.equal(ref, `refs/pigeon/worker-start/${tail}`);
    git(repo, ["update-ref", ref, head]);
    const first = addWorktree({ repoRoot: repo, sessionId, name: "fix-a", baseRef: head });
    removeWorktree({ repoRoot: repo, path: first.path, force: true });
    deleteBranch({ repoRoot: repo, branch: first.branch });
    assert.equal(git(repo, ["for-each-ref", "refs/pigeon/worker-start/"]).trim(), "", "引用已删");
    assert.equal(git(repo, ["for-each-ref", "refs/heads/pigeon/"]).trim(), "", "分支已删");

    const second = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "fix-b" });
    removeWorktree({ repoRoot: repo, path: second.path, force: true });
    deleteBranch({ repoRoot: repo, branch: second.branch });
    // 决策 447 之前的旧分支 pigeon/<名字> 照样能删（连同旧的起点引用）
    git(repo, ["branch", "pigeon/old-one"]);
    git(repo, ["update-ref", worktreeStartRefFor("old-one"), head]);
    deleteBranch({ repoRoot: repo, branch: "pigeon/old-one" });
    assert.equal(git(repo, ["for-each-ref", "refs/heads/pigeon/"]).trim(), "");
    assert.equal(git(repo, ["for-each-ref", "refs/pigeon/worker-start/"]).trim(), "");
    assert.throws(() => worktreeStartRefFor("../x"), WorktreeError);
    assert.throws(() => deleteBranch({ repoRoot: repo, branch: "main" }), WorktreeError);
  } finally {
    cleanup();
  }
});

// 决策 448
test("removeWorktreeAndBranch：目录在即删目录与分支；目录已被手删的清掉登记再删分支；分支已不在不算失败", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const a = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "a" });
    writeFileSync(join(a.path, "new.txt"), "dirty\n");
    removeWorktreeAndBranch({ repoRoot: repo, path: a.path, branch: a.branch });
    assert.equal(existsSync(a.path), false);
    assert.equal(git(repo, ["branch", "--list", a.branch]).trim(), "");

    const b = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "b" });
    rmSync(b.path, { recursive: true, force: true });
    removeWorktreeAndBranch({ repoRoot: repo, path: b.path, branch: b.branch });
    assert.equal(git(repo, ["branch", "--list", b.branch]).trim(), "");
    assert.equal(
      listWorktrees(repo).some((entry) => resolve(entry.path) === b.path),
      false,
      "登记已清"
    );
    // 再删一次：都已不在
    removeWorktreeAndBranch({ repoRoot: repo, path: b.path, branch: b.branch });

    // 显式分支（非 pigeon/ 下）只删分支
    const c = addWorktree({
      repoRoot: repo,
      sessionId: newSessionId(),
      name: "c",
      branch: "pigeon-wt/c",
    });
    removeWorktreeAndBranch({ repoRoot: repo, path: c.path, branch: c.branch });
    assert.equal(git(repo, ["branch", "--list", "pigeon-wt/c"]).trim(), "");
  } finally {
    cleanup();
  }
});

test("worktreePristine：与起点一致为真；未提交改动、未跟踪文件、新提交、目录不在都为假", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "w" });
    assert.equal(worktreePristine(w.path, head), true);
    writeFileSync(join(w.path, "u.txt"), "untracked\n");
    assert.equal(worktreePristine(w.path, head), false);
    rmSync(join(w.path, "u.txt"));
    writeFileSync(join(w.path, "a.txt"), "edited\n");
    assert.equal(worktreePristine(w.path, head), false);
    git(w.path, ["commit", "-q", "-am", "worker"]);
    assert.equal(git(w.path, ["status", "--porcelain"]).trim(), "");
    assert.equal(worktreePristine(w.path, head), false, "有新提交");
    assert.equal(worktreePristine(join(repo, "nope"), head), false);
  } finally {
    cleanup();
  }
});

// 决策 449
test(".worktreeinclude：既匹配规则又被忽略的文件复制进新工作树；已跟踪的、只匹配不被忽略的、只被忽略不匹配的、.pigeon 下的都不复制", () => {
  const { repo, cleanup } = makeRepo();
  try {
    writeFileSync(join(repo, ".gitignore"), ".env\n*.local\nbuild/\n.pigeon/\nsecrets/\n");
    writeFileSync(
      join(repo, ".worktreeinclude"),
      ".env\nconfig/*.local\nnot-ignored.txt\n.pigeon/\nsecrets/\n"
    );
    git(repo, ["add", ".gitignore", ".worktreeinclude"]);
    git(repo, ["commit", "-q", "-m", "ignore"]);
    writeFileSync(join(repo, ".env"), "KEY=1\n");
    mkdirSync(join(repo, "config"));
    writeFileSync(join(repo, "config", "app.local"), "local\n");
    writeFileSync(join(repo, "other.local"), "not listed\n");
    writeFileSync(join(repo, "not-ignored.txt"), "untracked but not ignored\n");
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "out.js"), "built\n");
    mkdirSync(join(repo, ".pigeon", "state"), { recursive: true });
    writeFileSync(join(repo, ".pigeon", "state", "x.json"), "{}\n");
    mkdirSync(join(repo, "secrets", "deep"), { recursive: true });
    writeFileSync(join(repo, "secrets", "deep", "k.pem"), "pem\n");

    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "inc" });
    assert.equal(readFileSync(join(w.path, ".env"), "utf8"), "KEY=1\n");
    assert.equal(readFileSync(join(w.path, "config", "app.local"), "utf8"), "local\n");
    assert.equal(readFileSync(join(w.path, "secrets", "deep", "k.pem"), "utf8"), "pem\n");
    assert.equal(existsSync(join(w.path, "other.local")), false, "被忽略但不在清单");
    assert.equal(existsSync(join(w.path, "not-ignored.txt")), false, "在清单但不被忽略");
    assert.equal(existsSync(join(w.path, "build", "out.js")), false);
    assert.equal(existsSync(join(w.path, ".pigeon", "state", "x.json")), false);
    // 已在工作树里的不覆盖、再调一次不重复复制
    writeFileSync(join(w.path, ".env"), "KEY=worktree\n");
    assert.deepEqual(copyWorktreeIncludes(repo, w.path), []);
    assert.equal(readFileSync(join(w.path, ".env"), "utf8"), "KEY=worktree\n");
  } finally {
    cleanup();
  }
});

test(".worktreeinclude：带 .git 段的（含 8.3 短名 git~1）不复制，与写文件工具同一判断", () => {
  const { repo, cleanup } = makeRepo();
  try {
    writeFileSync(join(repo, ".gitignore"), "vendor/\n");
    writeFileSync(join(repo, ".worktreeinclude"), "vendor/\n");
    git(repo, ["add", ".gitignore", ".worktreeinclude"]);
    git(repo, ["commit", "-q", "-m", "ignore"]);
    mkdirSync(join(repo, "vendor", "git~1"), { recursive: true });
    writeFileSync(join(repo, "vendor", "keep.txt"), "keep\n");
    writeFileSync(join(repo, "vendor", "git~1", "config"), "[core]\n");
    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "gitseg" });
    assert.equal(readFileSync(join(w.path, "vendor", "keep.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(join(w.path, "vendor", "git~1")), false);
  } finally {
    cleanup();
  }
});

test(".worktreeinclude：没有该文件时什么都不复制；includeSource 指定来源目录", () => {
  const { repo, cleanup } = makeRepo();
  try {
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-q", "-m", "ignore"]);
    writeFileSync(join(repo, ".env"), "KEY=1\n");
    const plain = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "plain" });
    assert.equal(existsSync(join(plain.path, ".env")), false);

    writeFileSync(join(plain.path, ".worktreeinclude"), ".env\n");
    writeFileSync(join(plain.path, ".env"), "FROM=plain\n");
    const nested = addWorktree({
      repoRoot: repo,
      sessionId: newSessionId(),
      name: "nested",
      includeSource: plain.path,
    });
    assert.equal(readFileSync(join(nested.path, ".env"), "utf8"), "FROM=plain\n");
  } finally {
    cleanup();
  }
});

// 审查补修：删除不跟随链接、按登记删、锁定与非工作树拒删；.worktreeinclude 不跟随链接、按仓库顶层、大清单、复制失败回滚
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function outside(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-wt-outside-")));
  writeFileSync(join(dir, "keep.txt"), "outside\n");
  mkdirSync(join(dir, "deep"));
  writeFileSync(join(dir, "deep", "keep2.txt"), "outside 2\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("删除工作树不顺着目录联接或符号链接删到工作树外：链接本身删掉，链接指向的目录与文件完好", () => {
  const { repo, cleanup } = makeRepo();
  const ext = outside();
  try {
    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "linked" });
    symlinkSync(ext.dir, join(w.path, "node_modules"), LINK_TYPE);
    mkdirSync(join(w.path, "nested"));
    symlinkSync(ext.dir, join(w.path, "nested", "again"), LINK_TYPE);
    removeWorktreeAndBranch({ repoRoot: repo, path: w.path, branch: w.branch });
    assert.equal(existsSync(w.path), false);
    assert.equal(readFileSync(join(ext.dir, "keep.txt"), "utf8"), "outside\n");
    assert.equal(readFileSync(join(ext.dir, "deep", "keep2.txt"), "utf8"), "outside 2\n");
    assert.equal(git(repo, ["branch", "--list", w.branch]).trim(), "");
    assert.equal(listWorktrees(repo).length, 1, "登记已删");
  } finally {
    ext.cleanup();
    cleanup();
  }
});

test("删除：目录已被手删而 git 仍登记的，只删这一个登记与分支，不碰别的工作树的登记；被锁定的不删；主检出拒删", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const gone = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "gone" });
    const other = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "other" });
    rmSync(gone.path, { recursive: true, force: true });
    // 另一个工作树的目录暂时挪开（例如所在的盘暂时不可达）：整库 prune 会顺带清掉它的登记，这里不应清掉
    const parked = `${other.path}-parked`;
    renameSync(other.path, parked);
    removeWorktreeAndBranch({ repoRoot: repo, path: gone.path, branch: gone.branch });
    assert.equal(git(repo, ["branch", "--list", gone.branch]).trim(), "");
    renameSync(parked, other.path);
    const listed = listWorktrees(repo).map((entry) => resolve(entry.path));
    assert.ok(listed.includes(other.path), "别的工作树的登记还在");
    assert.ok(!listed.includes(gone.path));

    git(repo, ["worktree", "lock", other.path]);
    assert.throws(
      () => removeWorktreeAndBranch({ repoRoot: repo, path: other.path, branch: other.branch }),
      /is locked/
    );
    assert.ok(existsSync(other.path));
    assert.throws(() => removeWorktree({ repoRoot: repo, path: repo }), /is not a git worktree/);
    assert.ok(existsSync(join(repo, "a.txt")));
  } finally {
    cleanup();
  }
});

test(".worktreeinclude 不顺着目录联接或符号链接复制工作区外的文件", () => {
  const { repo, cleanup } = makeRepo();
  const ext = outside();
  try {
    writeFileSync(join(ext.dir, "id_rsa"), "PRIVATE\n");
    writeFileSync(join(repo, ".gitignore"), "vendor/\n.env\n");
    writeFileSync(join(repo, ".worktreeinclude"), "vendor/\n.env\n");
    git(repo, ["add", ".gitignore", ".worktreeinclude"]);
    git(repo, ["commit", "-q", "-m", "ignore"]);
    symlinkSync(ext.dir, join(repo, "vendor"), LINK_TYPE);
    writeFileSync(join(repo, ".env"), "OK=1\n");
    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "inc-link" });
    assert.equal(readFileSync(join(w.path, ".env"), "utf8"), "OK=1\n");
    assert.equal(existsSync(join(w.path, "vendor", "id_rsa")), false);
    assert.equal(existsSync(join(w.path, "vendor")), false);
  } finally {
    ext.cleanup();
    cleanup();
  }
});

test(".worktreeinclude 按仓库顶层：会话在子目录时，规则读顶层的文件，pkg/.env 复制到工作树的 pkg/.env", () => {
  const { repo, cleanup } = makeRepo();
  try {
    mkdirSync(join(repo, "pkg"));
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".worktreeinclude"), "pkg/.env\n");
    git(repo, ["add", ".gitignore", ".worktreeinclude"]);
    git(repo, ["commit", "-q", "-m", "ignore"]);
    writeFileSync(join(repo, "pkg", ".env"), "PKG=1\n");
    const w = addWorktree({
      repoRoot: join(repo, "pkg"),
      governanceRoot: repo,
      sessionId: newSessionId(),
      name: "sub",
    });
    assert.equal(readFileSync(join(w.path, "pkg", ".env"), "utf8"), "PKG=1\n");
    assert.equal(existsSync(join(w.path, ".env")), false);
  } finally {
    cleanup();
  }
});

test(".worktreeinclude 列出的文件很多（清单超过 1 MiB）也能建出并复制", () => {
  const { repo, cleanup } = makeRepo();
  try {
    writeFileSync(join(repo, ".gitignore"), "cache/\n");
    writeFileSync(join(repo, ".worktreeinclude"), "cache/\n");
    git(repo, ["add", ".gitignore", ".worktreeinclude"]);
    git(repo, ["commit", "-q", "-m", "ignore"]);
    const deep = join(repo, "cache", "x".repeat(60), "y".repeat(60));
    mkdirSync(deep, { recursive: true });
    const count = 6000;
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(deep, `${"z".repeat(50)}-${index}.txt`), "");
    }
    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "big" });
    const copied = join(w.path, "cache", "x".repeat(60), "y".repeat(60));
    assert.ok(existsSync(join(copied, `${"z".repeat(50)}-${count - 1}.txt`)));
  } finally {
    cleanup();
  }
});

test(".worktreeinclude 复制出错（目标位置在检出里是个文件）：派出失败，刚建的工作树与分支删掉", () => {
  const { repo, cleanup } = makeRepo();
  try {
    writeFileSync(join(repo, ".gitignore"), "cfg/\n");
    writeFileSync(join(repo, ".worktreeinclude"), "cfg/\n");
    writeFileSync(join(repo, "cfg"), "a file in the old commit\n");
    git(repo, ["add", "-f", ".gitignore", ".worktreeinclude", "cfg"]);
    git(repo, ["commit", "-q", "-m", "cfg as file"]);
    const old = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["rm", "-q", "--cached", "cfg"]);
    git(repo, ["commit", "-q", "-m", "drop cfg"]);
    rmSync(join(repo, "cfg"));
    mkdirSync(join(repo, "cfg"));
    writeFileSync(join(repo, "cfg", "secret"), "s\n");
    const sessionId = newSessionId();
    assert.throws(
      () => addWorktree({ repoRoot: repo, sessionId, name: "rollback", baseRef: old }),
      /\.worktreeinclude/
    );
    assert.equal(existsSync(worktreePathFor(repo, sessionId, "rollback")), false);
    assert.equal(
      git(repo, ["branch", "--list", worktreeBranchFor(sessionId, "rollback")]).trim(),
      ""
    );
    assert.equal(listWorktrees(repo).length, 1);
  } finally {
    cleanup();
  }
});

test("worktreePristine 给了分支时：提交之后把 HEAD 分离回起点，分支上的提交仍算改动", () => {
  const { repo, cleanup } = makeRepo();
  try {
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const w = addWorktree({ repoRoot: repo, sessionId: newSessionId(), name: "detach" });
    writeFileSync(join(w.path, "a.txt"), "edited\n");
    git(w.path, ["commit", "-q", "-am", "worker"]);
    git(w.path, ["checkout", "-q", "--detach", head]);
    assert.equal(worktreePristine(w.path, head), true, "只看 HEAD 会误判");
    assert.equal(worktreePristine(w.path, head, w.branch), false);
  } finally {
    cleanup();
  }
});
