// 决策 492：/worktrees clean 列出清单后，状态行问一次 `remove these worktrees? [y/N]`——y 删、别的键作罢。
// 不再有单独的 `/worktrees confirm` 命令。审计 13：等着时状态刷新不盖掉问句；来了审批，审批优先、按键不进 y/N；cancelled 只写一次。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { TuiWorktreesFace } from "../application/worktree-cleanup.ts";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell() {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-wt-confirm-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const calls: string[] = [];
  let pending = false;
  const face: TuiWorktreesFace = {
    run: () => {
      pending = true;
      calls.push("run");
      return "will remove 1 item: dirty";
    },
    hasPending: () => pending,
    confirmPending: () => {
      pending = false;
      calls.push("confirm");
      return "removed 1 item: dirty";
    },
    cancelPending: () => {
      pending = false;
      calls.push("cancel");
    },
  };
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, worktrees: face });
  shell.start();
  return {
    shell,
    term,
    calls,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("/worktrees clean 之后按 y 才删；状态行先问一句", async () => {
  const { term, calls, cleanup } = makeShell();
  try {
    await settle();
    term.input("/worktrees clean");
    term.input("\r");
    await settle(200);
    assert.ok(calls.includes("run"));
    assert.match(screenText(term), /remove these worktrees\? \[y\/N\]/);
    assert.doesNotMatch(screenText(term), /removed 1 item/, "问的时候还没删");
    term.input("y");
    await settle(200);
    assert.deepEqual(calls, ["run", "confirm"]);
    assert.match(screenText(term), /removed 1 item: dirty/);
  } finally {
    cleanup();
  }
});

test("/worktrees clean 之后按别的键即作罢，不删", async () => {
  const { term, calls, cleanup } = makeShell();
  try {
    await settle();
    term.input("/worktrees clean");
    term.input("\r");
    await settle(200);
    term.input("n");
    await settle(200);
    assert.deepEqual(calls, ["run", "cancel"]);
    assert.equal((screenText(term).match(/cancelled/g) ?? []).length, 1, "cancelled 只写一次");
  } finally {
    cleanup();
  }
});

test("等着 y/N 时状态刷新不盖掉问句", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    term.input("/worktrees clean");
    term.input("\r");
    await settle(200);
    shell.updateStatus();
    shell.render();
    await settle(50);
    assert.match(screenText(term), /remove these worktrees\? \[y\/N\]/);
  } finally {
    cleanup();
  }
});

test("等着 y/N 时来了审批：按键归审批，不触发删除；审批答完问句还在", async () => {
  const { shell, term, calls, cleanup } = makeShell();
  try {
    await settle();
    term.input("/worktrees clean");
    term.input("\r");
    await settle(200);
    const answer = shell.askApproval({
      toolName: "run_command",
      toolCallId: "t1",
      args: { command: "ls" },
    });
    await settle(50);
    term.input("y");
    const result = await answer;
    // 装配方的审批 handler 答完即收起审批块（同 approval.ts）
    shell.noteApproval("approved");
    await settle(50);
    assert.equal(result.key, "y", "y 答的是审批");
    assert.deepEqual(calls, ["run"], "没有删也没有作罢");
    assert.match(screenText(term), /remove these worktrees\? \[y\/N\]/, "问句回来了");
    term.input("n");
    await settle(200);
    assert.deepEqual(calls, ["run", "cancel"]);
  } finally {
    cleanup();
  }
});

test("等着 y/N 时再打一条命令即作罢，命令的第一个字不丢、照常执行", async () => {
  const { term, calls, cleanup } = makeShell();
  try {
    await settle();
    term.input("/worktrees clean");
    term.input("\r");
    await settle(200);
    term.input("/status");
    term.input("\r");
    await settle(200);
    assert.deepEqual(calls, ["run", "cancel"]);
    const screen = screenText(term);
    assert.match(screen, /cancelled/);
    assert.match(screen, /\/status is not available in this session/, "按命令执行，不当成普通输入");
  } finally {
    cleanup();
  }
});
