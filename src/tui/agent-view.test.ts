// 决策 505：子 agent 视图里的斜杠命令对着正在看的代理——八条代理级命令就地作用于这个子 agent；/clear、/rewind、/fork、/take
// 直接拒绝（主代理的对话与文件不动）；程序级命令就地执行、不跳回主视图。决策 503：子 agent 视图里连按两下 ← 回会话面板，
// 状态栏显示它的上下文与用量
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SessionPanelSource } from "../application/session-pool.ts";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { loadGrantConfig } from "../persistence/grants-config.ts";
import type { ManualCompactionOutcome } from "../pi-runtime/adapter.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
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

async function makeShell(open = true) {
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
    commands: () =>
      open
        ? {
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
          }
        : undefined,
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
  const mainSessionId = newSessionId();
  const runtime = new ScriptedRuntime(mainSessionId);
  // 一个能续接的旧会话（/resume 的列表里有它）
  const old = createFixtureSession({ sessionsDir: sessionsDirOf(root), cwd: root });
  old.startRun({ task: "旧的任务" });
  old.assistant({ text: "旧的回复" });
  old.endRun();
  await old.close();
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
    sessionId: mainSessionId,
    logDir,
    agents: face,
    resume: {
      root,
      rebind: () => {
        calls.push("rebind");
        throw new Error("unused");
      },
    },
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
      tree: async () => {
        calls.push("rewind");
        return [];
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
      set: () => join(root, "settings.json"),
    },
  });
  shell.start();
  return {
    shell,
    term,
    agent,
    mainSessionId,
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
  const { shell, term, agent, root, store, calls, cleanup } = await makeShell();
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
  const { shell, term, calls, runtime, file, cleanup } = await makeShell();
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
    // 被拒的命令不进输入历史：↑ 召回不到
    term.input("\x1b[A");
    await settle();
    assert.equal(shell.inputText(), "");
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
  const { shell, term, cleanup } = await makeShell();
  try {
    await settle();
    await enterAgent(term);
    await command(term, "/memory");
    assert.match(screenText(term), /memory view text/);
    assert.equal(shell.currentView(), "agent");
    await command(term, "/worktrees");
    assert.match(screenText(term), /no leftover worktrees/);
    assert.equal(shell.currentView(), "agent");
    await command(term, "/config tui.leftArrowOpensPanel=false");
    assert.match(screenText(term), /tui\.leftArrowOpensPanel = false \(written to user settings\)/);
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

test("决策 504：子 agent 视图里连按两下 Esc 不打开回退列表（回主视图再按才开）；还没开运行面的子 agent 上 /rename 只回它没开着", async () => {
  const { shell, term, calls, cleanup } = await makeShell();
  try {
    await settle();
    await enterAgent(term);
    term.input("\x1b");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "agent", "Esc 不回主视图");
    assert.deepEqual(calls, [], "回退列表没开");
    // 面板里选 main 回主代理：同样连按两下 Esc 即打开回退列表
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    term.input("\x1b");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "rewind");
    assert.deepEqual(calls, ["rewind"]);
  } finally {
    cleanup();
  }
  const closed = await makeShell(false);
  try {
    await settle();
    await enterAgent(closed.term);
    await command(closed.term, "/rename fixer");
    assert.match(screenText(closed.term), /general-1 isn't open right now$/m);
    assert.deepEqual(closed.calls, []);
    assert.equal(closed.agent.displayName, undefined);
  } finally {
    closed.cleanup();
  }
});

test("决策 503：子 agent 视图里输入框为空时连按两下 ← 回会话面板；状态栏是它的上下文", async () => {
  const { shell, term, cleanup } = await makeShell();
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

test("决策 505：子 agent 视图里 /resume、/new 的说明与报错写在这里；/resume 的列表 Esc 关掉回到这个子 agent", async () => {
  const { shell, term, mainSessionId, calls, cleanup } = await makeShell();
  try {
    await settle();
    await enterAgent(term);
    await command(term, `/resume ${mainSessionId}`);
    assert.match(screenText(term), new RegExp(`already in session ${mainSessionId}`));
    assert.equal(shell.currentView(), "agent");
    await command(term, "/new");
    await settle();
    assert.match(screenText(term), /new failed: unused/);
    assert.equal(shell.currentView(), "agent");
    assert.deepEqual(calls, ["new session"]);
    await command(term, "/resume");
    assert.equal(shell.currentView(), "resume");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "agent", "关掉列表回到打开它的子 agent 视图");
    assert.match(screenText(term), /sub-agent: general-1 done/);
  } finally {
    cleanup();
  }
});
