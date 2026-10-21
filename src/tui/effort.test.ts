// 决策 513：会话中途切换思考强度——/effort [档位]（不带参数时在输入框下方列出档位、标出当前档位；非法档位报错；运行中可用）、
// Alt+T 在 off → low → medium → high → xhigh 之间轮换（minimal 的下一档为 low；模型不支持推理时不切换），状态栏紧跟审批模式
// 写 effort <档位>、/status 的 mode 行同列；子 agent 视图里改的是那个子 agent 的档位。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SubagentRecord } from "../application/subagents.ts";
import { SessionGrantStore } from "../approvals/grant-store.ts";
import { newSessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { nextEffort, type ThinkingControl } from "./effort.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiAgentsFace } from "./shell.ts";
import { agentStatusText, type StatusReport, statusReportText } from "./status-report.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const ALT_T = "\x1bt";

function control(start: ThinkingLevel, supported = true): ThinkingControl & { sets: string[] } {
  let level = start;
  const sets: string[] = [];
  return {
    sets,
    supported,
    get: () => level,
    set: (next) => {
      if (!supported) return;
      sets.push(next);
      level = next;
    },
  };
}

function makeShell(main: ThinkingControl, agentThinking?: ThinkingControl) {
  const root = mkdtempSync(join(tmpdir(), "pigeon-effort-"));
  const term = new MockTerminal(100, 30);
  const sessionId = newSessionId();
  const agent = {
    kind: "agent",
    agentName: "general-1",
    name: () => "general-1",
    type: { name: "general" },
    path: "general-1",
    parent: { kind: "session", name: () => "main" },
    sessionId: newSessionId(),
    state: "idle",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as SubagentRecord;
  const agents: TuiAgentsFace = {
    list: () => (agentThinking !== undefined ? [agent] : []),
    running: () => 0,
    stop: async () => {},
    send: () => undefined,
    live: () => undefined,
    historyDir: () => undefined,
    commands: () => ({
      contextUsage: () => undefined,
      grants: { root, store: new SessionGrantStore({ workspaceRoot: root }), configRules: [] },
      tasks: () => undefined,
      ...(agentThinking !== undefined ? { thinking: agentThinking } : {}),
    }),
  };
  let mode: "prompt" | "yolo" = "prompt";
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir: root,
    agents,
    approvalMode: () => ({ get: () => mode, set: (next) => (mode = next) }),
    thinking: () => main,
    autocomplete: { basePath: root, fdPath: null },
  });
  shell.start();
  return {
    shell,
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const statusLine = (term: MockTerminal): string =>
  screenText(term)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1)
    ?.trim() ?? "";

async function command(term: MockTerminal, text: string): Promise<void> {
  term.input("\x15");
  term.input(text);
  term.input("\r");
  await settle();
}

test("轮换顺序：off → low → medium → high → xhigh → off；minimal 的下一档为 low，max 的下一档为 off", () => {
  assert.deepEqual(
    ["off", "low", "medium", "high", "xhigh", "minimal", "max"].map((level) =>
      nextEffort(level as ThinkingLevel)
    ),
    ["low", "medium", "high", "xhigh", "off", "low", "off"]
  );
});

test("Alt+T 轮换主代理的档位，状态栏紧跟审批模式当场更新；模型不支持推理时不切换", async () => {
  const main = control("minimal");
  const { term, cleanup } = makeShell(main);
  try {
    await settle();
    assert.match(statusLine(term), /^ask · minimal · /);
    for (const expected of ["low", "medium", "high", "xhigh", "off", "low"]) {
      term.input(ALT_T);
      await settle();
      assert.match(statusLine(term), new RegExp(`^ask · ${expected} · `));
    }
    assert.deepEqual(main.sets, ["low", "medium", "high", "xhigh", "off", "low"]);
  } finally {
    cleanup();
  }
  const fixed = control("off", false);
  const unsupported = makeShell(fixed);
  try {
    await settle();
    unsupported.term.input(ALT_T);
    await settle();
    assert.deepEqual(fixed.sets, []);
    assert.match(statusLine(unsupported.term), /^ask · off · /);
    assert.doesNotMatch(screenText(unsupported.term), /reasoning/, "不提示");
  } finally {
    unsupported.cleanup();
  }
});

test("/effort <档位> 切换并写一行；同档、非法档位与不支持推理各有说明；运行中可用", async () => {
  const main = control("high");
  const { shell, term, runtime, cleanup } = makeShell(main);
  try {
    await settle();
    await command(term, "/effort low");
    assert.match(screenText(term), /effort set to low \(from the next request\)/);
    assert.match(statusLine(term), /^ask · low · /);
    await command(term, "/effort low");
    assert.match(screenText(term), /effort is already low/);
    await command(term, "/effort turbo");
    assert.match(
      screenText(term),
      /unknown effort level: turbo \(use off, minimal, low, medium, high, xhigh\)/
    );
    await command(term, "/effort max");
    assert.match(screenText(term), /unknown effort level: max/);
    assert.deepEqual(main.sets, ["low"]);
    // 运行中可用
    runtime.autoResolve = false;
    term.input("go");
    term.input("\r");
    await settle();
    assert.equal(shell.isRunning(), true);
    await command(term, "/effort medium");
    assert.match(screenText(term), /effort set to medium/);
    assert.deepEqual(main.sets, ["low", "medium"]);
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
  const fixed = control("off", false);
  const unsupported = makeShell(fixed);
  try {
    await settle();
    await command(unsupported.term, "/effort high");
    assert.match(
      screenText(unsupported.term),
      /this model doesn't support reasoning; effort stays off/
    );
    assert.deepEqual(fixed.sets, []);
  } finally {
    unsupported.cleanup();
  }
});

test("/effort 不带参数：命令留在输入框，档位列在输入框下方并标出当前档位；选一项回车即切换", async () => {
  const main = control("medium");
  const { shell, term, cleanup } = makeShell(main);
  try {
    await settle();
    term.input("/effort");
    await settle();
    term.input("\r");
    await settle();
    assert.equal(shell.inputText(), "/effort ");
    const screen = screenText(term);
    for (const level of ["off", "minimal", "low"]) {
      assert.match(screen, new RegExp(`^\\s*(?:>\\s*)?${level}\\s*$`, "m"));
    }
    assert.match(screen, /medium\s+current/);
    term.input("xh");
    await settle();
    term.input("\t");
    await settle();
    assert.equal(shell.inputText().trim(), "/effort xhigh");
    term.input("\r");
    await settle();
    assert.deepEqual(main.sets, ["xhigh"]);
  } finally {
    cleanup();
  }
});

test("子 agent 视图里 /effort 与 Alt+T 改的是那个子 agent 的档位，状态栏写它的；主代理的不动", async () => {
  const main = control("high");
  const sub = control("low");
  const { shell, term, cleanup } = makeShell(main, sub);
  try {
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "agent");
    assert.match(statusLine(term), /^ask · low/);
    term.input(ALT_T);
    await settle();
    await command(term, "/effort xhigh");
    assert.deepEqual(sub.sets, ["medium", "xhigh"]);
    assert.deepEqual(main.sets, []);
    assert.match(statusLine(term), /^ask · xhigh/);
    // 决策 514：子 agent 视图里的状态栏同样上色
    assert.ok(term.writes.join("").includes("\x1b[31mxhigh\x1b[39m"));
  } finally {
    cleanup();
  }
});

test("/status：主代理的 mode 行写 ask · effort high · model …；子 agent 的写在 model 行", () => {
  const report: StatusReport = {
    sessionId: "01M55M13BH9PCSN7ZRE80986QS",
    project: "~/code/myapp",
    cwd: "",
    settings: [],
    mode: "prompt",
    effort: "high",
    model: "deepseek-chat",
  };
  assert.match(statusReportText(report), /^mode {5}ask · effort high · model deepseek-chat$/m);
  assert.match(
    agentStatusText({
      name: "general-1",
      type: "general",
      state: "idle",
      session: { id: "s1" },
      cwd: "",
      model: "deepseek-chat",
      effort: "low",
    }),
    /^model {4}deepseek-chat · effort low$/m
  );
});
