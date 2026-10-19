// TUI 审批面板的去处与放权落点（M5.5 S3，决策 040；决策 509）：审批只在它所属的会话里出现——别的会话的请求不弹到当前会话，
// 换到那个会话才出现；[a] 放权写进请求自己的存储，别的存储不动。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
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

test("TUI 审批：别的会话的请求不弹到当前会话、换到它才出现；[a] 放权只进请求自己的存储", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-source-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-log-"));
  const term = new MockTerminal(100, 40);
  const sessionId = newSessionId();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new StubRuntime(),
    sessionId,
    logDir,
  });
  try {
    const parentStore = new SessionGrantStore({ workspaceRoot: root });
    const storeA = new SessionGrantStore({ workspaceRoot: root });
    const storeB = new SessionGrantStore({ workspaceRoot: root });
    const handler = createTuiApprovalHandler(parentStore, () => shell);
    shell.start();
    await settle();
    const elsewhereId = newSessionId();
    const away = handler({
      toolName: "edit_file",
      toolCallId: "tc-2",
      args: { path: "src/second.ts" },
      sessionId: elsewhereId,
      grants: storeB,
    });
    const own = handler({
      toolName: "edit_file",
      toolCallId: "tc-1",
      args: { path: "src/first.ts" },
      sessionId,
      grants: storeA,
    });
    await settle();
    let text = screenText(term);
    assert.ok(text.includes("src/first.ts"), text);
    assert.equal(text.includes("src/second.ts"), false, `别的会话的请求不弹到这里\n${text}`);

    term.input("a");
    assert.deepEqual(await own, { approved: true });
    await settle();
    assert.equal(storeA.list().length, 1);
    assert.equal(parentStore.list().length, 0);
    text = screenText(term);
    assert.ok(text.includes("✓ allowed for this session"), text);
    assert.equal(text.includes("src/second.ts"), false);

    // 换到那个会话：它的请求出现
    shell.rebindSession(elsewhereId, { runtime: new StubRuntime() });
    await settle();
    assert.ok(screenText(term).includes("src/second.ts"), screenText(term));
    term.input("n");
    assert.deepEqual(await away, { approved: false });
    assert.equal(storeB.list().length, 0);
  } finally {
    shell.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});
