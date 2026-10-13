// 决策 450：命令行对话里，别的会话发来的消息进通知队列；空行回车即开一轮交给 agent（没开这个选项时空行照旧什么都不做）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { buildRuntime, disposeRuntime } from "../application/runtime.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { runRepl } from "./repl.ts";

async function replWith(runPendingNotices: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-repl-notices-"));
  const streamFn = createFakeStreamFn({ replies: [{ text: "收到" }] });
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "custom",
    modelId: "custom",
    homeDir: root,
  });
  const out: string[] = [];
  const lines = [""];
  try {
    bundle.adapter.notify("[Cross-session message] from other: hello");
    await runRepl({
      adapter: bundle.adapter,
      ask: async () => lines.shift() ?? null,
      write: (text) => out.push(text),
      ...(runPendingNotices ? { runPendingNotices: true } : {}),
    });
    return { calls: streamFn.calls, out: out.join(""), pending: bundle.adapter.pendingNotices() };
  } finally {
    await disposeRuntime(bundle);
    rmSync(root, { recursive: true, force: true });
  }
}

test("空行回车：有已到的消息即开一轮交给 agent", async () => {
  const { calls, out, pending } = await replWith(true);
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0]?.context.messages).includes("from other: hello"));
  assert.match(out, /终态：completed/);
  assert.equal(pending, 0);
});

test("没开这个选项：空行照旧什么都不做，消息留着随下一条任务带上", async () => {
  const { calls, pending } = await replWith(false);
  assert.equal(calls.length, 0);
  assert.equal(pending, 1);
});
