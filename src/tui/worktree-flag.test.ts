// 决策 445：--worktree <名字> 的取法
import assert from "node:assert/strict";
import { test } from "vitest";
import { takeWorktreeFlag, WORKTREE_FLAG_USAGE } from "./worktree-flag.ts";

test("--worktree <名字> 与 --worktree=<名字>；其余参数原样；缺名字、以 - 开头、给两次报错", () => {
  assert.deepEqual(takeWorktreeFlag(["--yolo", "--worktree", "feat", "--model", "m"]), {
    argv: ["--yolo", "--model", "m"],
    name: "feat",
  });
  assert.deepEqual(takeWorktreeFlag(["--worktree=fix-1"]), { argv: [], name: "fix-1" });
  assert.deepEqual(takeWorktreeFlag(["--yolo"]), { argv: ["--yolo"] });
  assert.throws(() => takeWorktreeFlag(["--worktree"]), { message: WORKTREE_FLAG_USAGE });
  assert.throws(() => takeWorktreeFlag(["--worktree", "--yolo"]), { message: WORKTREE_FLAG_USAGE });
  assert.throws(
    () => takeWorktreeFlag(["--worktree=a", "--worktree", "b"]),
    /given more than once/
  );
});
