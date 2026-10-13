// 决策 443：会话面板的会话池（进程内版）。派出即在跑、跑完空闲并取最后一条回复的开头作摘要；审批挂着时在"等待回应"、
// 排在最前；在跑时不能发、空闲时发了接着跑；停下先中断再释放、之后只读；偷看给等待中的问题与最近的对话；开运行面失败
// 记为失败；关掉全部停止、之后不能再派。
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
  finish(reply: string): void;
  fail(message: string): void;
  runs: string[];
  interrupted: number;
  closed: boolean;
}

function harness(options: { failOpen?: boolean } = {}) {
  const fakes: Fake[] = [];
  let seq = 0;
  let clock = 1000;
  const pool = new LocalSessionPool({
    now: () => (clock += 1),
    open: async ({ hooks }) => {
      if (options.failOpen === true) throw new Error("开不了");
      seq += 1;
      const transcript: Array<{ role: string; content: string }> = [];
      let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
      const fake: Fake = {
        hooks,
        runs: [],
        interrupted: 0,
        closed: false,
        finish: (reply) => {
          transcript.push({ role: "assistant", content: reply });
          const current = pending;
          pending = undefined;
          current?.resolve();
        },
        fail: (message) => {
          const current = pending;
          pending = undefined;
          current?.reject(new Error(message));
        },
        runtime: {
          sessionId: `sess_${seq}`,
          worktree: { path: `/wt/s${seq}`, branch: `pigeon-wt/s${seq}` },
          run: (text) => {
            fake.runs.push(text);
            transcript.push({ role: "user", content: text });
            return new Promise<void>((resolve, reject) => {
              pending = { resolve, reject };
            });
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
          take: () => `取回 s${seq}`,
        },
      };
      fakes.push(fake);
      return fake.runtime;
    },
  });
  return { pool, fakes };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("派出即在跑；跑完空闲、摘要取最后一条回复的开头；空闲时发了接着跑，在跑时不能发", async () => {
  const { pool, fakes } = harness();
  const card = await pool.spawn("修一下登录");
  assert.equal(card.name, "s1");
  assert.equal(card.state, "running");
  assert.equal(card.id, "sess_1");
  assert.deepEqual(card.worktree, { path: "/wt/s1", branch: "pigeon-wt/s1" });
  assert.match(pool.send(card.id, "再看看") ?? "", /正在跑/);
  fakes[0]?.finish("登录修好了，\n测试都过了");
  await tick();
  assert.equal(pool.list()[0]?.state, "idle");
  assert.equal(pool.list()[0]?.summary, "登录修好了， 测试都过了");
  assert.equal(pool.send(card.id, "再看看"), undefined);
  assert.equal(pool.list()[0]?.state, "running");
  assert.deepEqual(fakes[0]?.runs, ["修一下登录", "再看看"]);
});

test("审批挂着时在等待回应、排在最前；落定后回到在跑；偷看给等待中的问题与最近的对话", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  const second = await pool.spawn("二");
  // 等待回应的那张更早更新，空闲的那张更晚：仍是等待回应在前
  fakes[1]?.hooks.waiting('run_command {"command":"npm test"}');
  fakes[0]?.finish("一做完了");
  await tick();
  const order = pool.list().map((card) => [card.name, card.state]);
  assert.deepEqual(order, [
    ["s2", "waiting"],
    ["s1", "idle"],
  ]);
  const peek = pool.peek(second.id);
  assert.equal(peek[0], "s2：二");
  assert.match(peek[1] ?? "", /^等待回应：run_command/);
  assert.ok(peek.includes("> 二"));
  fakes[1]?.hooks.waiting(undefined);
  assert.equal(pool.list().find((card) => card.name === "s2")?.state, "running");
});

test("停下先中断再释放，之后只读；取回交给运行面；运行失败记为失败", async () => {
  const { pool, fakes } = harness();
  const card = await pool.spawn("一");
  await pool.stop(card.id);
  assert.equal(fakes[0]?.interrupted, 1);
  assert.equal(fakes[0]?.closed, true);
  assert.equal(pool.list()[0]?.state, "stopped");
  assert.match(pool.send(card.id, "再来") ?? "", /已停/);
  assert.equal(pool.take(card.id), "取回 s1");
  const other = await pool.spawn("二");
  fakes[1]?.fail("模型请求失败");
  await tick();
  const failed = pool.list().find((item) => item.id === other.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "模型请求失败");
  assert.match(pool.take(other.id), /取回 s2/);
});

test("开运行面失败记为失败；关掉全部停止，之后不能再派", async () => {
  const failing = harness({ failOpen: true });
  const card = await failing.pool.spawn("一");
  assert.equal(card.state, "failed");
  assert.equal(card.error, "开不了");
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await pool.spawn("二");
  await pool.closeAll();
  assert.deepEqual(
    fakes.map((fake) => fake.closed),
    [true, true]
  );
  assert.ok(pool.list().every((item) => item.state === "stopped"));
  await assert.rejects(() => pool.spawn("三"), /已关闭/);
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
  const card = await pool.spawn("做事");
  await tick();
  assert.deepEqual(pool.peek(card.id), ["s1：做事", "> 做事", "  做完了"]);
});
