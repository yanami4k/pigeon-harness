// trace 工具调用行的审批结果、出错归类与工具级失败分类：字段取自工具结果消息 details 里的运行面标记，
// 分类由 storeToolOutcomes 现算，与会话列表同一口径。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { failureBadge } from "../application/format.ts";
import {
  createFixtureSession,
  type FixtureSession,
} from "../application/session-store-fixtures.ts";
import { loadSessionView } from "../persistence/session-catalog.ts";
import { listSessionSummaries } from "../persistence/session-list.ts";
import { TOOL_RESULT_MARK_KEY, type ToolResultMark } from "../state/session-judge.ts";
import { runTraceCommand } from "./trace.ts";

async function withRoot(body: (root: string, sessionsDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pigeon-trace-classes-"));
  try {
    await body(root, join(root, ".pigeon", "state", "sessions"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 一次调用：助手发起 → 带运行面标记的工具结果；返回工具调用号
function markedCall(
  s: FixtureSession,
  name: string,
  mark: ToolResultMark,
  isError: boolean,
  text = isError ? "出错了" : "ok"
): string {
  const [toolCallId = ""] = s.assistant({ toolCalls: [{ name }] });
  s.toolResult({
    toolCallId,
    toolName: name,
    text,
    isError,
    details: { [TOOL_RESULT_MARK_KEY]: mark },
  });
  return toolCallId;
}

// 报告里某次工具调用名下的行（到下一个工具调用或下一轮为止）；调用号在整份报告里唯一（夹具按会话连续编号）
function callBlock(output: string, toolCallId: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`    tool call ${toolCallId} `));
  assert.ok(start !== -1, `缺少工具调用 ${toolCallId}\n${output}`);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("      ")) {
      break;
    }
    block.push(line.trim());
  }
  return block;
}

interface Expected {
  id: string;
  approval?: string;
  errorKind?: string;
  badge: string;
}

async function markedSession(sessionsDir: string, root: string) {
  const s = createFixtureSession({ sessionsDir, cwd: root });
  s.startRun({
    task: "做",
    config: { policy: { allow: ["edit_file", "run_command"], deny: [], approvalMode: "prompt" } },
  });
  const expected: Expected[] = [];
  const add = (
    name: string,
    mark: ToolResultMark,
    isError: boolean,
    want: Omit<Expected, "id">
  ) => {
    // 审批行：措辞后括注批准来源原值（上游拦截没有审批闸决定，不括注）
    const approval =
      mark.gate !== undefined ? `${want.approval} (${mark.gate.approvedBy})` : want.approval;
    expected.push({
      id: markedCall(s, name, mark, isError),
      ...want,
      ...(approval !== undefined ? { approval } : {}),
    });
  };
  add("read_file", { gate: { outcome: "approved", approvedBy: "policy:auto" } }, false, {
    approval: "auto-allowed by policy",
    badge: "ok",
  });
  add("edit_file", { gate: { outcome: "approved", approvedBy: "human:grant" } }, false, {
    approval: "session grant",
    badge: "ok",
  });
  add("edit_file", { gate: { outcome: "approved", approvedBy: "policy:config" } }, false, {
    approval: "saved rule",
    badge: "ok",
  });
  add(
    "edit_file",
    { errorKind: "domain", gate: { outcome: "approved", approvedBy: "human" } },
    true,
    { approval: "approved by human", errorKind: "domain error", badge: "business failure" }
  );
  add(
    "run_command",
    { errorKind: "environment", gate: { outcome: "approved", approvedBy: "policy:yolo" } },
    true,
    { approval: "yolo", errorKind: "environment error", badge: "infrastructure error" }
  );
  add("edit_file", { gate: { outcome: "rejected", approvedBy: "human" } }, true, {
    approval: "rejected by human",
    badge: "ok",
  });
  add("run_command", { gate: { outcome: "rejected", approvedBy: "policy:deny" } }, true, {
    approval: "denied by policy",
    badge: "ok",
  });
  // 上游拦截：审批闸没跑过，只有域错误归类
  add("ghost_tool", { errorKind: "domain" }, true, {
    approval: "not gated (blocked upstream)",
    errorKind: "domain error",
    badge: "business failure",
  });
  add("edit_file", { gate: { outcome: "approved", approvedBy: "human" } }, true, {
    approval: "approved by human",
    badge: "unknown",
  });
  s.assistant({ text: "完成" });
  s.endRun();
  const { sessionId } = await s.close();
  return { sessionId, expected };
}

test("trace 工具调用行：审批结果与出错归类照工具结果消息的运行面标记显示，工具级分类由 storeToolOutcomes 现算", () =>
  withRoot(async (root, sessionsDir) => {
    const { sessionId, expected } = await markedSession(sessionsDir, root);
    const output = runTraceCommand({ root, sessionId });
    for (const want of expected) {
      const block = callBlock(output, want.id);
      const approval = block.filter((line) => line.startsWith("approval: "));
      assert.deepEqual(
        approval,
        want.approval !== undefined ? [`approval: ${want.approval}`] : [],
        `${want.id}\n${output}`
      );
      const errorKind = block.filter((line) => line.startsWith("error kind: "));
      assert.deepEqual(
        errorKind,
        want.errorKind !== undefined ? [`error kind: ${want.errorKind}`] : [],
        `${want.id}\n${output}`
      );
      assert.deepEqual(
        block.filter((line) => line.startsWith("class: ")),
        [`class: ${want.badge}`],
        `${want.id}\n${output}`
      );
    }
    // 会话级：trace 出现的失败徽章集合 = 会话列表摘要的失败分类
    const [summary] = listSessionSummaries(sessionsDir);
    assert.ok(summary !== undefined && summary.sessionId === sessionId);
    const badges = new Set(
      output
        .split("\n")
        .flatMap((line) => [...line.matchAll(/class: ([^|\n]+)/g)].map((match) => match[1]?.trim()))
        .filter((badge) => badge !== undefined && badge !== "ok")
    );
    assert.deepEqual(
      [...badges].sort(),
      summary.failureClasses.map((category) => failureBadge({ category } as never)).sort()
    );
    assert.deepEqual(
      [...badges].sort(),
      ["business failure", "infrastructure error", "unknown"].sort()
    );
    const view = loadSessionView(sessionsDir, sessionId);
    assert.ok(view !== undefined);
    // 逐个调用：trace 的分类行即 storeToolOutcomes 的结果
    for (const outcome of view.toolOutcomes) {
      assert.deepEqual(
        callBlock(output, outcome.toolCallId).filter((line) => line.startsWith("class: ")),
        [`class: ${failureBadge(outcome.failure)}`]
      );
    }
  }));

test("trace 工具调用行：没有运行面标记的结果不显示审批与出错归类，分类退回按消息正文与策略判；悬空调用分类未知；以中止收尾的助手消息里的调用未执行", () =>
  withRoot(async (root, sessionsDir) => {
    const s = createFixtureSession({ sessionsDir, cwd: root });
    s.startRun({
      task: "做",
      config: { policy: { allow: ["edit_file"], deny: ["run_command"], approvalMode: "prompt" } },
    });
    const ok = s.toolTurn({ name: "read_file" });
    const denied = s.toolTurn({ name: "run_command", result: "被拒", isError: true });
    const failed = s.toolTurn({ name: "edit_file", result: "炸了", isError: true });
    s.assistant({ text: "完成" });
    s.endRun();
    s.startRun({ task: "接着做" });
    const [aborted = ""] = s.assistant({
      toolCalls: [{ name: "edit_file" }],
      stopReason: "aborted",
    });
    s.endRun({ ending: "aborted" });
    s.startRun({ task: "再做" });
    const [dangling = ""] = s.assistant({ toolCalls: [{ name: "edit_file" }] });
    const { sessionId } = await s.close();
    const output = runTraceCommand({ root, sessionId });
    const expected: Array<[string, string[]]> = [
      [ok, ["class: ok"]],
      [denied, ["class: ok"]],
      [failed, ["class: unknown"]],
      [aborted, ["class: none (call not executed)"]],
      [dangling, ["class: unknown"]],
    ];
    for (const [id, want] of expected) {
      const block = callBlock(output, id);
      assert.ok(
        !block.some((line) => line.startsWith("approval: ") || line.startsWith("error kind: ")),
        `${id}\n${output}`
      );
      assert.deepEqual(
        block.filter((line) => line.startsWith("class: ")),
        want,
        `${id}\n${output}`
      );
    }
  }));
