// 决策 445、446、494：续接回到会话的工作目录——主分支上最后一条 pigeon.worktree 条目（必须在 .pigeon/trees 下、目录还在）优先，
// 其次会话文件头记的工作目录；都不成即回到项目根（主检出）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { worktreesDirOf } from "../state/paths.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { sessionRuntimeScope } from "./session-scope.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";
import { sessionsDirOf } from "./workspace.ts";

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-scope-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function worktreeEntry(path: string) {
  return {
    customType: SessionEntryType.Worktree,
    data: {
      version: SESSION_ENTRY_VERSION,
      name: "feature-x",
      path,
      branch: "pigeon/feature-x",
      baseLabel: "HEAD",
      created: true,
      enteredAt: 1,
    },
  } as never;
}

test("没有工作树条目：工作目录就是项目根", async () => {
  await withRoot(async (root) => {
    const sessionId = newSessionId();
    const writer = createFixtureSession({ sessionsDir: sessionsDirOf(root), sessionId, cwd: root });
    writer.append({
      customType: SessionEntryType.RunStart,
      data: { version: SESSION_ENTRY_VERSION, runId: "r1", input: "做点事", at: 1 },
    } as never);
    await writer.close();
    assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, root);
  });
});

test("文件头记着 .pigeon/trees 下的工作树（--worktree、/clear）：续接回到那里", async () => {
  await withRoot(async (root) => {
    const tree = join(worktreesDirOf(root), "feature-x");
    mkdirSync(tree, { recursive: true });
    const sessionId = newSessionId();
    const writer = createFixtureSession({ sessionsDir: sessionsDirOf(root), sessionId, cwd: tree });
    await writer.close();
    assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, tree);
  });
});

test("工作树条目指向的树没了：回到项目根，不报错", async () => {
  await withRoot(async (root) => {
    const gone = join(worktreesDirOf(root), "gone");
    const sessionId = newSessionId();
    const writer = createFixtureSession({ sessionsDir: sessionsDirOf(root), sessionId, cwd: root });
    writer.append(worktreeEntry(gone));
    await writer.close();
    assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, root);
  });
});

test("不在 .pigeon/trees 下的目录不认：回到项目根", async () => {
  await withRoot(async (root) => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const sessionId = newSessionId();
    const writer = createFixtureSession({ sessionsDir: sessionsDirOf(root), sessionId, cwd: root });
    writer.append(worktreeEntry(elsewhere));
    await writer.close();
    assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, root);
  });
});
