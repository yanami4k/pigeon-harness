// 第二轮验收复查的修正（决策 460–462）：答完的审批收成一行时多行命令只取首行；[r] 写理由的提示在状态行、答完不留残行；另有审批挂着（BUSY）时不收别人的块。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { newSessionId } from "../state/ids.ts";
import { createTuiApprovalHandler } from "./approval.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle } from "./testing.ts";

function makeShell(extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-review-fixes-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(120, 40);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, ...extra });
  return {
    shell,
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

const MULTILINE: ApprovalRequest = {
  toolName: "run_command",
  toolCallId: "tc-1",
  args: { command: "cat <<EOF\nhello there\nEOF" },
  tier: "exec",
  command: "cat <<EOF\nhello there\nEOF",
} as unknown as ApprovalRequest;

test("答完的审批收成一行：多行命令只取首行（不把换行带进按行渲染的全屏）", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    const handler = createTuiApprovalHandler(
      new SessionGrantStore({ workspaceRoot: "/nonexistent" }),
      () => shell
    );
    const pending = handler(MULTILINE);
    await settle();
    // 挂着时审批区里命令逐行显示
    assert.match(screenText(term), /│ cat <<EOF +│\n +│ hello there +│\n +│ EOF +│/);
    term.input("y");
    assert.deepEqual(await pending, { approved: true });
    await settle();
    assert.doesNotMatch(screenText(term), /╭/, "答完审批区收起");
    const rows = screenText(term).split("\n");
    assert.ok(
      rows.some((row) => row.includes("✓ approved run_command: cat <<EOF …")),
      rows.join("\n")
    );
    assert.ok(
      !rows.some((row) => row.trim() === "hello there" || row.trim() === "EOF"),
      "命令的其余行不留"
    );
  } finally {
    cleanup();
  }
});

test("[r] 写理由：提示在状态行，答完消息区只剩一行结论（没有残留的理由提示行）", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    const handler = createTuiApprovalHandler(
      new SessionGrantStore({ workspaceRoot: "/nonexistent" }),
      () => shell
    );
    const pending = handler({
      toolName: "edit_file",
      toolCallId: "tc-2",
      args: { path: "src/a.ts" },
    } as unknown as ApprovalRequest);
    await settle();
    term.input("r");
    await settle();
    assert.match(screenText(term), /reason for rejecting \(enter to send, esc to go back\)/);
    term.input("不要动它");
    term.input("\r");
    assert.deepEqual(await pending, { approved: false, reason: "不要动它", reasonSource: "human" });
    await settle();
    const text = screenText(term);
    assert.match(screenFlat(term), /✗ rejected edit_file: src\/a\.ts \(不要动它\)/);
    assert.doesNotMatch(text, /reason for rejecting/, "状态行恢复");
    assert.ok(!text.split("\n").some((row) => /^\s*reason:\s*$/.test(row)), "没有残留的理由提示行");
  } finally {
    cleanup();
  }
});

test("另有审批挂着（BUSY）时被拒的请求不去收起挂着的那一块；挂着的那一块答完收成它自己的一行", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    const handler = createTuiApprovalHandler(
      new SessionGrantStore({ workspaceRoot: "/nonexistent" }),
      () => shell
    );
    const first = handler({
      toolName: "edit_file",
      toolCallId: "tc-a",
      args: { path: "src/first.ts" },
    } as unknown as ApprovalRequest);
    await settle();
    const second = await handler({
      toolName: "edit_file",
      toolCallId: "tc-b",
      args: { path: "src/second.ts" },
    } as unknown as ApprovalRequest);
    assert.equal(second.approved, false);
    await settle();
    assert.match(screenText(term), /│ src\/first\.ts +│/, "挂着的那一块还在审批区里");
    assert.doesNotMatch(screenFlat(term), /second\.ts/);
    term.input("y");
    assert.deepEqual(await first, { approved: true });
    await settle();
    const flat = screenFlat(term);
    assert.match(flat, /✓ approved edit_file: src\/first\.ts/);
    assert.doesNotMatch(flat, /rejected edit_file: src\/first\.ts/);
  } finally {
    cleanup();
  }
});
