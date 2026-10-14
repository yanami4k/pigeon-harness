// 子 agent 面板在终端界面里（决策 482）：输入框下方列一层、输入框为空时 ↓ 进入、Enter 进入它的会话（打的字是使用者的话、
// 斜杠命令不收）、Esc 回去、x 停下在跑的；有子 agent 在跑时 /exit 先问一句（y 退出，别的键取消）
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

function makeShell() {
  const term = new MockTerminal(90, 24);
  const agents = [record("general-1", "running"), record("explore-1", "running")];
  const sent: Array<[string, string]> = [];
  const stopped: string[] = [];
  let exits = 0;
  const face: TuiAgentsFace = {
    list: () => agents,
    subscribe: () => () => {},
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

test("面板在输入框下方；↓ 进入、Enter 进入子 agent 的会话，打的字发给它，斜杠命令不收；Esc 回主视图；x 停下在跑的", async () => {
  const { shell, term, sent, stopped } = makeShell();
  shell.start();
  await settle();
  const screen = screenText(term);
  assert.match(screen, /general-1 {2}general · running/);
  assert.match(screen, /explore-1 {2}general · running/);
  term.input("\x1b[B");
  await settle();
  assert.match(screenText(term), /› general-1/);
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
  assert.match(screenText(term), /sub-agent general-1 · esc to go back/);
  term.input("check the tests");
  term.input("\r");
  await settle();
  assert.deepEqual(sent, [["general-1", "check the tests"]]);
  term.input("/config");
  term.input("\r");
  await settle();
  assert.match(screenText(term), /slash commands don't work in a sub-agent's session/);
  term.input("\x1b");
  await settle();
  assert.equal(shell.currentView(), "main");
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
