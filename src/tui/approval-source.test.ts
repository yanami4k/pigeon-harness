// TUI 审批面板的来源与排队（M5.5 S3，决策 040）：别的会话的请求标明来源；经审批队列时面板一次只弹一个，
// 前一个决议后才弹下一个；[a] 放权写进请求来源会话自己的存储，主会话存储不动。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { createApprovalQueue } from "../approvals/queue.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId } from "../state/ids.ts";
import { createTuiApprovalHandler } from "./approval.ts";
import { PigeonTuiShell, type TuiRuntimeFace } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

class StubRuntime implements TuiRuntimeFace {
  run(): Promise<RunResult> {
    return Promise.withResolvers<RunResult>().promise;
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  listenerErrors(): unknown[] {
    return [];
  }
  subscribe(_listener: (event: EventEnvelope) => void): () => void {
    return () => {};
  }
  subscribeStream(_listener: (delta: StreamTextDelta) => void): () => void {
    return () => {};
  }
}

test("TUI 审批：别的会话的请求标明来源，排队一次只弹一个；[a] 放权只进它自己的存储", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-source-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  const term = new MockTerminal(100, 40);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new StubRuntime(),
    sessionId: newSessionId(),
    logDir,
  });
  try {
    const parentStore = new SessionGrantStore({ workspaceRoot: root });
    const storeA = new SessionGrantStore({ workspaceRoot: root });
    const storeB = new SessionGrantStore({ workspaceRoot: root });
    const queue = createApprovalQueue();
    const handler = queue.wrap(createTuiApprovalHandler(parentStore, () => shell));
    shell.start();
    await settle();

    const first = handler({
      toolName: "edit_file",
      toolCallId: "tc-1",
      args: { path: "src/first.ts" },
      sessionId: newSessionId(),
      pooled: { name: "fix-a" },
      grants: storeA,
    });
    const second = handler({
      toolName: "edit_file",
      toolCallId: "tc-2",
      args: { path: "src/second.ts" },
      sessionId: newSessionId(),
      pooled: { name: "fix-b" },
      grants: storeB,
    });
    await settle();
    let text = screenText(term);
    assert.ok(text.includes("source: session fix-a"), text);
    assert.equal(text.includes("src/second.ts"), false, `第二个请求在排队，未弹出\n${text}`);

    term.input("a");
    assert.deepEqual(await first, { approved: true });
    await settle();
    assert.equal(storeA.list().length, 1);
    assert.equal(parentStore.list().length, 0);
    text = screenText(term);
    assert.ok(text.includes("[fix-a] ✓ allowed for this session"), text);
    assert.ok(text.includes("source: session fix-b"), text);
    assert.ok(text.includes("src/second.ts"), text);

    term.input("n");
    assert.deepEqual(await second, { approved: false });
    assert.equal(storeB.list().length, 0);
  } finally {
    shell.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});
