// 决策 485：工作清单在终端界面里——从主视图打开面板（← ← 或 /panel）即把当前会话记进清单并重读清单；别的 Pigeon 开着的会话
// 进入后整屏只看历史（发话回一行、Esc 回面板）；打开别的工作区的会话时确认它没确认过的设置：与审批同一处，a 信任、s 这次不用，
// 答完留一行结论。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { PooledSessionCard, SessionPanelSource } from "../application/session-pool.ts";
import type { TrustEntry } from "../state/config-trust.ts";
import { newSessionId } from "../state/ids.ts";
import { askTrustPanel } from "./modal.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(cards: PooledSessionCard[]) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-worklist-shell-"));
  const term = new MockTerminal(110, 30);
  const calls: string[] = [];
  const source: SessionPanelSource = {
    list: () => cards,
    subscribe: () => () => {},
    spawn: async () => {
      throw new Error("unused");
    },
    send: async () => undefined,
    stop: async () => {},
    remove: async () => {},
    peek: async () => [],
    refresh: () => calls.push("refresh"),
  };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(newSessionId()),
    sessionId: newSessionId(),
    logDir,
    pool: {
      source,
      enter: async (id) => {
        calls.push(`enter ${id}`);
        return undefined;
      },
      left: () => calls.push("left"),
    },
  });
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

function card(extra: Partial<PooledSessionCard>): PooledSessionCard {
  return {
    id: "sess_x",
    name: "x",
    state: "idle",
    task: "做事",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

test("从主视图打开面板即记进清单并重读清单；别的 Pigeon 开着的会话进入后只看历史，发话回一行，Esc 回面板", async () => {
  const { shell, term, calls, cleanup } = makeShell([
    card({ id: "sess_far", name: "far", elsewhere: true, place: "~/other", dormant: true }),
  ]);
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    assert.deepEqual(calls, ["left", "refresh"]);
    assert.match(screenText(term), /far open elsewhere · ~\/other/);
    // 光标在当前会话那张卡上：↓ 到它，回车进入只读视图
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "elsewhere");
    assert.match(screenText(term), /session far · open elsewhere · esc to go back/);
    assert.ok(!calls.some((call) => call.startsWith("enter")), "不在本进程开它");
    term.input("接着做");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /session far is open elsewhere/);
    term.input("\x15");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "panel");
    assert.deepEqual(
      calls.filter((call) => call === "left"),
      ["left"],
      "从只读视图回面板不算当前会话离开"
    );
  } finally {
    cleanup();
  }
});

test("确认别的工作区的设置：与审批同一处列出条目，a 信任、s 这次不用，答完留一行结论", async () => {
  const { shell, term, cleanup } = makeShell([]);
  const entries: TrustEntry[] = [
    {
      kind: "hook",
      id: "Stop:abc",
      origin: "project",
      summary: "npm test",
      fingerprint: "f1",
    },
  ];
  try {
    await settle();
    const first = askTrustPanel(shell, "/work/other", entries);
    await settle();
    const screen = screenText(term);
    assert.match(screen, /new or changed settings that run commands or grant permissions:/);
    assert.match(screen, /\/work\/other/);
    assert.match(screen, /npm test/);
    assert.match(screen, /a trust all \| s skip this time/);
    term.input("y");
    await settle();
    assert.notEqual(shell.pendingApproval(), null, "别的键不答");
    term.input("a");
    assert.equal(await first, "trust");
    await settle();
    assert.match(screenText(term), /trusted settings in \/work\/other/);
    const second = askTrustPanel(shell, "/work/other", entries);
    await settle();
    term.input("s");
    assert.equal(await second, "skip");
    await settle();
    assert.match(screenText(term), /skipped unconfirmed settings in \/work\/other/);
  } finally {
    cleanup();
  }
});
