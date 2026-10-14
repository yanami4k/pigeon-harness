// 决策 286 第 2 项、决策 468：输入框下方一行状态栏——上下文用量百分比与本会话累计的 token 数（不写模型名与花费）。
// token 数取会话记录里模型回复自带的用量；续接会话从会话记录累计已有用量（主会话、其 worker 与旧会话里的复盘）。
// 窄终端换短写法，不折行。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createFixtureSession, spawnFixtureWorker } from "../application/session-store-fixtures.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { ScriptedRuntime, usageOf } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { clipToWidth, statusBarText } from "./status-bar.ts";
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

test("状态栏在输入框下方：上下文用量随最近一次回复与压缩更新、本会话 token 数按轮累计；不写模型名与花费", async () => {
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
    assert.equal(lastLine(term).trim(), "ctx 25% (50k/200k) · 50k tokens");
    runtime.emit(RuntimeEventKind.TurnCompleted, {
      stopReason: "stop",
      syntheticFailure: false,
      usage: usageOf(1000, 0.0007),
    });
    // 压缩后上下文用量随之下降
    runtime.context = { tokens: 8000, contextWindow: 200_000 };
    runtime.compacted(50_000, 8000);
    await settle();
    assert.equal(lastLine(term).trim(), "ctx 4% (8.0k/200k) · 51k tokens");
    assert.doesNotMatch(lastLine(term), /cost|\$|deepseek/);
  } finally {
    cleanup();
  }
});

test("有价格与没有价格的回复一样计 token 数，不写价格；没有上下文窗口信息时只写 token 数", async () => {
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
    assert.equal(lastLine(term).trim(), "12k tokens");
    assert.doesNotMatch(lastLine(term), /no price|\$/);
  } finally {
    cleanup();
  }
});

test("DeepSeek 会话：按人民币价目计的部分同样计 token 数，状态栏不写金额", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-status-deepseek-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    provider: "deepseek",
  });
  // 2026-09-29（周二）北京时间 10:00 为高峰、20:00 为空闲
  const peak = Date.UTC(2026, 8, 29, 2, 0, 0);
  const offPeak = Date.UTC(2026, 8, 29, 12, 0, 0);
  const completed = { stopReason: "stop", syntheticFailure: false, usage: usageOf(1_000_000, 0) };
  try {
    shell.start();
    await settle();
    term.input("任务");
    term.input("\r");
    // 高峰：缓存未命中输入 100 万 token，¥1 × 2
    runtime.emit(RuntimeEventKind.TurnStarted, {}, peak);
    runtime.emit(RuntimeEventKind.TurnCompleted, completed, peak + 5000);
    await settle();
    assert.equal(lastLine(term).trim(), "1.0M tokens");
    assert.doesNotMatch(lastLine(term), /¥/);
    // 空闲：¥1
    runtime.emit(RuntimeEventKind.TurnStarted, {}, offPeak);
    runtime.emit(RuntimeEventKind.TurnCompleted, completed, offPeak + 5000);
    await settle();
    assert.equal(lastLine(term).trim(), "2.0M tokens");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("DeepSeek 会话续接：主会话、worker 与复盘的用量同样累计", async () => {
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
      assert.equal(lastLine(term).trim(), "1.8M tokens");
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("续接会话从会话记录累计已有用量：主会话 + 其 worker + 其复盘；别的会话与无关子会话不计", async () => {
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
      assert.equal(lastLine(term).trim(), "1.8k tokens");
      assert.ok(screenText(term).includes("续跑报告"));
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("本会话运行期间收尾的 worker 用量计入；没收尾的不计", async () => {
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
      assert.equal(lastLine(term).trim(), "400 tokens");
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
      pricedTokens: 1_000_000,
      cny: 0.5,
      cnyTokens: 150_000,
      unpricedTokens: 50_000,
    },
  };
  assert.equal(statusBarText(state, 200), "ctx 23% (46k/200k) · 1.2M tokens");
  assert.equal(statusBarText(state, 20), "ctx 23% · 1.2M");
  assert.equal(statusBarText(state, 5), "ctx 2");
  assert.equal(statusBarText({ cost: state.cost }, 200), "1.2M tokens");

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
