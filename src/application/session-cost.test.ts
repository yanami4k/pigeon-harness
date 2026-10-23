// 会话花费（决策 286 第 2 项）：价格取会话记录里模型回复自带的用量与价格，没有价格的 token 单列；
// 本会话 = 主会话 + 其 worker + 其复盘；/fork 分支与别的会话不计；运行期间新出现的子会话收尾后计入一次。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  accumulatedSessionCost,
  ChildSessionCosts,
  costTallyOfView,
  sessionCostTally,
} from "./session-cost.ts";
import { createFixtureSession, forkFixture, spawnFixtureWorker } from "./session-store-fixtures.ts";

function usage(totalTokens: number, cost: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

test("累计花费：主会话 + 复盘；旧会话里的 worker（决策 457）、/fork 分支、别的会话不计；无价格的 token 单列；工具另发请求的用量计入", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cost-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const main = createFixtureSession({ sessionsDir });
    const runId = main.startRun({ task: "主任务" });
    main.assistant({ text: "好", usage: usage(1000, 0.1) });
    main.toolTurn({
      name: "web_fetch",
      result: "提炼",
      details: { modelUsage: usage(200, 0.01) },
    });
    main.assistant({ text: "没有价格的模型", usage: usage(700, 0) });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({ text: "做完", usage: usage(300, 0.02) });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({ text: "记下", usage: usage(50, 0.005) });
    review.endRun();
    await review.close();
    const branch = await forkFixture({
      sessionsDir,
      sourceSessionId: main.sessionId,
      runId,
      runSeq: 2,
    });
    branch.startRun({ task: "分支续跑" });
    branch.assistant({ text: "分支", usage: usage(999, 5) });
    branch.endRun();
    await branch.close();

    const own = sessionCostTally(sessionsDir, main.sessionId);
    assert.deepEqual(
      { cost: Number(own.cost.toFixed(4)), priced: own.pricedTokens, unpriced: own.unpricedTokens },
      { cost: 0.11, priced: 1200, unpriced: 700 }
    );
    const total = accumulatedSessionCost(sessionsDir, main.sessionId);
    assert.equal(
      Number(total.cost.toFixed(4)),
      0.115,
      "0.1 + 0.01 + 0.005，不含旧 worker 的 0.02 与分支的 5"
    );
    assert.equal(total.unpricedTokens, 700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行期间的子会话（复盘）：收尾后计入一次；没收尾的下次再看；旧会话格式的 worker 不计", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cost-child-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    const early = spawnFixtureWorker(main, { sessionsDir, name: "early", task: "早先的" });
    early.startRun({ task: "早先的" });
    early.assistant({ text: "早", usage: usage(10, 1) });
    early.endRun();
    await early.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const tracker = new ChildSessionCosts(sessionsDir, main.sessionId, Date.now());
    const late = spawnFixtureWorker(main, { sessionsDir, name: "late", task: "之后的" });
    late.startRun({ task: "之后的" });
    late.assistant({ text: "晚", usage: usage(20, 0.3) });
    late.endRun();
    await late.close();
    assert.equal(tracker.collect().cost, 0, "旧会话格式的 worker 不计");
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({ text: "记下", usage: usage(30, 0.2) });
    await review.writer.flush();
    assert.equal(tracker.collect().cost, 0, "没收尾不计");
    review.endRun();
    await review.close();
    assert.equal(tracker.collect().cost, 0.2);
    assert.equal(tracker.collect().cost, 0, "只计一次");
    main.endRun();
    await main.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("决策 551：没有自带价格而用了 token 的记作无价格；有自带价格的按美元累加", () => {
  const view = (messages: unknown[]) =>
    ({ messages }) as unknown as Parameters<typeof costTallyOfView>[0];
  const unpriced = costTallyOfView(view([{ timestamp: 0, usage: { ...usage(1_000_000, 0) } }]));
  assert.deepEqual(unpriced, { cost: 0, pricedTokens: 0, unpricedTokens: 1_000_000 });
  const priced = costTallyOfView(
    view([
      { timestamp: 0, usage: usage(1000, 0.25) },
      { timestamp: 1, usage: usage(500, 0) },
    ])
  );
  assert.deepEqual(priced, { cost: 0.25, pricedTokens: 1000, unpricedTokens: 500 });
});

test("决策 551：续接累计按美元金额与 token 相加（主会话 + 复盘；旧 worker 不计）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-cost-usd-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const main = createFixtureSession({ sessionsDir });
    main.startRun({ task: "主任务" });
    main.assistant({ text: "好", usage: usage(1_000_000, 0.4) });
    const worker = spawnFixtureWorker(main, { sessionsDir, name: "w", task: "子任务" });
    main.endRun();
    worker.startRun({ task: "子任务" });
    worker.assistant({ text: "做完", usage: usage(500_000, 0.2) });
    worker.endRun();
    await worker.close();
    await main.close();
    const review = createFixtureSession({ sessionsDir, parentSessionId: main.sessionId });
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({ text: "记下", usage: usage(250_000, 0.1) });
    review.endRun();
    await review.close();
    const total = accumulatedSessionCost(sessionsDir, main.sessionId);
    assert.equal(Number(total.cost.toFixed(4)), 0.5);
    assert.equal(total.pricedTokens, 1_250_000);
    assert.equal(total.unpricedTokens, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
