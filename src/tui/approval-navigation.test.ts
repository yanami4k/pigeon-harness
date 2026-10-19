// 决策 508：审批挂着时只有回答键归审批，导航照常——连按两下 ← 开会话面板、↓ 进子 agent 面板、↑↓/Enter 切换视角、Esc 回输入框；
// 审批框钉在各视图底部直到答完；输入框不收打字；当前会话的审批挂着时不换会话（审批区只有一个）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { PooledSessionCard, SessionPanelSource } from "../application/session-pool.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { APPROVAL_BEFORE_SWITCH, PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(runtime = new ScriptedRuntime(newSessionId())) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-approval-nav-"));
  const term = new MockTerminal(110, 34);
  const agent = {
    kind: "agent",
    agentName: "general-1",
    name: () => "general-1",
    type: { name: "general" },
    path: "general-1",
    parent: { kind: "session", name: () => "main" },
    state: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as SubagentRecord;
  const stopped: string[] = [];
  const entered: string[] = [];
  const spawned: string[] = [];
  const peeked: string[] = [];
  const halted: string[] = [];
  const other: PooledSessionCard = {
    id: "sess_other",
    name: "other",
    state: "idle",
    task: "别的任务",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
  };
  const source: SessionPanelSource = {
    list: () => [other],
    subscribe: () => () => {},
    spawn: async (task) => {
      spawned.push(task);
      throw new Error("unused");
    },
    send: async () => undefined,
    stop: async (id) => {
      halted.push(id);
    },
    remove: async () => {},
    peek: async (id) => {
      peeked.push(id);
      return [];
    },
  };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: newSessionId(),
    logDir,
    sessionName: () => "demo-main",
    agents: {
      list: () => [agent],
      running: () => 1,
      stop: async (record) => {
        stopped.push(record.agentName);
      },
      send: () => undefined,
      live: () => undefined,
      historyDir: () => undefined,
    },
    pool: {
      source,
      enter: async (id) => {
        entered.push(id);
        return undefined;
      },
    },
  });
  shell.start();
  return {
    shell,
    term,
    stopped,
    entered,
    spawned,
    peeked,
    halted,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("审批挂着：打字不进输入框；↓ 进子 agent 面板并切到它的视图，审批框跟着钉在底部；Esc 不中断；两下 ← 开会话面板；换会话先要答完；y 照常回答", async () => {
  const { shell, term, stopped, entered, cleanup } = makeShell();
  try {
    await settle();
    const answer = shell.askApproval({
      toolName: "run_command",
      toolCallId: "t1",
      args: { command: "npm test" },
    });
    await settle();
    assert.match(screenText(term), /npm test/);
    term.input("hello");
    await settle();
    assert.equal(shell.inputText(), "", "输入框不收打字");
    // ↓ 进子 agent 面板，Enter 切到它的视图
    term.input("\x1b[B");
    await settle();
    assert.match(screenText(term), /› general-1/);
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "agent");
    assert.match(screenText(term), /npm test/, "审批框在子 agent 视图里照样钉在底部");
    term.input("\x1b");
    await settle();
    assert.deepEqual(stopped, [], "审批挂着时 Esc 不中断子 agent");
    assert.equal(shell.currentView(), "agent");
    // 面板里选 main 回主代理
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    // 两下 ← 开会话面板，审批框还在
    term.input("\x1b[D");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "panel");
    assert.match(screenText(term), /npm test/);
    // 光标移到别的会话、Enter：当前会话的审批还挂着，不换
    term.input("\x1b[B");
    await settle();
    assert.match(screenText(term), /> other/);
    term.input("\r");
    await settle();
    assert.deepEqual(entered, []);
    assert.match(screenText(term), new RegExp(APPROVAL_BEFORE_SWITCH));
    // 回答键照旧归审批
    term.input("y");
    const result = await answer;
    assert.equal(result.key, "y");
    shell.noteApproval("✓ approved run_command");
    await settle();
    // 答完之后再进：照常换过去
    term.input("\r");
    await settle();
    assert.deepEqual(entered, ["sess_other"]);
  } finally {
    cleanup();
  }
});

test("审批挂着：r 写拒绝理由时按键照旧交给输入区（方向键不切视图）", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const answer = shell.askApproval({
      toolName: "run_command",
      toolCallId: "t2",
      args: { command: "rm -rf build" },
    });
    await settle();
    term.input("r");
    await settle();
    term.input("too risky");
    term.input("\x1b[D");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "main", "理由行里 ← 是移光标");
    assert.equal(shell.inputText(), "too risky");
    term.input("\r");
    const result = await answer;
    assert.deepEqual(result, { key: "r", reason: "too risky" });
  } finally {
    cleanup();
  }
});

test("审批是面板里别的会话的（写明来源）：同样先答完再换（换了当前会话，排在后面的审批会标错来源）", async () => {
  const { shell, term, entered, cleanup } = makeShell();
  try {
    await settle();
    void shell.askApproval({
      toolName: "edit_file",
      toolCallId: "t3",
      args: { path: "a.ts" },
      sessionId: "sess_other" as SessionId,
      pooled: { name: "other" },
    });
    await settle();
    term.input("\x1b[D");
    term.input("\x1b[D");
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.deepEqual(entered, []);
    assert.match(screenText(term), new RegExp(APPROVAL_BEFORE_SWITCH));
  } finally {
    cleanup();
  }
});

test("审批挂着、当前这一轮在跑：Esc 不中断这一轮；面板里空格、Ctrl+X 与带着字的 Enter 都归审批；子 agent 面板里 x 照常停下它", async () => {
  const runtime = new ScriptedRuntime(newSessionId());
  const { shell, term, stopped, spawned, peeked, halted, cleanup } = makeShell(runtime);
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("跑一件");
    term.input("\r");
    await settle();
    // 审批来之前输入框里已经有字
    term.input("先打的字");
    void shell.askApproval({
      toolName: "run_command",
      toolCallId: "t4",
      args: { command: "npm test" },
    });
    await settle();
    term.input("\x1b");
    await settle();
    assert.equal(runtime.interrupts, 0, "Esc 不中断在跑的这一轮");
    term.input("\x15");
    await settle();
    assert.equal(shell.inputText(), "先打的字", "Ctrl+U 也归审批，输入框不动");
    // 回到空输入框的状态才能用两下 ← 与 ↓：用 /panel 前就有字的情况看 Enter
    shell.openPanel();
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    term.input(" ");
    term.input("\x18");
    await settle();
    assert.deepEqual(spawned, [], "带着字的 Enter 不派会话");
    assert.deepEqual(peeked, [], "空格不偷看");
    assert.deepEqual(halted, [], "Ctrl+X 不停");
    runtime.finishAll();
  } finally {
    cleanup();
  }
  const second = makeShell();
  try {
    await settle();
    void second.shell.askApproval({
      toolName: "run_command",
      toolCallId: "t5",
      args: { command: "npm test" },
    });
    await settle();
    second.term.input("\x1b[B");
    await settle();
    second.term.input("x");
    await settle();
    assert.deepEqual(second.stopped, ["general-1"], "子 agent 面板里 x 照常停下它");
  } finally {
    second.cleanup();
  }
});

test("决策 506：滚轮一格滚几行按设置取，改了即生效（缺省 3）", async () => {
  let lines: number | undefined;
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-wheel-"));
  const shell = new PigeonTuiShell({
    terminal: new MockTerminal(80, 24),
    runtime: new ScriptedRuntime(newSessionId()),
    sessionId: newSessionId(),
    logDir,
    wheelScrollLines: () => lines,
  });
  try {
    assert.equal(shell.wheelScrollLines(), 3);
    lines = 7;
    shell.applyWheelScroll();
    assert.equal(shell.wheelScrollLines(), 7);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
