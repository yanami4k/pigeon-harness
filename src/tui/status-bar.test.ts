// 决策 286 第 2 项、决策 468：输入框下方一行状态栏——上下文用量百分比与本会话累计的 token 数（不写模型名与花费）。
// token 数取会话记录里模型回复自带的用量；续接会话从会话记录累计已有用量（主会话、其 worker 与旧会话里的复盘）。
// 窄终端换短写法，不折行。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { MailGate } from "../application/agent-mail.ts";
import { BUILT_IN_AGENT_TYPES } from "../application/agent-types.ts";
import { emptyCostTally } from "../application/session-cost.ts";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import type { SubagentInspect } from "../application/subagent-runtime.ts";
import { AgentHub, type SubagentRuntime } from "../application/subagents.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { agentCommandsFace } from "./agent-commands.ts";
import { ScriptedRuntime, usageOf } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { clipToWidth, StatusBar, statusBarText } from "./status-bar.ts";
import { statusReportText } from "./status-report.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function lastLine(term: MockTerminal): string {
  return term.screen.contentLines().at(-1) ?? "";
}

function makeShell(options: { cols?: number; sessionId?: SessionId; root?: string }): {
  shell: PigeonTuiShell;
  term: MockTerminal;
  runtime: ScriptedRuntime;
  cleanup: () => void;
} {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-status-"));
  const sessionId = options.sessionId ?? newSessionId();
  const term = new MockTerminal(options.cols ?? 100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    ...(options.root !== undefined ? { sessions: { root: options.root } } : {}),
  });
  return {
    shell,
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("状态栏在输入框下方：上下文用量随最近一次回复与压缩更新、本会话 token 数与美元花费按轮累计", async () => {
  const { shell, term, runtime, cleanup } = makeShell({});
  try {
    runtime.context = { tokens: 0, contextWindow: 200_000 };
    shell.start();
    await settle();
    assert.equal(lastLine(term).trim(), "ctx 0% (0/200k) · 0 tokens");

    term.input("任务");
    term.input("\r");
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.context = { tokens: 50_000, contextWindow: 200_000 };
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(50_000, 0.0123),
    });
    await settle();
    assert.equal(lastLine(term).trim(), "ctx 25% (50k/200k) · 50k tokens · $0.0123");
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(1000, 0.0007),
    });
    // 压缩后上下文用量随之下降
    runtime.context = { tokens: 8000, contextWindow: 200_000 };
    runtime.compacted(50_000, 8000);
    await settle();
    assert.equal(lastLine(term).trim(), "ctx 4% (8.0k/200k) · 51k tokens · $0.0130");
    assert.doesNotMatch(lastLine(term), /cost|deepseek|¥/);
  } finally {
    cleanup();
  }
});

test("没有自带价格的回复只计 token；有价格的加写美元（决策 551）；没有上下文窗口信息时只写 token 与美元", async () => {
  const { shell, term, runtime, cleanup } = makeShell({});
  try {
    shell.start();
    await settle();
    term.input("任务");
    term.input("\r");
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(12_345, 0),
    });
    await settle();
    assert.equal(lastLine(term).trim(), "12k tokens");
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(100, 0.5),
    });
    await settle();
    assert.equal(lastLine(term).trim(), "12k tokens · $0.5000");
  } finally {
    cleanup();
  }
});

test("MODEL-040 决策 551：自带价格按 pi-ai 的美元金额相加；没有价格的一轮只加 token", async () => {
  const { shell, term, runtime, cleanup } = makeShell({});
  try {
    shell.start();
    await settle();
    term.input("任务");
    term.input("\r");
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(1_000_000, 0.5),
    });
    await settle();
    assert.equal(lastLine(term).trim(), "1.0M tokens · $0.5000");
    assert.doesNotMatch(lastLine(term), /¥/);
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(250_000, 0),
    });
    await settle();
    assert.equal(lastLine(term).trim(), "1.3M tokens · $0.5000");
  } finally {
    cleanup();
  }
});

test("没有价格的会话续接：主会话与复盘的用量同样累计；旧会话里的 worker 不再计入（决策 457）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-cost-deepseek-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const peak = Date.UTC(2026, 8, 29, 2, 0, 0);
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    main.assistant({
      text: "好",
      provider: "deepseek",
      timestamp: peak,
      usage: usageOf(1_000_000, 0),
    });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w1", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({
      text: "做完",
      provider: "deepseek",
      timestamp: peak,
      usage: usageOf(500_000, 0),
    });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({
      text: "记下",
      provider: "deepseek",
      timestamp: peak,
      usage: usageOf(250_000, 0),
    });
    review.endRun();
    await review.close();
    const { shell, term, cleanup } = makeShell({ sessionId: main.sessionId, root });
    try {
      shell.start();
      await settle();
      shell.announceResumed(root, []);
      await settle();
      assert.equal(lastLine(term).trim(), "1.3M tokens");
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("续接会话从会话记录累计已有用量：主会话 + 其复盘；旧会话里的 worker、别的会话与无关子会话不计", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-cost-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    main.assistant({ text: "好", usage: usageOf(1000, 0.05) });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w1", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({ text: "做完", usage: usageOf(500, 0.02) });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({
      task: "复盘",
      config: { memoryReview: { kind: "pre-compaction", template: "t" } },
    });
    review.assistant({ text: "记下了", usage: usageOf(300, 0.003) });
    review.endRun();
    await review.close();
    const other = createFixtureSession({ sessionsDir });
    other.startRun({ task: "别的会话" });
    other.assistant({ text: "嗯", usage: usageOf(100, 9) });
    other.endRun();
    await other.close();

    const { shell, term, cleanup } = makeShell({ sessionId: main.sessionId, root });
    try {
      shell.start();
      await settle();
      assert.equal(lastLine(term).trim(), "0 tokens", "新开时从零算");
      shell.announceResumed(root, ["续跑报告"]);
      await settle();
      assert.equal(lastLine(term).trim(), "1.3k tokens · $0.0530");
      assert.ok(screenText(term).includes("续跑报告"));
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧会话格式的 worker 子会话（决策 457）：收尾前后都不计入本会话用量", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-child-cost-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const mainId = newSessionId();
    const { shell, term, runtime, cleanup } = makeShell({ sessionId: mainId, root });
    try {
      shell.start();
      await settle();
      const main = createFixtureSession({ sessionsDir, sessionId: mainId });
      main.startRun({ task: "主任务" });
      const worker = spawnFixtureWorker(main, { sessionsDir, name: "w2", task: "子任务" });
      worker.startRun({ task: "子任务" });
      worker.assistant({ text: "进行中", usage: usageOf(400, 0.04) });
      await worker.writer.flush();
      term.input("任务");
      term.input("\r");
      await settle();
      assert.equal(lastLine(term).trim(), "0 tokens", "worker 没收尾不计");
      worker.endRun();
      await worker.close();
      await main.close();
      term.input("再来");
      term.input("\r");
      await settle();
      assert.deepEqual(runtime.runs, ["任务", "再来"]);
      assert.equal(lastLine(term).trim(), "0 tokens");
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("窄终端换短写法、不折行，最后硬截；上下文用量在最前", async () => {
  const state = {
    context: { tokens: 46_000, contextWindow: 200_000 },
    cost: {
      cost: 1.23456,
      pricedTokens: 1_150_000,
      unpricedTokens: 50_000,
    },
  };
  assert.equal(statusBarText(state, 200), "ctx 23% (46k/200k) · 1.2M tokens · $1.2346");
  assert.equal(statusBarText(state, 22), "ctx 23% · 1.2M · $1.23");
  assert.equal(statusBarText(state, 20), "ctx 23% · 1.2M · $1.");
  assert.equal(statusBarText(state, 5), "ctx 2");
  assert.equal(statusBarText({ cost: state.cost }, 200), "1.2M tokens · $1.2346");

  const { shell, term, runtime, cleanup } = makeShell({ cols: 40 });
  try {
    runtime.context = { tokens: 150_000, contextWindow: 200_000 };
    shell.start();
    await settle();
    const bar = lastLine(term);
    assert.ok(visibleWidth(bar) <= 40, bar);
    assert.ok(bar.includes("ctx 75%"), bar);
    assert.equal(
      term.screen.contentLines().filter((line) => line.includes("ctx 75%")).length,
      1,
      "状态栏恰好一行"
    );
  } finally {
    cleanup();
  }
});

test("clipToWidth（决策 439 改用 truncateToWidth）：按显示宽度硬截、不补省略号与空格、宽字符不劈开；长串线性", () => {
  assert.equal(clipToWidth("abcdef", 4), "abcd");
  assert.equal(clipToWidth("中文字符", 5), "中文");
  assert.equal(clipToWidth("ab", 10), "ab");
  assert.equal(clipToWidth("abc", 0), "");
  const long = "x".repeat(200_000);
  const started = Date.now();
  assert.equal(clipToWidth(long, 120).length, 120);
  assert.ok(Date.now() - started < 500);
});

test("状态栏的思考强度段只写档位（VIEWS-010）；/status 的 mode 行仍写 effort <档位>", () => {
  assert.equal(
    statusBarText({ mode: "prompt", effort: "high", cost: emptyCostTally() }, 200),
    "ask · high · 0 tokens"
  );
  assert.equal(
    statusBarText({ mode: "yolo", effort: "off", cost: emptyCostTally() }, 200),
    "bypass · off · 0 tokens"
  );
  assert.match(
    statusReportText({
      sessionId: "sess_01M55M13BH9PCSN7ZRE80986QS",
      project: "~",
      cwd: "",
      settings: [],
      mode: "prompt",
      effort: "high",
    }),
    /^mode {5}ask · effort high$/m
  );
});

test("MODEL-020 when the model's context window is unknown the status bar leaves out the context percentage", () => {
  assert.equal(
    statusBarText(
      {
        cost: { ...emptyCostTally(), pricedTokens: 12_000 },
        context: { tokens: 12_000, contextWindow: 0 },
      },
      200
    ),
    "12k tokens"
  );
});

test("MODEL-022 the status bar shows the model in dim text after the mode and before the effort", () => {
  assert.equal(
    statusBarText(
      { mode: "prompt", model: "deepseek-chat", effort: "high", cost: emptyCostTally() },
      200
    ),
    "ask · deepseek-chat · high · 0 tokens"
  );
  const bar = new StatusBar({
    mode: "yolo",
    model: "deepseek-chat",
    effort: "low",
    cost: emptyCostTally(),
  }).render(80)[0];
  assert.equal(
    bar,
    " \x1b[38;5;208mbypass\x1b[39m\x1b[2m · \x1b[22m\x1b[2mdeepseek-chat\x1b[22m\x1b[2m · \x1b[22m\x1b[32mlow\x1b[39m\x1b[2m · 0 tokens\x1b[22m"
  );
});

test("MODEL-031 the subagent view keeps the owning session's model until per-subagent display lands", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-model-agent-"));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-model-agent-log-"));
  const hub = new AgentHub({ mail: new MailGate() });
  const sessionId = newSessionId();
  const inspections = new WeakMap<SubagentRuntime, SubagentInspect>();
  const { host } = hub.registerSession({
    sessionId,
    name: () => "main",
    deliver: () => {},
    pendingNotices: () => 0,
    record: () => {},
    catalog: () => ({ types: BUILT_IN_AGENT_TYPES, problems: [] }),
    limits: () => ({ maxConcurrent: 20, maxDepth: 3 }),
    open: async () => {
      const runtime: SubagentRuntime = {
        sessionId: newSessionId(),
        run: async () => ({ status: "completed" }),
        runNotices: async () => ({ status: "completed" }),
        notify: () => {},
        pendingNotices: () => 0,
        interrupt: async () => {},
        reply: () => "done",
        record: () => {},
        close: async () => {},
      };
      inspections.set(runtime, {
        governanceRoot: root,
        // 子 agent 自己有另一个型号：M1 里状态栏仍写所属会话的
        modelId: "agent-own-model",
        bundle: {
          thinking: {
            get: () => "high",
            set: () => {},
            levels: ["off", "low", "medium", "high", "xhigh"],
          },
          adapter: { contextUsage: () => ({ tokens: 10, contextWindow: 1000 }) },
          sessionStore: { filePath: async () => undefined },
          grantStore: {},
          configGrants: [],
          settings: { grants: [] },
        },
      } as unknown as SubagentInspect);
      return runtime;
    },
  });
  await host.spawn({ task: "find the parser", type: "explore" });
  await settle(20);
  const term = new MockTerminal(100, 30);
  const historyDir = () => undefined;
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    model: () => "owner-model",
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
  });
  shell.start();
  try {
    await settle();
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "agent");
    assert.match(lastLine(term), /owner-model/);
    assert.doesNotMatch(lastLine(term), /agent-own-model/);
  } finally {
    shell.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// spec: VIEWS-060, VIEWS-061
test("决策 514：状态栏上色——ask 青色、bypass 橙色（38;5;208）；off 正常前景色、low 绿、medium 黄、high 品红、xhigh 红；其余暗色", () => {
  const render = (mode: "prompt" | "yolo", effort?: "off" | "low" | "medium" | "high" | "xhigh") =>
    new StatusBar({
      mode,
      ...(effort !== undefined ? { effort } : {}),
      cost: emptyCostTally(),
    }).render(80)[0];
  assert.equal(render("prompt"), " \x1b[36mask\x1b[39m\x1b[2m · 0 tokens\x1b[22m");
  assert.equal(render("yolo"), " \x1b[38;5;208mbypass\x1b[39m\x1b[2m · 0 tokens\x1b[22m");
  assert.equal(
    render("prompt", "off"),
    " \x1b[36mask\x1b[39m\x1b[2m · \x1b[22moff\x1b[2m · 0 tokens\x1b[22m",
    "off 不上色、也不暗"
  );
  const colors = { low: "32", medium: "33", high: "35", xhigh: "31" } as const;
  for (const [level, code] of Object.entries(colors)) {
    assert.equal(
      render("yolo", level as keyof typeof colors),
      ` \x1b[38;5;208mbypass\x1b[39m\x1b[2m · \x1b[22m\x1b[${code}m${level}\x1b[39m\x1b[2m · 0 tokens\x1b[22m`,
      level
    );
  }
  // 窄到档位只剩半截：那一截不上色
  const narrow = new StatusBar({ mode: "prompt", effort: "high", cost: emptyCostTally() }).render(
    10
  )[0];
  assert.ok(narrow?.includes("\x1b[36mask\x1b[39m"));
  assert.ok(!narrow?.includes("\x1b[35m"), narrow);
});
