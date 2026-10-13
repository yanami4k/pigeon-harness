// 决策 443：会话面板的会话池（进程内版）。派出时先"准备中"、开好即在跑，跑完空闲并取最后一条回复的开头作摘要；运行面
// 正常返回但结局失败记为失败；审批挂着时在"等待回应"、排在最前；在跑时不能发、空闲时发了接着跑；后台作业要叫醒时空闲即
// 只带通知跑一轮；开运行面期间被停不复活；停下先中断再释放、之后只读；偷看只列人说的话与回复；开运行面失败记为失败；
// 关掉时等还在开的开完再全部停止，整体有时限、超时如实返回；之后不能再派。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  LocalSessionPool,
  type PooledHooks,
  type PooledRuntime,
  replySummary,
} from "./session-pool.ts";

interface Fake {
  runtime: PooledRuntime;
  hooks: PooledHooks;
  finish(reply: string, result?: unknown): void;
  fail(message: string): void;
  runs: string[];
  noticeRuns: number;
  interrupted: number;
  closed: boolean;
}

function harness(
  options: { failOpen?: boolean; openGate?: Promise<void>; closeTimeoutMs?: number } = {}
) {
  const fakes: Fake[] = [];
  let seq = 0;
  let clock = 1000;
  const pool = new LocalSessionPool({
    now: () => (clock += 1),
    ...(options.closeTimeoutMs !== undefined ? { closeTimeoutMs: options.closeTimeoutMs } : {}),
    open: async ({ hooks }) => {
      await options.openGate;
      if (options.failOpen === true) throw new Error("开不了");
      seq += 1;
      const id = seq;
      const transcript: Array<Record<string, unknown>> = [];
      let pending:
        | { resolve: (result?: unknown) => void; reject: (error: Error) => void }
        | undefined;
      const begin = () =>
        new Promise<unknown>((resolve, reject) => {
          pending = { resolve, reject };
        });
      const fake: Fake = {
        hooks,
        runs: [],
        noticeRuns: 0,
        interrupted: 0,
        closed: false,
        finish: (reply, result) => {
          transcript.push({ role: "assistant", content: reply });
          const current = pending;
          pending = undefined;
          current?.resolve(result);
        },
        fail: (message) => {
          const current = pending;
          pending = undefined;
          current?.reject(new Error(message));
        },
        runtime: {
          sessionId: `sess_${id}`,
          worktree: { path: `/wt/s${id}`, branch: `pigeon-wt/s${id}` },
          run: (text) => {
            fake.runs.push(text);
            transcript.push({ role: "user", content: text });
            return begin();
          },
          runNotices: () => {
            fake.noticeRuns += 1;
            transcript.push({ role: "user", content: "[Background job notice] j1 结束了" });
            return begin();
          },
          interrupt: () => {
            fake.interrupted += 1;
            fake.finish("（中断）");
          },
          isRunning: () => pending !== undefined,
          transcript: () => transcript,
          close: async () => {
            fake.closed = true;
          },
          take: (state) => `取回 s${id}（${state}）`,
        },
      };
      fakes.push(fake);
      return fake.runtime;
    },
  });
  return { pool, fakes };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await tick();
};

test("派出先准备中、开好即在跑；跑完空闲、摘要取最后一条回复的开头；空闲时发了接着跑，在跑时不能发", async () => {
  const { pool, fakes } = harness();
  const card = await pool.spawn("修一下登录");
  assert.equal(card.name, "s1");
  assert.equal(card.state, "preparing");
  await settle();
  const opened = pool.list()[0];
  assert.equal(opened?.state, "running");
  assert.equal(opened?.id, "sess_1");
  assert.deepEqual(opened?.worktree, { path: "/wt/s1", branch: "pigeon-wt/s1" });
  assert.match((await pool.send("sess_1", "再看看")) ?? "", /正在跑/);
  fakes[0]?.finish("登录修好了，\n测试都过了");
  await settle();
  assert.equal(pool.list()[0]?.state, "idle");
  assert.equal(pool.list()[0]?.summary, "登录修好了， 测试都过了");
  assert.equal(await pool.send("sess_1", "再看看"), undefined);
  assert.equal(pool.list()[0]?.state, "running");
  assert.deepEqual(fakes[0]?.runs, ["修一下登录", "再看看"]);
});

test("运行面正常返回但结局失败：记为失败并写明原因", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await settle();
  fakes[0]?.finish("", { status: "failed", errorMessage: "模型请求失败" });
  await settle();
  assert.equal(pool.list()[0]?.state, "failed");
  assert.equal(pool.list()[0]?.error, "模型请求失败");
});

test("审批挂着时在等待回应、排在最前；落定后回到在跑；偷看只列人说的话与回复", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await pool.spawn("二");
  await settle();
  // 等待回应的那张更早更新，空闲的那张更晚：仍是等待回应在前
  fakes[1]?.hooks.waiting('run_command {"command":"npm test"}');
  fakes[0]?.finish("一做完了");
  await settle();
  assert.deepEqual(
    pool.list().map((card) => [card.name, card.state]),
    [
      ["s2", "waiting"],
      ["s1", "idle"],
    ]
  );
  const peek = await pool.peek("sess_2");
  assert.equal(peek[0], "s2：二");
  assert.match(peek[1] ?? "", /^等待回应：run_command/);
  assert.ok(peek.includes("> 二"));
  fakes[1]?.hooks.waiting(undefined);
  assert.equal(pool.list().find((card) => card.name === "s2")?.state, "running");
});

test("后台作业要叫醒：空闲即只带通知跑一轮；偷看不列作业通知", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await settle();
  fakes[0]?.hooks.wake();
  assert.equal(fakes[0]?.noticeRuns, 0, "在跑时不另起一轮");
  fakes[0]?.finish("一做完了");
  await settle();
  fakes[0]?.hooks.wake();
  assert.equal(fakes[0]?.noticeRuns, 1);
  assert.equal(pool.list()[0]?.state, "running");
  fakes[0]?.finish("看过作业结果了");
  await settle();
  const peek = await pool.peek("sess_1");
  assert.ok(!peek.some((line) => line.includes("Background job notice")));
  assert.ok(peek.includes("  看过作业结果了"));
});

test("开运行面期间被停：开完即释放，不开跑", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, fakes } = harness({ openGate: gate });
  const card = await pool.spawn("一");
  const stopping = pool.stop(card.id);
  release?.();
  await stopping;
  await settle();
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.equal(fakes[0]?.closed, true);
  assert.deepEqual(fakes[0]?.runs, [], "没有开跑");
});

test("停下先中断再释放，之后只读；取回交给运行面；运行抛错记为失败", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await settle();
  await pool.stop("sess_1");
  assert.equal(fakes[0]?.interrupted, 1);
  assert.equal(fakes[0]?.closed, true);
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.match((await pool.send("sess_1", "再来")) ?? "", /已停/);
  assert.equal(await pool.take("sess_1"), "取回 s1（stopped）");
  await pool.spawn("二");
  await settle();
  fakes[1]?.fail("连接断了");
  await settle();
  const failed = pool.list().find((item) => item.id === "sess_2");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "连接断了");
});

test("开运行面失败记为失败；关掉时等还在开的开完再停，之后不能再派；超时如实返回", async () => {
  const failing = harness({ failOpen: true });
  await failing.pool.spawn("一");
  await settle();
  assert.equal(failing.pool.list()[0]?.state, "failed");
  assert.equal(failing.pool.list()[0]?.error, "开不了");

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pool, fakes } = harness({ openGate: gate });
  await pool.spawn("一");
  const closing = pool.closeAll();
  release?.();
  assert.deepEqual(await closing, []);
  assert.equal(fakes[0]?.closed, true, "还在开的开完即释放");
  assert.ok(pool.list().every((item) => item.state === "stopped"));
  await assert.rejects(() => pool.spawn("三"), /已关闭/);

  // 先被停（没等它开完）的会话：关掉时照样等它开完、释放
  let releaseLater: (() => void) | undefined;
  const later = harness({
    openGate: new Promise<void>((resolve) => {
      releaseLater = resolve;
    }),
  });
  const pending = await later.pool.spawn("四");
  void later.pool.stop(pending.id);
  const closingLater = later.pool.closeAll();
  let closedAll = false;
  void closingLater.then(() => {
    closedAll = true;
  });
  await settle();
  assert.equal(closedAll, false, "关掉在等还在开的会话");
  releaseLater?.();
  await closingLater;
  assert.equal(later.fakes[0]?.closed, true);

  const stuck = harness({ openGate: new Promise(() => {}), closeTimeoutMs: 50 });
  await stuck.pool.spawn("一");
  const problems = await stuck.pool.closeAll();
  assert.match(problems[0] ?? "", /没有在 0 秒内停下/);
});

test("摘要：最后一条有文字的助手回复，压成一行，过长截断", () => {
  assert.equal(
    replySummary([
      { role: "assistant", content: [{ type: "text", text: "早的" }] },
      { role: "user", content: "问" },
      { role: "assistant", content: [{ type: "toolCall" }] },
    ]),
    "早的"
  );
  assert.equal(replySummary([{ role: "assistant", content: "x".repeat(200) }]).length, 121);
  assert.equal(replySummary([]), "");
});

test("偷看不列开工状态块（不是人说的话）", async () => {
  const pool = new LocalSessionPool({
    open: async () => ({
      sessionId: "sess_status",
      run: async () => {},
      interrupt: () => {},
      isRunning: () => false,
      transcript: () => [
        { role: "user", content: "<pigeon-status>…</pigeon-status>", pigeonStatus: true },
        { role: "user", content: "做事" },
        { role: "assistant", content: "做完了" },
      ],
      close: async () => {},
    }),
  });
  await pool.spawn("做事");
  await settle();
  assert.deepEqual(await pool.peek("sess_status"), ["s1：做事", "> 做事", "  做完了"]);
});
