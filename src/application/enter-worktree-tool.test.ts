// enter_worktree（决策 446）：工具本身（未绑定、已在工作树里、宿主不许移、建好与回调、名字不合法、未带过去的改动数）；
// 注册范围（终端界面主会话且 git 工作区才注册、系统提示带那一句；worker 委派、沙箱、非 git 不注册）；续接按主分支最后一条
// pigeon.worktree 条目回到工作树（目录不在即回主检出）；按工作树重建运行面。全局配置与 XDG 由测试总装指到临时位置。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import {
  createEnterWorktreeTool,
  ENTER_WORKTREE_PROMPT_SENTENCE,
  ENTER_WORKTREE_TOOL,
  EnterWorktreeSlot,
  recordWorktreeEntry,
} from "./enter-worktree-tool.ts";
import { noMcpSession } from "./mcp.ts";
import { openNamedWorktree, removeNamedWorktree, reopenNamedWorktree } from "./named-worktree.ts";
import { disposeRuntime } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";
import { takeWorkerChanges } from "./take-worker-tool.ts";
import { sessionRuntimeScope } from "./worker-scope.ts";
import { createSessionWorkers } from "./workers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-enter-wt-")));
  dirs.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, ["add", "a.txt"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

test("工具：未绑定如实说明；建好后回调待移入（不在工具里记条目），返回写明起点与没带过去的未提交改动数；宿主说不能移即拒绝", async () => {
  const root = repo();
  const slot = new EnterWorktreeSlot();
  const tool = createEnterWorktreeTool(slot);
  assert.match(textOf(await tool.execute("c0", { name: "x" })), /no terminal UI host/);
  const entered: Array<{ path: string; uncommitted: number }> = [];
  slot.bind({
    governanceRoot: root,
    workspaceRoot: () => root,
    baseMode: () => "head",
    onEntered: (worktree, uncommitted) => entered.push({ path: worktree.path, uncommitted }),
  });
  writeFileSync(join(root, "a.txt"), "edited\n");
  writeFileSync(join(root, "new.txt"), "n\n");
  const result = await tool.execute("c1", { name: "feature" });
  const text = textOf(result);
  const path = join(root, ".pigeon", "wt", "feature");
  assert.match(text, /^Created the worktree .* on branch pigeon-wt\/feature, starting from HEAD\./);
  assert.match(text, /The 2 uncommitted files in the current checkout were NOT carried over/);
  assert.match(text, /End this turn now with a brief reply/);
  assert.deepEqual(entered, [{ path, uncommitted: 2 }]);
  assert.ok(existsSync(join(path, "a.txt")));
  // 宿主说现在不能移（有 worker 在跑、本轮已有待移入）：拒绝、不建
  slot.bind({
    governanceRoot: root,
    workspaceRoot: () => root,
    baseMode: () => "head",
    blocked: () => "workers are still running or waiting for approval",
    onEntered: () => assert.fail("不该回调"),
  });
  const blocked = await tool.execute("c1b", { name: "later" });
  assert.match(textOf(blocked), /^Not now: workers are still running/);
  assert.equal(blocked.details.rejected, "blocked");
  assert.equal(existsSync(join(root, ".pigeon", "wt", "later")), false);
  // 已在工作树里：拒绝
  slot.bind({
    governanceRoot: root,
    workspaceRoot: () => path,
    baseMode: () => "head",
    onEntered: () => assert.fail("不该回调"),
  });
  assert.match(
    textOf(await tool.execute("c2", { name: "other" })),
    /already working in the worktree/
  );
  // 名字不合法：如实报失败
  slot.bind({
    governanceRoot: root,
    workspaceRoot: () => root,
    baseMode: () => "head",
    onEntered: () => assert.fail("不该回调"),
  });
  assert.match(
    textOf(await tool.execute("c3", { name: "Bad Name" })),
    /^Creating the worktree failed/
  );
});

async function open(root: string, extra: Record<string, unknown> = {}) {
  return openSessionRuntime({
    governanceRoot: root,
    sessionId: newSessionId(),
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    flags: {
      yolo: true,
      provider: "custom",
      modelId: "custom",
      persistThinking: true,
      pushedMemory: false,
    },
    homeDir: root,
    startMcp: noMcpSession,
    ...extra,
  });
}

// 跑一轮，读 Run 开始条目里记下的广告工具与系统提示
async function startOf(root: string, opened: Awaited<ReturnType<typeof open>>) {
  await opened.bundle.adapter.run("hi");
  await opened.bundle.sessionStore.flush();
  const start = loadStoreSession(sessionsDirOf(root), opened.bundle.adapter.sessionId)?.view.runs[0]
    ?.start;
  await disposeRuntime(opened.bundle);
  return { tools: start?.advertisedTools ?? [], prompt: start?.systemPrompt ?? "" };
}

test("注册范围：终端界面主会话且 git 工作区才注册、系统提示带那一句；没给槽、非 git 都不注册", async () => {
  const root = repo();
  const slot = new EnterWorktreeSlot();
  const withSlot = await startOf(root, await open(root, { enterWorktree: slot }));
  assert.ok(withSlot.tools.includes(ENTER_WORKTREE_TOOL), withSlot.tools.join(","));
  assert.ok(withSlot.prompt.includes(ENTER_WORKTREE_PROMPT_SENTENCE));
  const without = await startOf(root, await open(root));
  assert.ok(!without.tools.includes(ENTER_WORKTREE_TOOL));
  assert.ok(!without.prompt.includes(ENTER_WORKTREE_PROMPT_SENTENCE));
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-enter-wt-plain-")));
  dirs.push(plain);
  const nonGit = await startOf(plain, await open(plain, { enterWorktree: slot }));
  assert.ok(nonGit.tools.length > 0);
  assert.ok(!nonGit.tools.includes(ENTER_WORKTREE_TOOL));
});

test("续接按主分支最后一条 pigeon.worktree 回到工作树；按工作树重建的运行面工作区就是它；工作树不在即回主检出", async () => {
  const root = repo();
  const slot = new EnterWorktreeSlot();
  const first = await open(root, { enterWorktree: slot });
  const sessionId = first.bundle.adapter.sessionId;
  let path = "";
  try {
    slot.bind({
      governanceRoot: root,
      workspaceRoot: () => root,
      baseMode: () => "head",
      onEntered: (worktree) => {
        path = worktree.path;
      },
    });
    const tool = createEnterWorktreeTool(slot);
    await tool.execute("c1", { name: "moved" });
    await first.bundle.sessionStore.flush();
    // 工具本身不记条目：换成功之前续接仍回主检出
    assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, root);
    const worktree = reopenNamedWorktree(root, path);
    assert.ok(worktree !== undefined);
    recordWorktreeEntry(first.bundle.sessionStore, worktree);
    await first.bundle.sessionStore.flush();
  } finally {
    await disposeRuntime(first.bundle);
  }
  assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, path);
  const reopened = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
    homeDir: root,
    startMcp: noMcpSession,
    resume: true,
  });
  try {
    assert.equal(reopened.scope.workspaceRoot, path);
  } finally {
    await disposeRuntime(reopened.bundle);
  }
  const worktree = reopenNamedWorktree(root, path);
  assert.ok(worktree !== undefined);
  removeNamedWorktree(worktree);
  assert.equal(sessionRuntimeScope(root, sessionId).workspaceRoot, root);
});

test("移进工作树之后：worker 从工作树开工（带上工作树里未提交的改动），/take 把改动写进工作树而不是主检出", async () => {
  const root = repo();
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-enter-wt-home-")));
  dirs.push(home);
  const worktree = openNamedWorktree({ cwd: root, name: "moved", baseMode: "head" });
  writeFileSync(join(worktree.path, "wt-only.txt"), "only in the worktree\n");
  // 与终端界面重建时一样：按工作树打开运行面，worker 编排按运行面自己的工作区
  const opened = await open(root, { workspaceRoot: worktree.path });
  try {
    assert.equal(opened.scope.workspaceRoot, worktree.path);
    const orchestrator = createSessionWorkers({
      governanceRoot: root,
      workspaceRoot: opened.scope.workspaceRoot,
      bundle: opened.bundle,
      approvals: async () => ({ approved: true }),
      streamFn: createFakeStreamFn({
        replies: [
          {
            text: "写",
            toolCalls: [{ name: "write_file", args: { path: "w.txt", content: "from worker\n" } }],
          },
          { text: "好了" },
        ],
      }),
      provider: "custom",
      modelId: "custom",
      homeDir: home,
    });
    const id = orchestrator.spawn({ role: "implementer", task: "写一个文件", name: "w1" });
    const outcome = await orchestrator.awaitResult(id);
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const workerPath = (outcome.workspace as { path: string }).path;
    assert.ok(existsSync(join(workerPath, "wt-only.txt")), "worker 的起点是工作树的快照");
    const taken = takeWorkerChanges(
      { orchestrator, workspaceRoot: opened.scope.workspaceRoot },
      "w1"
    );
    assert.equal(taken.details.rejected, undefined, taken.text);
    assert.equal(readFileSync(join(worktree.path, "w.txt"), "utf8"), "from worker\n");
    assert.equal(existsSync(join(root, "w.txt")), false, "主检出不动");
  } finally {
    await disposeRuntime(opened.bundle);
  }
});
