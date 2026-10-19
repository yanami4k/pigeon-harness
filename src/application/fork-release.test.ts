// 分叉准备阶段（决策 494）：建好分叉工作树即持有它的在用标记；之后释放来源会话的写者（storeFork.release）抛错时，
// 在用标记也一并放掉，不留到进程退出。这里把 beginStoreFork 换成释放时抛错的版本，走真实的 prepareFork
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { worktreeInUse } from "../persistence/worktree-in-use.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { worktreesDirOf } from "../state/paths.ts";
import { prepareFork } from "./fork.ts";
import type { McpSession } from "./mcp.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { isStatusText } from "./status-fixtures.ts";

vi.mock("./session-store.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./session-store.ts")>();
  return {
    ...original,
    beginStoreFork: async (...args: Parameters<typeof original.beginStoreFork>) => {
      const fork = await original.beginStoreFork(...args);
      if (fork === undefined) return fork;
      return {
        ...fork,
        release: async () => {
          await fork.release();
          throw new Error("releasing the source session failed");
        },
      };
    },
  };
});

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("释放来源会话的写者抛错：分叉工作树的在用标记照样放掉", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-fork-release-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-fork-release-home-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.email", "pigeon@example.invalid"]);
    git(dir, ["config", "user.name", "pigeon-test"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(dir, ".gitignore"), ".pigeon/\n");
    writeFileSync(join(dir, "a.txt"), "old\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    const sourceId = newSessionId();
    const opened = await openSessionRuntime({
      governanceRoot: dir,
      sessionId: sourceId,
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "改",
            toolCalls: [
              {
                name: "edit_file",
                args: { path: "a.txt", old_string: "old\n", new_string: "new\n" },
              },
            ],
          },
          { text: "改好了" },
        ],
      }),
      flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
      startMcp: noMcp,
      homeDir: home,
    });
    try {
      await opened.bundle.adapter.run("把 a.txt 改成 new");
      await opened.checkpoints?.settle();
      await opened.bundle.sessionStore.flush();
      const loaded = loadStoreSession(join(dir, ".pigeon", "state", "sessions"), sourceId);
      const run = loaded?.view.runs[0];
      assert.ok(run !== undefined);
      const runSeq =
        run.messages.findIndex(
          (ref) =>
            ref.message.role === "user" &&
            !isStatusText(
              typeof ref.message.content === "string"
                ? ref.message.content
                : JSON.stringify(ref.message.content)
            )
        ) + 1;
      await assert.rejects(
        prepareFork({
          governanceRoot: dir,
          sourceSessionId: sourceId,
          sourceStore: opened.bundle.sessionStore,
          forkPoint: { runId: run.runId, runSeq },
          trigger: "manual",
          homeDir: home,
        }),
        /releasing the source session failed/
      );
      const trees = readdirSync(worktreesDirOf(dir));
      assert.equal(trees.length, 1, "分叉工作树已建");
      assert.equal(
        worktreeInUse(join(worktreesDirOf(dir), trees[0] ?? ""), { homeDir: home }),
        false,
        "在用标记已放掉"
      );
    } finally {
      await disposeRuntime(opened.bundle).catch(() => {});
    }
  } finally {
    try {
      git(dir, ["worktree", "prune"]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
