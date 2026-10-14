// 决策 469：审批模式可在会话中途切换——运行面按当前模式判定（快照冻结不变）：切到放手后新的调用不再问人、切回又要问；
// 每个 Run 开头记下当时的模式；切换写进会话记录，trace 看得到（Run 之外的列在会话级条目里）。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runTraceCommand } from "../cli/trace.ts";
import { PiRuntimeAdapter } from "../pi-runtime/adapter.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { INJECTION_SNAPSHOT_VERSION, type InjectionSnapshot } from "../pi-runtime/snapshot.ts";
import { newSessionId } from "../state/ids.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { createLocalWorkspaceHost } from "../tools/local-host.ts";
import type { ApprovalMode } from "../tools/policy.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createReplaceEditTool, ReplaceEditParamsSchema } from "../tools/replace-edit.ts";
import { createToolGovernance } from "./governance.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";

test("运行面按当前模式判定：询问模式下没有审批通道即拒绝，切到放手后同样的调用直接放行，切回又拒绝；快照不变", async () => {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-approval-mode-")));
  writeFileSync(join(ws, "a.txt"), "one\n");
  try {
    const registry = new ToolRegistry();
    registry.register({
      name: "edit_file",
      description: "改文件",
      parameters: ReplaceEditParamsSchema,
      tier: "write",
      pathConfinement: { kind: "workspace" },
      executionMode: "sequential",
    });
    const snapshot: InjectionSnapshot = {
      version: INJECTION_SNAPSHOT_VERSION,
      model: { provider: "fake-provider", id: "fake-model-1" },
      tools: {
        policy: { allow: ["edit_file"], deny: [], approvalMode: "prompt" },
        advertised: ["edit_file"],
      },
      context: { systemPrompt: "测试" },
      memory: [],
      skills: [],
      createdAt: 1700000000000,
    };
    const edit = (from: string, to: string) => ({
      text: "改",
      toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: from, new_string: to } }],
    });
    const cell: { current: ApprovalMode } = { current: "prompt" };
    const adapter = new PiRuntimeAdapter({
      snapshot,
      approvalMode: () => cell.current,
      streamFn: createFakeStreamFn({
        replies: [
          edit("one", "two"),
          { text: "完" },
          edit("one", "two"),
          { text: "完" },
          edit("two", "three"),
          { text: "完" },
        ],
      }),
      governance: createToolGovernance({ registry, workspaceRoot: ws }),
      tools: [createReplaceEditTool(createLocalWorkspaceHost(ws))],
      sessionId: newSessionId(),
    });
    const decisions = async () =>
      (await adapter.run("改")).toolExecutions.map((record) => record.decision?.approvedBy);
    assert.equal(adapter.approvalMode(), "prompt");
    assert.deepEqual(await decisions(), ["policy:deny"]);
    cell.current = "yolo";
    assert.equal(adapter.approvalMode(), "yolo");
    assert.deepEqual(await decisions(), ["policy:yolo"]);
    cell.current = "prompt";
    assert.deepEqual(await decisions(), ["policy:deny"]);
    assert.equal(adapter.snapshot().tools.policy.approvalMode, "prompt", "快照冻结不变");
    await adapter.dispose();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("切换写进会话记录：trace 在 Run 之外的会话级条目里列出（时刻、从什么到什么）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-approval-mode-trace-"));
  try {
    const session = createFixtureSession({
      sessionsDir: join(root, ".pigeon", "state", "sessions"),
    });
    session.startRun({ task: "改" });
    session.endRun();
    session.writer.append({
      customType: SessionEntryType.ApprovalMode,
      data: {
        version: SESSION_ENTRY_VERSION,
        from: "prompt",
        to: "yolo",
        changedAt: Date.UTC(2026, 9, 14, 8, 30, 0),
      },
    });
    const { sessionId } = await session.close();
    const trace = runTraceCommand({ root, sessionId });
    assert.match(trace, /session entries:\n {2}approval mode: ask -> yolo at 08:30:00\(UTC\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
