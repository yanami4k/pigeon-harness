// 会话回退的代码写回护栏（决策 436）：上级目录是目录联接或符号链接时不写（不跟随链接写到仓库外）；.pigeon 下不碰；
// 磁盘上有、现状快照里没有的（被忽略、过大）不碰；规划之后又被改过的不碰；目标是符号链接的不写；原样字节往返。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { restoreFiles, SnapshotTrees } from "./rewind-restore.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

// 这台机器的临时目录所在的文件系统不分大小写（Windows、macOS 缺省）
function caseInsensitiveFs(): boolean {
  const dir = temp("pigeon-restore-case-");
  writeFileSync(join(dir, "probe"), "");
  return existsSync(join(dir, "PROBE"));
}

// 文件按仓库规则规范化后的对象号（与快照同一口径）
function blobOf(root: string, path: string): string {
  return git(root, ["hash-object", `--path=${path}`, "--", join(root, path)]);
}

// 仓库与一次提交（当作快照）；返回提交号
function repo(files: Record<string, string>): { root: string; commit: string } {
  const root = temp("pigeon-restore-");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "snap"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

test("上级目录是目录联接（或符号链接）时不写，链接指向的仓库外文件不动", () => {
  const outside = temp("pigeon-restore-outside-");
  writeFileSync(join(outside, "f.txt"), "outside\n");
  const { root, commit } = repo({ "a.txt": "target\n" });
  symlinkSync(outside, join(root, "link"), "junction");
  const trees = new SnapshotTrees(root);
  const target = trees.file(commit, "a.txt");
  assert.ok(target !== undefined);
  const result = restoreFiles({
    trees,
    actions: [{ path: "link/f.txt", target }],
  });
  assert.deepEqual(result.written, []);
  assert.match(result.skipped[0]?.reason ?? "", /符号链接或目录联接/);
  assert.equal(readFileSync(join(outside, "f.txt"), "utf8"), "outside\n");
});

test(".pigeon 下不碰；目标是符号链接不写；磁盘上有、现状快照里没有的不碰；规划之后又被改过的不碰", () => {
  const { root, commit } = repo({ "a.txt": "target\n", "b.txt": "target b\n" });
  const trees = new SnapshotTrees(root);
  const target = trees.file(commit, "a.txt");
  const current = trees.file(commit, "b.txt");
  assert.ok(target !== undefined && current !== undefined);
  mkdirSync(join(root, ".pigeon"));
  writeFileSync(join(root, ".pigeon", "x.txt"), "state\n");
  writeFileSync(join(root, "ignored.log"), "big or ignored\n");
  writeFileSync(join(root, "b.txt"), "changed after planning\n");
  const result = restoreFiles({
    trees,
    actions: [
      { path: ".pigeon/x.txt", current: { mode: "100644", blob: blobOf(root, ".pigeon/x.txt") } },
      { path: "link.txt", target: { mode: "120000", blob: target.blob } },
      { path: "ignored.log", target },
      { path: "b.txt", target, current },
    ],
  });
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(
    result.skipped.map((item) => item.path),
    [".pigeon/x.txt", "link.txt", "ignored.log", "b.txt"]
  );
  assert.equal(readFileSync(join(root, ".pigeon", "x.txt"), "utf8"), "state\n");
  assert.equal(readFileSync(join(root, "ignored.log"), "utf8"), "big or ignored\n");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "changed after planning\n");
  assert.equal(existsSync(join(root, "link.txt")), false);
});

test("覆盖与删除之前存下原样字节：再写回时规范化内容相同即写原样字节", () => {
  const { root, commit } = repo({ "a.txt": "line\n" });
  git(root, ["config", "core.autocrlf", "true"]);
  const trees = new SnapshotTrees(root);
  const lf = trees.file(commit, "a.txt");
  assert.ok(lf !== undefined);
  // 现状是 LF（agent 写的）；core.autocrlf=true 下按检出规则写回会变成 CRLF，存下的原样字节让它回到 LF
  const removed = restoreFiles({ trees, actions: [{ path: "a.txt", current: lf }] });
  assert.deepEqual(removed.removed, ["a.txt"]);
  assert.equal(existsSync(join(root, "a.txt")), false);
  const back = restoreFiles({
    trees,
    actions: [{ path: "a.txt", target: lf }],
    saved: removed.saved,
  });
  assert.deepEqual(back.written, ["a.txt"]);
  assert.deepEqual(readFileSync(join(root, "a.txt")), Buffer.from("line\n"));
  // 没存下原样字节：按检出规则写（行尾按仓库配置转换）
  rmSync(join(root, "a.txt"));
  restoreFiles({ trees, actions: [{ path: "a.txt", target: lf }] });
  assert.deepEqual(readFileSync(join(root, "a.txt")), Buffer.from("line\r\n"));
});

test("没有存下原样字节、磁盘上的文件是 LF 时照 LF 写（行尾转换开着也一样）；有 CRLF 的按检出规则写", () => {
  const { root, commit } = repo({ "a.txt": "target\n", "b.txt": "target b\n" });
  git(root, ["config", "core.autocrlf", "true"]);
  const trees = new SnapshotTrees(root);
  const a = trees.file(commit, "a.txt");
  const b = trees.file(commit, "b.txt");
  assert.ok(a !== undefined && b !== undefined);
  writeFileSync(join(root, "a.txt"), "now lf\n");
  writeFileSync(join(root, "b.txt"), "now crlf\r\n");
  const result = restoreFiles({
    trees,
    actions: [
      { path: "a.txt", target: a, current: { mode: "100644", blob: blobOf(root, "a.txt") } },
      { path: "b.txt", target: b, current: { mode: "100644", blob: blobOf(root, "b.txt") } },
    ],
  });
  assert.deepEqual(result.failed, undefined);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.written, ["a.txt", "b.txt"]);
  assert.deepEqual(readFileSync(join(root, "a.txt")), Buffer.from("target\n"));
  assert.deepEqual(readFileSync(join(root, "b.txt")), Buffer.from("target b\r\n"));
});

test("没有原样字节时行尾按工作区当前的 .gitattributes（*.sh text eol=lf 在行尾转换开着时仍写 LF）", () => {
  const { root, commit } = repo({
    "build.sh": "echo hi\n",
    ".gitattributes": "*.sh text eol=lf\n",
  });
  git(root, ["config", "core.autocrlf", "true"]);
  const trees = new SnapshotTrees(root);
  const target = trees.file(commit, "build.sh");
  assert.ok(target !== undefined);
  rmSync(join(root, "build.sh"));
  const result = restoreFiles({ trees, actions: [{ path: "build.sh", target }] });
  assert.deepEqual(result.written, ["build.sh"]);
  assert.deepEqual(readFileSync(join(root, "build.sh")), Buffer.from("echo hi\n"));
});

test.skipIf(!caseInsensitiveFs())(
  "文件系统不分大小写：只差大小写的两条一律不写，.Pigeon 也当 .pigeon",
  () => {
    const { root, commit } = repo({ "a.txt": "target\n" });
    const trees = new SnapshotTrees(root);
    const target = trees.file(commit, "a.txt");
    assert.ok(target !== undefined);
    assert.equal(trees.ignoreCase, true);
    rmSync(join(root, "a.txt"));
    const result = restoreFiles({
      trees,
      actions: [
        { path: "A.txt", target },
        { path: "a.txt", target },
        { path: ".Pigeon/state/x", target },
      ],
    });
    assert.deepEqual(result.written, []);
    assert.deepEqual(
      result.skipped.map((item) => item.path),
      ["A.txt", "a.txt", ".Pigeon/state/x"]
    );
    assert.equal(existsSync(join(root, "a.txt")), false);
  }
);
