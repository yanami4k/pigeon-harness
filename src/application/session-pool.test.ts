// 决策 443：会话面板的会话池（进程内版）。派出时先"准备中"、开好即在跑，跑完空闲并取最后一条回复的开头作摘要；运行面
// 正常返回但结局失败记为失败；审批挂着时在"等待回应"、排在最前；在跑时不能发、空闲时发了接着跑；后台作业要叫醒时空闲即
// 只带通知跑一轮；开运行面期间被停不复活；停下只中断这一轮、去掉才释放（决策 483）；偷看只列人说的话与回复；开运行面失败
// 记为失败；关掉时等还在开的开完再全部停止，整体有时限、超时如实返回；之后不能再派。决策 484：收进开着的会话（带上在跑的
// 这一轮与排着的输入）、取出交回、空闲时做事。
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
  options: {
    failOpen?: boolean;
    openGate?: Promise<void>;
    closeTimeoutMs?: number;
    // 中断不立即落定（真运行面的中断是异步的）
    lateInterrupt?: boolean;
    // 运行面在这一轮里报不在跑（钩子、压缩等窗口）
    quiet?: boolean;
  } = {}
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
            if (options.lateInterrupt !== true) fake.finish("（中断）");
          },
          isRunning: () => options.quiet !== true && pending !== undefined,
          transcript: () => transcript,
          close: async () => {
            fake.closed = true;
          },
          take: () => `取回 s${id}`,
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
  assert.match((await pool.send("sess_1", "再看看")) ?? "", /is running/);
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
  const settled = fakes[1]?.hooks.waiting('run_command {"command":"npm test"}');
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
  assert.equal(peek[0], "s2: 二");
  assert.match(peek[1] ?? "", /^waiting: run_command/);
  assert.ok(peek.includes("> 二"));
  settled?.();
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

test("决策 483：停下只中断这一轮、不释放（不被叫醒，收到话即接着干）；去掉才释放；取回交给运行面；运行抛错记为失败", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await settle();
  await pool.stop("sess_1");
  assert.equal(fakes[0]?.interrupted, 1);
  assert.equal(fakes[0]?.closed, false, "运行面不释放");
  assert.equal(pool.list()[0]?.state, "stopped");
  fakes[0]?.hooks.wake();
  assert.equal(fakes[0]?.noticeRuns, 0, "停下的不被叫醒");
  assert.equal(await pool.take("sess_1"), "取回 s1", "按还开着取");
  assert.equal(await pool.send("sess_1", "再来"), undefined);
  assert.equal(pool.list()[0]?.state, "running");
  fakes[0]?.finish("接着做完了");
  await settle();
  await pool.remove("sess_1");
  assert.equal(fakes[0]?.closed, true, "去掉即释放");
  assert.equal(pool.list().length, 0);
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
  await assert.rejects(() => pool.spawn("三"), /closed/);

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
  assert.match(problems[0] ?? "", /didn't stop within 0s/);
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
  assert.deepEqual(await pool.peek("sess_status"), ["s1: 做事", "> 做事", "  做完了"]);
});

test("决策 483：停下的会话里它的子 agent 在等审批，卡片照样标等待回应；答完回到已停", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await settle();
  await pool.stop("sess_1");
  const settled = fakes[0]?.hooks.waiting("general-1: edit_file a.ts");
  assert.equal(pool.list()[0]?.state, "waiting");
  assert.equal(pool.list()[0]?.waiting, "general-1: edit_file a.ts");
  settled?.();
  assert.equal(pool.list()[0]?.state, "stopped");
});

test("开运行面期间被停的会话：不能接着干、不能取回（运行面已释放）", async () => {
  let release: (() => void) | undefined;
  const { pool, fakes } = harness({
    openGate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const card = await pool.spawn("一");
  const stopping = pool.stop(card.id);
  release?.();
  await stopping;
  await settle();
  assert.match((await pool.send("sess_1", "再来")) ?? "", /is stopped/);
  assert.match(await pool.take("sess_1"), /is stopped/);
  assert.deepEqual(fakes[0]?.runs, []);
  assert.equal(pool.list()[0]?.state, "stopped");
});

test("这一轮在途但运行面报不在跑（钩子、压缩窗口）：不能再发、不能取回；停下照样中断", async () => {
  const { pool, fakes } = harness({ quiet: true });
  await pool.spawn("一");
  await settle();
  assert.match((await pool.send("sess_1", "再来")) ?? "", /is running/);
  assert.match(await pool.take("sess_1"), /is running/);
  await pool.stop("sess_1");
  assert.equal(fakes[0]?.interrupted, 1);
  assert.deepEqual(fakes[0]?.runs, ["一"]);
});

test("决策 483：子 agent 的审批挂着时这一轮跑完、几条一起挂着、接着发话，卡片都还标着等待回应", async () => {
  const { pool, fakes } = harness();
  await pool.spawn("一");
  await settle();
  const first = fakes[0]?.hooks.waiting("general-1: edit_file a.ts");
  const second = fakes[0]?.hooks.waiting("explore-1: run_command ls");
  fakes[0]?.finish("派出去了");
  await settle();
  assert.equal(pool.list()[0]?.state, "waiting", "跑完不清掉");
  first?.();
  assert.equal(pool.list()[0]?.state, "waiting", "还有一条挂着");
  assert.equal(pool.list()[0]?.waiting, "explore-1: run_command ls");
  await pool.stop("sess_1");
  assert.equal(await pool.send("sess_1", "接着来"), undefined);
  assert.equal(pool.list()[0]?.state, "waiting", "发话不清掉");
  second?.();
  assert.equal(pool.list()[0]?.state, "running");
  second?.();
  assert.equal(pool.list()[0]?.state, "running", "落定两次只算一次");
});

test("决策 483：停下后中断的这一轮晚些落定（其间子 agent 来了审批）：仍是已停，不被叫醒", async () => {
  const { pool, fakes } = harness({ lateInterrupt: true });
  await pool.spawn("一");
  await settle();
  await pool.stop("sess_1");
  const settled = fakes[0]?.hooks.waiting("general-1: edit_file a.ts");
  fakes[0]?.finish("（中断）");
  await settle();
  settled?.();
  assert.equal(pool.list()[0]?.state, "stopped");
  fakes[0]?.hooks.wake();
  assert.equal(fakes[0]?.noticeRuns, 0);
  await pool.stop("sess_1");
  assert.equal(fakes[0]?.interrupted, 1, "已停下的再停不再中断");
});

test("去掉：开着的、还在开的都释放；关掉时等还在释放的；停下的关掉时照样释放", async () => {
  let release: (() => void) | undefined;
  const { pool, fakes } = harness({
    openGate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  });
  const card = await pool.spawn("一");
  const removing = pool.remove(card.id);
  assert.equal(pool.list().length, 0);
  const closing = pool.closeAll();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await settle();
  assert.equal(closed, false, "关掉在等去掉中的会话释放");
  release?.();
  await removing;
  assert.deepEqual(await closing, []);
  assert.equal(fakes[0]?.closed, true);
  assert.deepEqual(fakes[0]?.runs, [], "去掉的不开跑");

  const later = harness();
  await later.pool.spawn("二");
  await settle();
  await later.pool.stop("sess_1");
  assert.deepEqual(await later.pool.closeAll(), []);
  assert.equal(later.fakes[0]?.closed, true);
});

function standalone(id: string) {
  const transcript: Array<Record<string, unknown>> = [];
  const runs: string[] = [];
  const finishers: Array<() => void> = [];
  let hooks: PooledHooks | undefined;
  let running = false;
  const runtime: PooledRuntime = {
    sessionId: id,
    run: (text) => {
      runs.push(text);
      running = true;
      return new Promise<void>((resolve) => {
        finishers.push(() => {
          transcript.push({ role: "assistant", content: `done ${text}` });
          running = false;
          resolve();
        });
      });
    },
    interrupt: () => {},
    isRunning: () => running,
    transcript: () => transcript,
    close: async () => {},
    attachHooks: (given) => {
      hooks = given;
    },
  };
  return { runtime, runs, finishers, hooks: () => hooks };
}

test("决策 484：收进开着的会话：带上在跑的这一轮，跑完逐条发排着的输入；接上面板的钩子", async () => {
  const pool = new LocalSessionPool({ open: async () => standalone("unused").runtime });
  const session = standalone("sess_main");
  let finishFirst: (() => void) | undefined;
  const inflight = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const card = pool.adopt(
    session.runtime,
    { name: "main", task: "做一" },
    { inflight, queued: ["做二", "做三"] }
  );
  assert.equal(card.id, "sess_main");
  assert.equal(pool.list()[0]?.state, "running");
  assert.ok(session.hooks() !== undefined, "接上了面板的钩子");
  finishFirst?.();
  await settle();
  assert.deepEqual(session.runs, ["做二"]);
  session.finishers[0]?.();
  await settle();
  assert.deepEqual(session.runs, ["做二", "做三"]);
  session.finishers[1]?.();
  await settle();
  assert.equal(pool.list()[0]?.state, "idle");
  assert.equal(pool.list()[0]?.summary, "done 做三");
});

test("决策 484：取出交回在跑的这一轮与排着的输入，卡片不再列着、钩子不再改它；还在开的、已释放的取不出", async () => {
  const pool = new LocalSessionPool({ open: async () => standalone("unused").runtime });
  const session = standalone("sess_a");
  let finish: (() => void) | undefined;
  const inflight = new Promise<void>((resolve) => {
    finish = resolve;
  });
  pool.adopt(session.runtime, { name: "a", task: "一" }, { inflight, queued: ["二"] });
  const settled = session.hooks()?.waiting("edit_file a.ts");
  const out = pool.detach("sess_a");
  assert.equal(out?.inflight, inflight);
  assert.deepEqual(out?.queued, ["二"]);
  assert.equal(pool.list().length, 0);
  settled?.();
  finish?.();
  await settle();
  assert.equal(pool.list().length, 0, "落定不再把卡片放回");
  assert.deepEqual(session.runs, [], "排着的交出去了，面板不再发");
  assert.equal(pool.detach("sess_a"), undefined);
  assert.equal(pool.detach("no_such"), undefined);
});

test("决策 484：空闲时做事——空闲的马上做，在跑的这一轮跑完后做（先于排着的下一条）；不在的会话返回 false", async () => {
  const pool = new LocalSessionPool({ open: async () => standalone("unused").runtime });
  const session = standalone("sess_b");
  pool.adopt(session.runtime, { name: "b", task: "一" });
  const done: string[] = [];
  assert.equal(
    pool.whenIdle("sess_b", () => done.push("now")),
    true
  );
  assert.deepEqual(done, ["now"]);
  assert.equal(await pool.send("sess_b", "二"), undefined);
  pool.whenIdle("sess_b", () => done.push(`after ${session.runs.length}`));
  assert.deepEqual(done, ["now"]);
  session.finishers[0]?.();
  await settle();
  assert.deepEqual(done, ["now", "after 1"]);
  assert.equal(
    pool.whenIdle("no_such", () => done.push("never")),
    false
  );
  assert.deepEqual(
    pool.runtimes().map((runtime) => runtime.sessionId),
    ["sess_b"]
  );
});

test("决策 485：去掉还在开的会话，开完关掉时说明是去掉（删出清单、清理工作树）", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closes: Array<{ removed?: boolean } | undefined> = [];
  const pool = new LocalSessionPool({
    open: async () => {
      await gate;
      return {
        sessionId: "sess_r",
        run: async () => {},
        interrupt: () => {},
        isRunning: () => false,
        transcript: () => [],
        close: async (options) => {
          closes.push(options);
        },
      };
    },
  });
  const card = await pool.spawn("一");
  const removing = pool.remove(card.id);
  release?.();
  await removing;
  await settle();
  assert.deepEqual(closes, [{ removed: true }]);
});
