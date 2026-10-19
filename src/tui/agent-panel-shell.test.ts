// 子 agent 面板在终端界面里（决策 482、503、504）：输入框下方列一层、第一行 main、输入框为空时 ↓ 进入、Enter 切到选中的代理
//（打的字是使用者的话）、子 agent 视图里面板照样在、Esc 中断它这一轮、x 停下在跑的；有子 agent 在跑时 /exit 先问一句
//（y 退出，别的键取消）。子 agent 视图里的斜杠命令见 agent-view.test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SubagentRecord } from "../application/subagents.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { APPROVAL_WITHDRAWN_REASON, createApprovalQueue } from "../approvals/queue.ts";
import type { RunResult, StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId } from "../state/ids.ts";
import { askApprovalPanel } from "./modal.ts";
import { EXIT_CONFIRM, PigeonTuiShell, type TuiAgentsFace, type TuiRuntimeFace } from "./shell.ts";
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

function record(name: string, state: SubagentRecord["state"]): SubagentRecord {
  return {
    kind: "agent",
    agentName: name,
    name: () => name,
    type: { name: "general" },
    path: name,
    parent: { kind: "session", name: () => "main" },
    state,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as SubagentRecord;
}

function makeShellWithCleanup() {
  const made = makeShell();
  return { ...made, cleanup: () => made.shell.stop() };
}

function makeShell() {
  const term = new MockTerminal(90, 24);
  const agents = [record("general-1", "running"), record("explore-1", "running")];
  const sent: Array<[string, string]> = [];
  const stopped: string[] = [];
  let exits = 0;
  const face: TuiAgentsFace = {
    list: () => agents,
    running: () => agents.filter((agent) => agent.state === "running").length,
    stop: async (agent) => {
      stopped.push(agent.agentName);
      agent.state = "stopped";
    },
    send: (agent, text) => {
      sent.push([agent.agentName, text]);
      return undefined;
    },
    live: () => undefined,
    historyDir: () => undefined,
  };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new StubRuntime(),
    sessionId: newSessionId(),
    logDir: mkdtempSync(join(tmpdir(), "pigeon-agent-shell-")),
    agents: face,
    onExit: () => {
      exits += 1;
    },
  });
  return { shell, term, agents, sent, stopped, exits: () => exits };
}

test("面板在输入框下方、第一行 main；↓ 进入、Enter 切到子 agent，打的字发给它；子 agent 视图没有标题行、面板照样在、正在看的加粗；Esc 中断它这一轮、不回主视图；面板里选 main 回主代理；x 停下在跑的", async () => {
  const { shell, term, sent, stopped } = makeShell();
  shell.start();
  await settle();
  const screen = screenText(term);
  assert.match(screen, /^ {2}main$/m);
  assert.match(screen, /general-1 {2}general · running/);
  assert.match(screen, /explore-1 {2}general · running/);
  term.input("\x1b[B");
  await settle();
  assert.match(screenText(term), /› general-1/, "主视图里进来先选第一个子 agent");
  term.input("\x1b[B");
  await settle();
  assert.match(screenText(term), /› explore-1/);
  term.input("x");
  await settle();
  assert.deepEqual(stopped, ["explore-1"]);
  term.input("\x1b[A");
  term.input("\r");
  await settle();
  assert.equal(shell.currentView(), "agent");
  const inAgent = screenText(term);
  assert.doesNotMatch(inAgent, /esc to go back/, "决策 503：子 agent 视图没有标题行");
  assert.match(inAgent, /^ {2}main$/m, "子 agent 视图里照样有面板");
  assert.ok(term.writes.join("").includes("\x1b[1mgeneral-1"), "正在看的那个加粗");
  term.input("check the tests");
  term.input("\r");
  await settle();
  assert.deepEqual(sent, [["general-1", "check the tests"]]);
  // 决策 504：Esc 中断它这一轮，留在它的视图里
  term.input("\x1b");
  await settle();
  assert.equal(shell.currentView(), "agent");
  assert.deepEqual(stopped, ["explore-1", "general-1"]);
  term.input("\x1b");
  await settle();
  assert.equal(shell.currentView(), "agent", "已停下的再按 Esc 也不回主视图");
  assert.deepEqual(stopped, ["explore-1", "general-1"]);
  // 回主代理：面板里选 main（子 agent 视图里进来先选 main）
  term.input("\x1b[B");
  await settle();
  assert.match(screenText(term), /› main/);
  term.input("\r");
  await settle();
  assert.equal(shell.currentView(), "main");
  shell.stop();
});

test("决策 503：子 agent 视图里在面板上直接切到另一个子 agent", async () => {
  const { shell, term } = makeShell();
  shell.start();
  await settle();
  term.input("\x1b[B");
  term.input("\r");
  await settle();
  assert.equal(shell.currentView(), "agent");
  term.input("\x1b[B");
  term.input("\x1b[B");
  term.input("\x1b[B");
  await settle();
  assert.match(screenText(term), /› explore-1/);
  term.input("\r");
  await settle();
  assert.equal(shell.currentView(), "agent");
  assert.match(screenText(term), /sub-agent: explore-1 running/);
  shell.stop();
});

test("有子 agent 在跑时 /exit 先问一句：别的键取消，y 退出", async () => {
  const { shell, term, exits } = makeShell();
  shell.start();
  await settle();
  shell.requestExit();
  await settle();
  assert.match(screenText(term), new RegExp(EXIT_CONFIRM.replace(/[()?]/g, "\\$&")));
  assert.equal(exits(), 0);
  term.input("n");
  await settle();
  assert.ok(!screenText(term).includes(EXIT_CONFIRM));
  assert.equal(exits(), 0);
  shell.requestExit();
  term.input("y");
  await settle();
  assert.equal(exits(), 1);
});

test("停下等审批的子 agent：挂着的审批从审批区收掉、留一行结论，按撤回收口；还在排队的不再上审批区", async () => {
  const { shell, term } = makeShell();
  shell.start();
  await settle();
  const controller = new AbortController();
  const request: ApprovalRequest = {
    toolName: "edit_file",
    toolCallId: "t1",
    args: { path: "a.ts" },
    subagent: { path: "general-1" },
    signal: controller.signal,
  };
  const answer = askApprovalPanel(shell, request);
  await settle();
  assert.match(screenText(term), /source: sub-agent general-1/);
  controller.abort();
  const result = await answer;
  await settle();
  assert.deepEqual(result, { key: "cancel", reason: APPROVAL_WITHDRAWN_REASON });
  assert.equal(shell.pendingApproval(), null);
  const screen = screenText(term);
  assert.match(screen, /withdrawn: general-1 was stopped/);
  assert.ok(!screen.includes("source: sub-agent general-1"), "审批区收掉了");
  // 排队里已撤回的：不交给 handler
  const queue = createApprovalQueue();
  let asked = 0;
  const handler = queue.wrap(async () => {
    asked += 1;
    return { approved: true };
  });
  const decision = await handler({ ...request, signal: controller.signal });
  assert.equal(asked, 0);
  assert.equal(decision.approved, false);
  shell.stop();
});

test("审批挂着时退出确认照样先答：y 退出、不当作批准；撤回审批时写到一半的拒绝理由一并清掉", async () => {
  const { shell, term, exits } = makeShell();
  shell.start();
  await settle();
  const controller = new AbortController();
  const answer = askApprovalPanel(shell, {
    toolName: "edit_file",
    toolCallId: "t1",
    args: { path: "a.ts" },
    subagent: { path: "general-1" },
    signal: controller.signal,
  });
  await settle();
  term.input("r");
  term.input("do not touch");
  await settle();
  controller.abort();
  await answer;
  await settle();
  assert.ok(!screenText(term).includes("do not touch"), "拒绝理由不留在输入框里");
  const second = askApprovalPanel(shell, {
    toolName: "edit_file",
    toolCallId: "t2",
    args: { path: "b.ts" },
  });
  await settle();
  shell.requestExit();
  await settle();
  term.input("y");
  await settle();
  assert.equal(exits(), 1, "y 答的是退出确认");
  const result = await second;
  assert.notEqual(result.key, "y", "没有当作批准");
});

test("决策 483：当前会话派出的子 agent 在等审批，会话面板里当前会话那张卡标等待回应", async () => {
  const term = new MockTerminal(110, 24);
  const agent = record("general-1", "running");
  const sessionId = newSessionId();
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new StubRuntime(),
    sessionId,
    logDir: mkdtempSync(join(tmpdir(), "pigeon-agent-shell-")),
    agents: {
      list: () => [agent],
      running: () => 1,
      waiting: () => new Set(["general-1"]),
      stop: async () => {},
      send: () => undefined,
      live: () => undefined,
      historyDir: () => undefined,
    },
    pool: {
      source: {
        list: () => [],
        subscribe: () => () => {},
        spawn: async () => {
          throw new Error("unused");
        },
        send: async () => undefined,
        stop: async () => {},
        remove: async () => {},
        peek: async () => [],
      },
    },
  });
  shell.start();
  await settle();
  term.input("/panel");
  term.input("\r");
  await settle();
  assert.match(screenText(term), /waiting: general-1: approval/);
  shell.stop();
});

test("决策 510：子 agent 视图里的转圈跟着正在看的那个子 agent——在跑即转，停下即收", async () => {
  const { shell, term, agents, cleanup } = makeShellWithCleanup();
  try {
    shell.start();
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "agent");
    const spinning = () =>
      screenText(term)
        .split("\n")
        .some((line) => /^\s*[-\\|/]\s*$/.test(line));
    assert.ok(spinning(), "它在跑：转");
    const viewed = agents[0];
    assert.ok(viewed !== undefined);
    viewed.state = "idle";
    shell.agentsChanged();
    await settle();
    assert.ok(!spinning(), "它停了：不转");
  } finally {
    cleanup();
  }
});

test("决策 503：Enter 切过去之后焦点留在面板那一行，↑↓ 接着选；打普通字符即回输入框且字符不丢；x 仍是停下", async () => {
  const { shell, term, sent, stopped, cleanup } = makeShellWithCleanup();
  try {
    shell.start();
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "agent");
    assert.match(screenText(term), /› general-1/, "焦点还在面板里那一行");
    term.input("\x1b[B");
    await settle();
    assert.match(screenText(term), /› explore-1/, "↓ 接着选");
    term.input("x");
    await settle();
    assert.deepEqual(stopped, ["explore-1"], "x 仍是停下");
    term.input("h");
    term.input("i");
    await settle();
    assert.equal(shell.inputText(), "hi", "打字回输入框，第一个字不丢");
    assert.doesNotMatch(screenText(term), /› /, "面板不再有焦点");
    term.input("\r");
    await settle();
    assert.deepEqual(sent, [["general-1", "hi"]]);
  } finally {
    cleanup();
  }
});
