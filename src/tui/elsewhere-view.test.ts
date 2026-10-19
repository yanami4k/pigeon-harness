// 决策 501：别的进程开着的会话（open elsewhere）在本进程里与其他会话视图只差一条——不收任何输入（消息与命令都不收）；
// 连按两下 ← 回面板（Esc 也回）；内容跟着它的会话记录实时更新；状态栏是它的模式、上下文与用量；顶上一行标题照旧
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { recordedSessionPath } from "../application/session-follow.ts";
import type { PooledSessionCard, SessionPanelSource } from "../application/session-pool.ts";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { sessionsDirOf } from "../state/paths.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

async function makeShell() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-elsewhere-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-elsewhere-log-"));
  const record = createFixtureSession({ sessionsDir: sessionsDirOf(root), cwd: root });
  const sessionsDir = sessionsDirOf(root);
  record.startRun({
    task: "修登录",
    config: {
      policy: { allow: [], deny: [], approvalMode: "prompt" },
      compaction: {
        contextWindow: 100_000,
        reserveTokens: 1000,
        keepRecentTokens: 1000,
        thresholdTokens: 90_000,
      },
    },
  });
  record.assistant({ text: "第一段回复", usage: { input: 20_000, totalTokens: 20_000 } });
  await record.writer.flush();
  const card: PooledSessionCard = {
    id: record.sessionId,
    name: "far",
    state: "idle",
    task: "修登录",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
    elsewhere: true,
    dormant: true,
    root,
  };
  const calls: string[] = [];
  const source: SessionPanelSource = {
    list: () => [card],
    subscribe: () => () => {},
    spawn: async () => {
      throw new Error("unused");
    },
    send: async () => undefined,
    stop: async () => {},
    remove: async () => {},
    peek: async () => [],
  };
  const runtime = new ScriptedRuntime(newSessionId());
  const term = new MockTerminal(110, 30);
  // 主会话在放手档，它在询问档：状态栏写哪个一眼可辨
  const mode = { current: "yolo" as "prompt" | "yolo" };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: newSessionId(),
    logDir,
    recordPollMs: 20,
    approvalMode: () => ({
      get: () => mode.current,
      set: (next) => {
        mode.current = next;
      },
    }),
    pool: {
      source,
      enter: async (id) => {
        calls.push(`enter ${id}`);
        return undefined;
      },
    },
    newSession: {
      create: async () => {
        calls.push("new session");
        throw new Error("unused");
      },
    },
  });
  shell.start();
  return {
    shell,
    term,
    record,
    runtime,
    calls,
    mode,
    get path(): string {
      const found = recordedSessionPath(root, record.sessionId);
      assert.ok(found !== undefined, sessionsDir);
      return found;
    },
    cleanup: async () => {
      shell.stop();
      await record.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

async function openFar(term: MockTerminal): Promise<void> {
  term.input("/panel");
  term.input("\r");
  await settle();
  term.input("\x1b[B");
  term.input("\r");
  await settle();
}

test("内容跟着它的会话记录更新，状态栏是它的模式、上下文与用量；标题照旧", async () => {
  const { shell, term, record, path, cleanup } = await makeShell();
  try {
    await settle();
    assert.doesNotMatch(screenText(term), /ctx 20%/, "主视图的状态栏不是它的");
    assert.match(screenText(term), /bypass/, "主视图是主会话的模式");
    await openFar(term);
    assert.equal(shell.currentView(), "elsewhere");
    let screen = screenText(term);
    assert.match(screen, /session far · open elsewhere · esc to go back/);
    assert.match(screen, /第一段回复/);
    assert.match(screen, /\bask\b/, "它的模式");
    assert.doesNotMatch(screen, /bypass/, "不是主会话的模式");
    assert.match(screen, /ctx 20%/, "它的上下文");
    assert.match(screen, /20k tokens|20\.0k/, "它的用量");
    assert.doesNotMatch(screen, /^ {2}main$/m, "不显示子 agent 面板");
    record.user("再看看");
    record.assistant({ text: "第二段回复", usage: { input: 40_000, totalTokens: 40_000 } });
    await record.writer.flush();
    await settle(200);
    screen = screenText(term);
    assert.match(screen, /第二段回复/, "内容跟着记录更新");
    assert.match(screen, /ctx 40%/, "状态栏跟着更新");
    // 记录文件读不到（被删）：停在原样，不抛、不刷屏
    rmSync(path);
    await settle(200);
    assert.equal(shell.currentView(), "elsewhere");
    assert.match(screenText(term), /第二段回复/);
    // 离开视图：定时器清掉
    assert.equal(shell.followingElsewhere(), true);
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "panel");
    assert.equal(shell.followingElsewhere(), false);
  } finally {
    await cleanup();
  }
});

test("不收任何输入：消息与命令都回一行、不跳走；连按两下 ← 回面板，Esc 也回", async () => {
  const { shell, term, record, runtime, calls, mode, cleanup } = await makeShell();
  try {
    await settle();
    await openFar(term);
    for (const text of ["接着做", "/new", "/status", "/quit"]) {
      term.input("\x15");
      term.input(text);
      term.input("\r");
      await settle();
      assert.equal(shell.currentView(), "elsewhere", `${text} 不跳走`);
      assert.match(screenText(term), /session far is open elsewhere/);
    }
    assert.deepEqual(runtime.runs, []);
    assert.deepEqual(calls, []);
    // 被拒的输入不进输入历史：↑ 召回的是之前打开面板的那条
    term.input("\x15");
    term.input("\x1b[A");
    await settle();
    assert.equal(shell.inputText(), "/panel");
    term.input("\x1b[B");
    await settle();
    term.input("\x15");
    // Shift+Tab 也不收：当前会话的模式不被悄悄切换
    term.input("\x1b[Z");
    await settle();
    assert.equal(mode.current, "yolo");
    // 记录有追加、按记录重画之后，回过的提示照样在
    record.assistant({ text: "那边又回了一段" });
    await record.writer.flush();
    await settle(200);
    assert.match(screenText(term), /那边又回了一段/);
    assert.match(screenText(term), /session far is open elsewhere/);
    term.input("\x15");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "elsewhere", "第一下只提示");
    term.input("\x1b[D");
    await settle();
    assert.equal(shell.currentView(), "panel");
    assert.match(screenText(term), /> far open elsewhere/, "回到面板选着它");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "elsewhere");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "panel");
  } finally {
    await cleanup();
  }
});
