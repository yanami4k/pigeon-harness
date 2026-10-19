// 决策 508、509：审批挂着时导航照常；审批只在它所属的会话里出现——主代理的出现在主代理视图，子 agent 的同时出现在主代理视图
// 与它自己的视图（标明是哪个子 agent），任一处答了两处都收；别的子 agent 视图、会话面板、只看历史的视图、别的会话都不显示，
// 卡片与子 agent 面板那一行标等待；回答键只在显示着的视图里归审批；挂着审批也能离开去别的会话，回来再答
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { PooledSessionCard, SessionPanelSource } from "../application/session-pool.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function agentRecord(name: string): SubagentRecord {
  return {
    kind: "agent",
    agentName: name,
    name: () => name,
    type: { name: "general" },
    path: name,
    parent: { kind: "session", name: () => "main" },
    state: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as SubagentRecord;
}

function makeShell(runtime = new ScriptedRuntime(newSessionId())) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-approval-nav-"));
  const term = new MockTerminal(110, 40);
  const agents = [agentRecord("general-1"), agentRecord("explore-1")];
  const waiting = new Set<string>();
  const stopped: string[] = [];
  const sent: Array<[string, string]> = [];
  const entered: string[] = [];
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
    spawn: async () => {
      throw new Error("unused");
    },
    send: async () => undefined,
    stop: async () => {},
    remove: async () => {},
    peek: async () => [],
  };
  const sessionId = newSessionId();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    sessionName: (id) => (id === "sess_other" ? "other" : "demo-main"),
    agents: {
      list: () => agents,
      running: () => agents.length,
      waiting: () => waiting,
      stop: async (record) => {
        stopped.push(record.agentName);
      },
      send: (record, text) => {
        sent.push([record.agentName, text]);
        return undefined;
      },
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
    sessionId,
    waiting,
    stopped,
    sent,
    entered,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

function request(command: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { toolName: "run_command", toolCallId: command, args: { command }, ...extra };
}

// 子 agent 面板里第 index 个子 agent（main 之后）
async function enterAgent(term: MockTerminal, index: number): Promise<void> {
  term.input("\x1b[B");
  for (let step = 0; step < index; step++) term.input("\x1b[B");
  term.input("\r");
  await settle();
}

test("主代理的审批只在主代理视图里：打字不进输入框；子 agent 视图里不显示、照常给它打字；会话面板里不显示、卡片标等待；挂着也能进别的会话", async () => {
  const { shell, term, sessionId, sent, entered, cleanup } = makeShell();
  try {
    await settle();
    const answer = shell.askApproval(request("npm test", { sessionId }));
    await settle();
    assert.match(screenText(term), /npm test/);
    term.input("hello");
    await settle();
    assert.equal(shell.inputText(), "", "显示着审批的视图里输入框不收打字");
    // 子 agent 视图：主代理的审批不显示，打字照常发给它，y 不回答审批
    await enterAgent(term, 0);
    assert.equal(shell.currentView(), "agent");
    assert.doesNotMatch(screenText(term), /npm test/);
    term.input("yes go");
    term.input("\r");
    await settle();
    assert.deepEqual(sent, [["general-1", "yes go"]]);
    // 回主代理视图：审批照样在
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.match(screenText(term), /npm test/);
    // 会话面板：审批不显示，当前会话的卡片标等待回应
    term.input("\x1b[D");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "panel");
    const panel = screenText(term);
    assert.doesNotMatch(panel, /approve once/);
    assert.match(panel, /demo-main current .*waiting: run_command/);
    // 挂着审批也能进别的会话
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.deepEqual(entered, ["sess_other"]);
    // 回到主代理视图答
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    term.input("y");
    assert.equal((await answer).key, "y");
  } finally {
    cleanup();
  }
});

test("子 agent 的审批：主代理视图与它自己的视图都显示（标明是哪个子 agent），别的子 agent 视图不显示；在它的视图里答掉两处都收，结论只写在它的视图里；在主视图里答的主视图也留一行", async () => {
  const { shell, term, sessionId, waiting, sent, cleanup } = makeShell();
  try {
    await settle();
    waiting.add("general-1");
    const firstRequest = request("make build", { sessionId, subagent: { path: "general-1" } });
    const first = shell.askApproval(firstRequest);
    await settle();
    assert.match(screenText(term), /source: sub-agent general-1/);
    assert.match(screenText(term), /make build/);
    assert.match(screenText(term), /general-1 {2}general · waiting for approval/);
    // 别的子 agent 的视图里不显示，照常打字
    await enterAgent(term, 1);
    assert.match(screenText(term), /sub-agent: explore-1/);
    assert.doesNotMatch(screenText(term), /make build/);
    term.input("go on");
    term.input("\r");
    await settle();
    assert.deepEqual(sent, [["explore-1", "go on"]]);
    // 切到它自己的视图：显示，答掉
    term.input("\x1b[B");
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "agent");
    assert.match(screenText(term), /make build/, "它自己的视图里显示");
    term.input("y");
    assert.equal((await first).key, "y");
    // 替身里没有 handler：照 handler 的做法写结论
    shell.noteApproval("✓ approved run_command: make build", firstRequest);
    await settle();
    assert.doesNotMatch(screenText(term), /approve once/, "它的视图里收了");
    assert.match(screenText(term), /✓ approved run_command: make build/, "结论写在它的视图里");
    // 回主视图：也收了；结论不写在主视图
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.doesNotMatch(screenText(term), /approve once/, "主视图里也收了");
    assert.doesNotMatch(screenText(term), /✓ approved run_command: make build/);
    // 第二条在主视图里答：主视图留一行
    const secondRequest = request("make test", { sessionId, subagent: { path: "general-1" } });
    const second = shell.askApproval(secondRequest);
    await settle();
    term.input("n");
    assert.equal((await second).key, "n");
    shell.noteApproval("✗ rejected run_command: make test", secondRequest);
    await settle();
    assert.match(screenText(term), /✗ rejected run_command: make test/);
  } finally {
    cleanup();
  }
});

test("别的会话的审批不在当前会话里弹出：按键照常、卡片标等待；换到那个会话即显示、照常能答；换走之后又不显示", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const own = shell.sessionId();
    const other = "sess_other" as SessionId;
    const away = shell.askApproval(request("rm tmp", { sessionId: other }));
    await settle();
    assert.doesNotMatch(screenText(term), /rm tmp/);
    term.input("y");
    await settle();
    assert.equal(shell.inputText(), "y", "按键照常进输入框");
    term.input("\x15");
    shell.openPanel();
    await settle();
    assert.match(screenText(term), /other .*waiting: run_command/, "那个会话的卡片标等待回应");
    // 换到那个会话：显示、能答；换回原来的：又不显示
    shell.rebindSession(other, { runtime: new ScriptedRuntime(other) });
    await settle();
    assert.match(screenText(term), /rm tmp/);
    shell.rebindSession(own, { runtime: new ScriptedRuntime(own) });
    await settle();
    assert.doesNotMatch(screenText(term), /rm tmp/);
    shell.rebindSession(other, { runtime: new ScriptedRuntime(other) });
    await settle();
    term.input("y");
    assert.equal((await away).key, "y");
  } finally {
    cleanup();
  }
});

test("审批挂着：r 写拒绝理由时按键照旧交给输入区（方向键不切视图）", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const answer = shell.askApproval(request("rm -rf build"));
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
    assert.deepEqual(await answer, { key: "r", reason: "too risky" });
  } finally {
    cleanup();
  }
});

test("审批显示着、当前这一轮在跑：Esc 不中断这一轮，Ctrl+U 归审批；子 agent 面板里 x 照常停下它", async () => {
  const runtime = new ScriptedRuntime(newSessionId());
  const { shell, term, cleanup } = makeShell(runtime);
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("跑一件");
    term.input("\r");
    await settle();
    term.input("先打的字");
    void shell.askApproval(request("npm test"));
    await settle();
    term.input("\x1b");
    await settle();
    assert.equal(runtime.interrupts, 0, "Esc 不中断在跑的这一轮");
    term.input("\x15");
    await settle();
    assert.equal(shell.inputText(), "先打的字", "Ctrl+U 归审批，输入框不动");
    runtime.finishAll();
  } finally {
    cleanup();
  }
  const second = makeShell();
  try {
    await settle();
    void second.shell.askApproval(request("npm test"));
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

test("子 agent 被停下（请求撤回）：从它的会话里收掉、留一行结论，按取消收口", async () => {
  const { shell, term, sessionId, cleanup } = makeShell();
  try {
    await settle();
    const controller = new AbortController();
    const answer = shell.askApproval(
      request("make build", {
        sessionId,
        subagent: { path: "general-1" },
        signal: controller.signal,
      })
    );
    await settle();
    assert.match(screenText(term), /make build/);
    controller.abort();
    assert.equal((await answer).key, "cancel");
    await settle();
    assert.doesNotMatch(screenText(term), /approve once/);
    assert.match(screenText(term), /withdrawn: general-1 was stopped/);
  } finally {
    cleanup();
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
