// 决策 473：运行面在 Run 开始（与写档、命令之后）重读 git 状态时把分支记进会话，变了才记一条；续接列表取会话最后记的那条
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { listRecentMainSessions } from "./recent-sessions.ts";
import { buildRuntime } from "./runtime.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// 这个测试结束后删掉仓库目录
function tempRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-git-head-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pigeon@example.invalid");
  git(root, "config", "user.name", "pigeon-test");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(join(root, ".gitignore"), ".pigeon/\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("同一分支跑两轮只记一条；换了分支再跑一轮多记一条；续接列表取最后的分支", async () => {
  const root = tempRepo();
  git(root, "checkout", "-q", "-b", "feature/login");
  const sessionId = newSessionId();
  const bundle = buildRuntime({
    streamFn: createFakeStreamFn({ replies: [{ text: "一" }, { text: "二" }, { text: "三" }] }),
    workspaceRoot: root,
    governanceRoot: root,
    settings: emptySettingsSnapshot(root),
    sessionId,
    yolo: true,
    provider: "fake-provider",
    modelId: "fake-model-1",
  });
  try {
    await bundle.adapter.run("第一轮");
    await bundle.adapter.run("第二轮");
    git(root, "checkout", "-q", "-b", "feature/next");
    await bundle.adapter.run("第三轮");
  } finally {
    await bundle.adapter.dispose();
    await bundle.sessionStore.close();
  }
  const view = loadSessionView(join(root, ".pigeon", "state", "sessions"), sessionId);
  const heads = (view?.items ?? [])
    .filter((item) => item.kind === "git-head")
    .map((item) => (item.kind === "git-head" ? item.data.branch : undefined));
  assert.deepEqual(heads, ["feature/login", "feature/next"]);
  assert.equal(listRecentMainSessions(root)[0]?.branch, "feature/next");
});
