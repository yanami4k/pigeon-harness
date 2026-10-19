// 决策 508、509：审批挂着时导航照常；审批只在它所属的会话里出现——主代理的出现在主代理视图，子 agent 的同时出现在主代理视图
// 与它自己的视图（标明是哪个子 agent），任一处答了两处都收；别的子 agent 视图、会话面板、只看历史的视图、别的会话都不显示，
// 卡片与子 agent 面板那一行标等待；回答键只在显示着的视图里归审批；挂着审批也能离开去别的会话，回来再答
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { PooledSessionCard, SessionPanelSource } from "../application/session-pool.ts";
import type { SubagentRecord } from "../application/subagents.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import type { ApprovalRequest } from "../approvals/handler.ts";
import { loadSettings } from "../persistence/settings.ts";
import type { TrustEntry } from "../state/config-trust.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { wheelScrollLinesOf } from "../state/settings.ts";
import { createTuiApprovalHandler } from "./approval.ts";
import { askTrustPanel } from "./modal.ts";
import { applyProjectUi } from "./project-ui.ts";
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
  const { shell, term, sessionId, sent, cleanup } = makeShell();
  try {
    await settle();
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

test("经真的审批 handler 撤回：只留一行 withdrawn 结论（不再跟一行 rejected）", async () => {
  const { shell, term, sessionId, cleanup } = makeShell();
  try {
    await settle();
    const handler = createTuiApprovalHandler(
      new SessionGrantStore({ workspaceRoot: "/nonexistent" }),
      () => shell
    );
    const controller = new AbortController();
    const decision = handler(
      request("make build", {
        sessionId,
        subagent: { path: "general-1" },
        signal: controller.signal,
      })
    );
    await settle();
    controller.abort();
    assert.equal((await decision).approved, false);
    await settle();
    const screen = screenText(term);
    assert.equal(screen.split("withdrawn: general-1 was stopped").length - 1, 1);
    assert.doesNotMatch(screen, /rejected run_command/);
  } finally {
    cleanup();
  }
});

test("审批显示着时确认别的工作区的设置照样问（不按跳过处理）；答完确认，审批还在、照常能答", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const answer = shell.askApproval(request("npm test"));
    await settle();
    const entries: TrustEntry[] = [
      {
        kind: "hook",
        id: "Stop:abc",
        origin: "project",
        summary: "npm run lint",
        fingerprint: "f1",
      },
    ];
    const trust = askTrustPanel(shell, "/work/other", entries);
    await settle();
    assert.match(screenText(term), /a trust all \| s skip this time/);
    term.input("a");
    assert.equal(await trust, "trust");
    await settle();
    assert.match(screenText(term), /npm test/, "审批还在");
    term.input("y");
    assert.equal((await answer).key, "y");
  } finally {
    cleanup();
  }
});

test("壳停止：各会话挂着的审批全部按拒绝收口", async () => {
  const { shell, sessionId, cleanup } = makeShell();
  const own = shell.askApproval(request("npm test", { sessionId }));
  const away = shell.askApproval(request("rm tmp", { sessionId: "sess_other" as SessionId }));
  await settle();
  cleanup();
  assert.equal((await own).key, "cancel");
  assert.equal((await away).key, "cancel");
});

test("别的会话的审批：permission_prompt 的说明写明是哪个会话在等", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-approval-hook-"));
  const messages: string[] = [];
  const shell = new PigeonTuiShell({
    terminal: new MockTerminal(100, 30),
    runtime: new ScriptedRuntime(newSessionId()),
    sessionId: newSessionId(),
    logDir,
    sessionName: (id) => (id === "sess_other" ? "other" : "demo-main"),
    hooks: {
      list: () => [],
      disabled: false,
      runEvent: async (_event, _target, fields) => {
        messages.push(String(fields.message));
        return { systemMessages: [], additionalContext: [], ran: true } as never;
      },
    },
  });
  shell.start();
  try {
    void shell.askApproval(request("rm tmp", { sessionId: "sess_other" as SessionId }));
    await settle();
    assert.match(messages[0] ?? "", /^source: session other\n/);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 506：换项目与 /config、/reload 之后按新的设置快照重定滚轮行数（main.ts 用的同一步）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-project-ui-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-project-ui-log-"));
  let snapshot = loadSettings(root, { homeDir: root });
  const shell = new PigeonTuiShell({
    terminal: new MockTerminal(80, 24),
    runtime: new ScriptedRuntime(newSessionId()),
    sessionId: newSessionId(),
    logDir,
    wheelScrollLines: () => wheelScrollLinesOf(snapshot),
  });
  try {
    assert.equal(shell.wheelScrollLines(), 3, "没写：缺省");
    mkdirSync(join(root, ".pigeon"), { recursive: true });
    writeFileSync(
      join(root, ".pigeon", "settings.json"),
      JSON.stringify({ tui: { wheelScrollLines: 9 } })
    );
    snapshot = loadSettings(root, { homeDir: root });
    applyProjectUi(shell, snapshot);
    assert.equal(shell.wheelScrollLines(), 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("写拒绝理由途中显示的条目换了（另一项挂到前面）：理由作废、从输入框收掉，回车不拿它去拒绝原来那条", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    let decided: unknown;
    void shell.askApproval(request("rm -rf build")).then((result) => {
      decided = result;
    });
    await settle();
    term.input("r");
    term.input("half");
    await settle();
    // 一项不按会话分的确认挂到前面（显示的换成了它）
    const trust = askTrustPanel(shell, "/work/other", [
      { kind: "hook", id: "Stop:x", origin: "project", summary: "npm run lint", fingerprint: "f" },
    ]);
    await settle();
    assert.equal(shell.reasonMode(), false);
    assert.equal(shell.inputText(), "");
    term.input("s");
    assert.equal(await trust, "skip");
    await settle();
    term.input("\r");
    await settle();
    assert.equal(decided, undefined, "原来那条没被半截理由拒掉");
    term.input("n");
    await settle();
    assert.deepEqual(decided, { key: "n" });
  } finally {
    cleanup();
  }
});

test("写拒绝理由途中那条被撤回：理由作废、从输入框收掉，回车不作数", async () => {
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
    term.input("r");
    term.input("half");
    controller.abort();
    assert.equal((await answer).key, "cancel");
    await settle();
    assert.equal(shell.reasonMode(), false);
    assert.equal(shell.inputText(), "");
    // 回车不作数：没有可拒的，也不把空行当成别的输入
    term.input("\r");
    await settle();
    assert.equal(shell.reasonMode(), false);
  } finally {
    cleanup();
  }
});

test("审批显示着时来了确认别的工作区的设置：按 a 只答审批，确认随后才出", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const answer = shell.askApproval(request("npm test"));
    await settle();
    let trusted: unknown;
    // 同 main.ts 的排法：等这个视图里显示着的审批答完再问
    void shell
      .approvalFree()
      .then(() =>
        askTrustPanel(shell, "/work/other", [
          {
            kind: "hook",
            id: "Stop:y",
            origin: "project",
            summary: "npm run lint",
            fingerprint: "g",
          },
        ])
      )
      .then((choice) => {
        trusted = choice;
      });
    await settle();
    assert.doesNotMatch(screenText(term), /a trust all/, "确认不盖住审批");
    term.input("a");
    assert.equal((await answer).key, "a", "a 答的是审批");
    await settle();
    assert.equal(trusted, undefined);
    assert.match(screenText(term), /a trust all \| s skip this time/, "审批答完确认才出");
    term.input("s");
    await settle();
    assert.equal(trusted, "skip");
  } finally {
    cleanup();
  }
});

test("回答框刚出现的一小会儿里按的回答键不作数，过了才收", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-answer-guard-"));
  const term = new MockTerminal(100, 30);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(newSessionId()),
    sessionId: newSessionId(),
    logDir,
    answerGuardMs: 300,
  });
  shell.start();
  try {
    let decided: unknown;
    void shell.askApproval(request("npm test")).then((result) => {
      decided = result;
    });
    term.input("y");
    await settle();
    assert.equal(decided, undefined, "刚出现时按的 y 不作数");
    assert.equal(shell.inputText(), "", "也不进输入框");
    await settle(300);
    term.input("y");
    await settle();
    assert.deepEqual(decided, { key: "y" });
    // 确认设置同样
    let trusted: unknown;
    void askTrustPanel(shell, "/work/other", [
      { kind: "hook", id: "Stop:z", origin: "project", summary: "x", fingerprint: "h" },
    ]).then((choice) => {
      trusted = choice;
    });
    term.input("a");
    await settle();
    assert.equal(trusted, undefined);
    await settle(300);
    term.input("a");
    await settle();
    assert.equal(trusted, "trust");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
