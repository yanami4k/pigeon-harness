// 决策 505：子 agent 视图里的斜杠命令对着正在看的代理——八条代理级命令就地作用于这个子 agent；/clear、/rewind、/fork、/take
// 直接拒绝（主代理的对话与文件不动）；程序级命令就地执行、不跳回主视图。决策 503：子 agent 视图里连按两下 ← 回会话面板，
// 状态栏显示它的上下文与用量
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SessionPanelSource } from "../application/session-pool.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import type { ManualCompactionOutcome } from "../pi-runtime/adapter.ts";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiAgentsFace } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle, squashSpaces } from "./testing.ts";

function record(name: string, state: SubagentRecord["state"]): SubagentRecord {
  return {
    kind: "agent",
    agentName: name,
    name: () => name,
    type: { name: "general" },
    path: name,
    parent: { kind: "session", name: () => "main" },
    sessionId: newSessionId(),
    state,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as SubagentRecord;
}

function makeShell() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-agent-view-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-agent-view-log-"));
  const file = join(root, "a.txt");
  writeFileSync(file, "原样\n");
  const term = new MockTerminal(100, 30);
  const agent = record("general-1", "idle");
  const store = new SessionGrantStore({ workspaceRoot: root });
  const calls: string[] = [];
  const face: TuiAgentsFace = {
    list: () => [agent],
    running: () => 0,
    stop: async () => {},
    send: () => undefined,
    live: () => undefined,
    historyDir: () => undefined,
    commands: () => ({
      contextUsage: () => ({ tokens: 12_000, contextWindow: 100_000 }),
      grants: { root, store, configRules: [] },
      hooks: {
        list: () => [],
        disabled: true,
        runEvent: async () => {
          throw new Error("unused");
        },
      },
      tasks: () => "tasks of general-1",
    }),
    status: async (target) => {
      calls.push(`status ${target.agentName}`);
      return `agent    ${target.displayName ?? target.agentName}`;
    },
    compact: async (target, focus): Promise<ManualCompactionOutcome> => {
      calls.push(`compact ${target.agentName} ${focus ?? ""}`);
      return { kind: "skipped", reason: "disabled" };
    },
    rename: (target, name) => {
      calls.push(`rename ${target.agentName} ${name}`);
      target.displayName = name;
      return `renamed to ${name}`;
    },
  };
  const runtime = new ScriptedRuntime(newSessionId());
  const source: SessionPanelSource = {
    list: () => [],
    subscribe: () => () => {},
    spawn: async () => {
      throw new Error("unused");
    },
    send: async () => undefined,
    stop: async () => {},
    remove: async () => {},
    peek: async () => [],
  };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: newSessionId(),
    logDir,
    agents: face,
    grants: { root, store: new SessionGrantStore({ workspaceRoot: root }), configRules: [] },
    newSession: {
      create: async () => {
        calls.push("new session");
        throw new Error("unused");
      },
    },
    fork: async () => {
      calls.push("fork");
      return "forked";
    },
    rewind: {
      tree: () => {
        calls.push("rewind");
        throw new Error("unused");
      },
      prepare: () => {
        throw new Error("unused");
      },
      prepareUndo: () => {
        throw new Error("unused");
      },
      check: () => {
        throw new Error("unused");
      },
      apply: () => {
        throw new Error("unused");
      },
    } as unknown as NonNullable<ConstructorParameters<typeof PigeonTuiShell>[0]["rewind"]>,
    memory: {
      view: () => "memory view text",
      edit: async () => "unused",
    },
    worktrees: {
      run: () => "no leftover worktrees",
      hasPending: () => false,
      confirmPending: () => "",
      cancelPending: () => {},
    },
    pool: { source, enter: async () => undefined },
    config: {
      view: () => [],
      set: () => undefined,
    },
  });
  shell.start();
  return {
    shell,
    term,
    agent,
    root,
    store,
    calls,
    runtime,
    file,
    cleanup: () => {
      shell.stop();
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

async function enterAgent(term: MockTerminal): Promise<void> {
  term.input("\x1b[B");
  term.input("\r");
  await settle();
}

async function command(term: MockTerminal, text: string): Promise<void> {
  term.input("\x15");
  term.input(text);
  term.input("\r");
  await settle();
}

test("代理级命令在子 agent 视图里就地作用于这个子 agent", async () => {
  const { shell, term, agent, root, store, calls, cleanup } = makeShell();
  try {
    await settle();
    await enterAgent(term);
    assert.equal(shell.currentView(), "agent");
    await command(term, "/status");
    assert.match(screenText(term), /agent {4}general-1/);
    await command(term, "/compact keep the plan");
    await command(term, "/rename fixer");
    assert.match(screenText(term), /renamed to fixer/);
    assert.match(screenText(term), /sub-agent: fixer done/, "状态行与面板写显示名");
    assert.equal(agent.agentName, "general-1", "地址不变");
    await command(term, "/tasks");
    assert.match(screenText(term), /tasks of general-1/);
    await command(term, "/hooks");
    assert.match(screenFlat(term), /disableAllHooks: on/);
    const grant = store.create({
      tool: "edit_file",
      firstCall: { toolCallId: "tc-1", args: { path: "a.ts" } },
    });
    await command(term, "/grants");
    assert.ok(squashSpaces(screenFlat(term)).includes(squashSpaces("session grants (1):")));
    await command(term, `/grants save ${grant.grantId}`);
    assert.equal(
      loadGrantConfig(root)[0]?.promotedFrom.sessionId,
      agent.sessionId,
      "存的是它自己的放权"
    );
    await command(term, `/revoke ${grant.grantId}`);
    assert.equal(store.list().length, 0, "撤的是这个子 agent 自己的放权");
    assert.deepEqual(calls, [
      "status general-1",
      "compact general-1 keep the plan",
      "rename general-1 fixer",
    ]);
    assert.equal(shell.currentView(), "agent", "命令都没跳回主视图");
  } finally {
    cleanup();
  }
});

test("/clear、/rewind、/fork、/take 在子 agent 视图里直接拒绝：主代理的对话与文件不动", async () => {
  const { shell, term, calls, runtime, file, cleanup } = makeShell();
  try {
    await settle();
    await enterAgent(term);
    for (const name of ["clear", "rewind", "fork", "take"]) {
      await command(term, `/${name}`);
      assert.match(screenText(term), new RegExp(`/${name} only works in the main agent's view`));
      assert.equal(shell.currentView(), "agent");
    }
    term.input("\x15");
    assert.deepEqual(calls, []);
    assert.deepEqual(runtime.runs, []);
    assert.equal(readFileSync(file, "utf8"), "原样\n");
    // 回到主代理：主视图里没有这几条命令的痕迹
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.doesNotMatch(screenText(term), /\/clear|\/rewind|\/fork|\/take/);
  } finally {
    cleanup();
  }
});

test("程序级命令就地执行：输出写在子 agent 视图里；/config 关掉后回到这个子 agent", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    await enterAgent(term);
    await command(term, "/memory");
    assert.match(screenText(term), /memory view text/);
    assert.equal(shell.currentView(), "agent");
    await command(term, "/worktrees");
    assert.match(screenText(term), /no leftover worktrees/);
    assert.equal(shell.currentView(), "agent");
    await command(term, "/config");
    assert.equal(shell.currentView(), "config");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "agent", "关掉设置回到打开它的子 agent 视图");
    assert.match(screenText(term), /sub-agent: general-1 done/);
    await command(term, "/panel");
    assert.equal(shell.currentView(), "panel");
  } finally {
    cleanup();
  }
});

test("决策 503：子 agent 视图里输入框为空时连按两下 ← 回会话面板；状态栏是它的上下文", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    assert.doesNotMatch(screenText(term), /ctx 12%/);
    await enterAgent(term);
    assert.match(screenText(term), /12%/, "状态栏显示子 agent 的上下文");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "agent");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "panel");
  } finally {
    cleanup();
  }
});
