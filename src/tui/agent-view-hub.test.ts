// 决策 505：子 agent 视图里的 /compact、/rename、/status 接到真的通讯录（AgentHub）与真的命令面（agentCommandsFace）上——
// 压的期间它算还在干活（退出前先问）、Esc 能中断压缩；改名经通讯录记进它的会话记录，list_agents 两个名字都列
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { MailGate } from "../application/agent-mail.ts";
import { renderAgentList } from "../application/agent-tools.ts";
import { BUILT_IN_AGENT_TYPES } from "../application/agent-types.ts";
import type { SubagentInspect } from "../application/subagent-runtime.ts";
import {
  AgentHub,
  type AgentRunOutcome,
  type SubagentRecord,
  type SubagentRuntime,
} from "../application/subagents.ts";
import type { ManualCompactionOutcome } from "../pi-runtime/adapter.ts";
import { newSessionId } from "../state/ids.ts";
import { agentCommandsFace } from "./agent-commands.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { EXIT_CONFIRM, PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

async function makeShell() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-agent-hub-view-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-agent-hub-view-log-"));
  const hub = new AgentHub({ mail: new MailGate() });
  const names: string[] = [];
  const compactions: Array<{ focus: string | undefined; done: (kind: string) => void }> = [];
  let interrupts = 0;
  const inspections = new WeakMap<SubagentRuntime, SubagentInspect>();
  const sessionId = newSessionId();
  const { host } = hub.registerSession({
    sessionId,
    name: () => "main",
    deliver: () => {},
    pendingNotices: () => 0,
    record: () => {},
    catalog: () => ({ types: BUILT_IN_AGENT_TYPES, problems: [] }),
    limits: () => ({ maxConcurrent: 20, maxDepth: 3 }),
    open: async (spec) => {
      let finish: ((outcome: AgentRunOutcome) => void) | undefined;
      const runtime: SubagentRuntime = {
        sessionId: newSessionId(),
        run: () =>
          new Promise<AgentRunOutcome>((resolve) => {
            finish = resolve;
          }),
        runNotices: async () => ({ status: "completed" }),
        notify: () => {},
        pendingNotices: () => 0,
        interrupt: async () => {
          interrupts += 1;
          finish?.({ status: "aborted" });
          for (const pending of compactions.splice(0)) pending.done("cancelled");
        },
        reply: () => `${spec.name} done`,
        record: () => {},
        setName: (name) => names.push(name),
        close: async () => {},
      };
      inspections.set(runtime, {
        governanceRoot: root,
        modelId: "deepseek-chat",
        bundle: {
          adapter: {
            contextUsage: () => ({ tokens: 1000, contextWindow: 100_000 }),
            compact: (focus?: string) =>
              new Promise<ManualCompactionOutcome>((resolve) => {
                compactions.push({
                  focus,
                  done: (kind) =>
                    resolve(
                      (kind === "cancelled"
                        ? { kind: "failed", error: "cancelled" }
                        : { kind: "skipped", reason: "disabled" }) as ManualCompactionOutcome
                    ),
                });
              }),
          },
          sessionStore: { filePath: async () => undefined },
          grantStore: {},
          configGrants: [],
          settings: { grants: [] },
        },
      } as unknown as SubagentInspect);
      setTimeout(() => finish?.({ status: "completed" }), 0);
      return runtime;
    },
  });
  await host.spawn({ task: "find the parser", type: "explore" });
  await settle(20);
  const term = new MockTerminal(100, 30);
  let exits = 0;
  const historyDir = () => undefined;
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    agents: {
      list: (id) => hub.agentsOf(id),
      running: () => hub.runningTotal(),
      stop: (record) => hub.stop(record),
      send: (record, text) => hub.sendFromUser(record, text),
      live: () => undefined,
      historyDir,
      ...agentCommandsFace({
        hub,
        historyDir,
        projectOf: () => root,
        inspect: (runtime) => (runtime !== undefined ? inspections.get(runtime) : undefined),
      }),
    },
    onExit: () => {
      exits += 1;
    },
  });
  shell.start();
  return {
    shell,
    term,
    hub,
    host,
    sessionId,
    names,
    compactions,
    interrupts: () => interrupts,
    exits: () => exits,
    cleanup: () => {
      shell.stop();
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

async function command(term: MockTerminal, text: string): Promise<void> {
  term.input("\x15");
  term.input(text);
  term.input("\r");
  await settle();
}

test("/status 与 /rename 经真的通讯录：显示名记进它的会话记录，地址不变，list_agents 两个名字都列", async () => {
  const { shell, term, hub, host, sessionId, names, cleanup } = await makeShell();
  try {
    const record = hub.agentsOf(sessionId)[0] as SubagentRecord;
    assert.equal(record.state, "idle");
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "agent");
    await command(term, "/status");
    assert.match(screenText(term), /agent {4}explore-1 · explore · done/);
    assert.match(screenText(term), /model {4}deepseek-chat/);
    await command(term, "/rename parser-hunt");
    assert.match(screenText(term), /renamed to parser-hunt/);
    assert.deepEqual(names, ["parser-hunt"]);
    assert.equal(record.agentName, "explore-1");
    assert.match(renderAgentList(host.list()), /^explore-1 \(shown as parser-hunt\): explore/m);
    assert.match(screenText(term), /sub-agent: parser-hunt done/);
  } finally {
    cleanup();
  }
});

test("/compact 经真的通讯录：压的期间算还在干活（退出先问），Esc 中断压缩、它回到压缩前的样子", async () => {
  const { shell, term, hub, sessionId, compactions, interrupts, exits, cleanup } =
    await makeShell();
  try {
    const record = hub.agentsOf(sessionId)[0] as SubagentRecord;
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    await command(term, "/compact keep the plan");
    assert.equal(compactions[0]?.focus, "keep the plan");
    assert.equal(record.compacting, true);
    assert.match(screenText(term), /sub-agent: explore-1 compacting/);
    assert.equal(hub.busyUnder(sessionId), 1, "换会话时退到面板");
    shell.requestExit();
    await settle();
    assert.match(screenText(term), /sub-agents are still running; exit anyway\? \(y\/n\)/);
    assert.ok(screenText(term).includes(EXIT_CONFIRM));
    term.input("n");
    await settle();
    assert.equal(exits(), 0);
    term.input("\x1b");
    await settle();
    assert.equal(interrupts(), 1, "Esc 中断压缩");
    assert.equal(record.compacting, false);
    assert.equal(record.state, "idle", "回到压缩前的状态");
    assert.equal(shell.currentView(), "agent");
    assert.match(screenText(term), /\[compact\]/);
    assert.equal(hub.busyUnder(sessionId), 0);
  } finally {
    cleanup();
  }
});
