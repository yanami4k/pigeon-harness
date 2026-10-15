// 决策 484：当前会话换手的边界——这一轮收尾（Stop 钩子）期间不换手、/resume 走同一道守卫；等 UserPromptSubmit 钩子期间换手，
// 这一轮带走的是自己的待用上下文、不碰换过去的会话的；交出去的那一轮还在等钩子时停下即不再开跑；中断后留着的排队内容随会话
// 交出、不当作排着的输入发出。会话池的独占一段（设置重读后的重建）：期间发来的话排着，做完再发；不能取出；去掉等它做完。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { HookEventReport } from "../application/hooks.ts";
import { LocalSessionPool, type PooledRuntime } from "../application/session-pool.ts";
import { newSessionId } from "../state/ids.ts";
import type { TuiHooksFace } from "./hooks-view.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function report(extra: Partial<HookEventReport> = {}): HookEventReport {
  return { runs: [], additionalContext: [], systemMessages: [], ...extra } as HookEventReport;
}

// 钩子替身：指定的事件挂着，直到放行
function gatedHooks(gated: string) {
  let release: ((value: HookEventReport) => void) | undefined;
  let waiting = 0;
  const hooks: TuiHooksFace = {
    disabled: false,
    list: () => [],
    runEvent: (event) => {
      if (event !== gated) return Promise.resolve(report());
      waiting += 1;
      return new Promise<HookEventReport>((resolve) => {
        release = resolve;
      });
    },
  };
  return {
    hooks,
    waiting: () => waiting,
    release: (value: HookEventReport = report()) => release?.(value),
  };
}

function makeShell(runtime: ScriptedRuntime, extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-handoff-"));
  const term = new MockTerminal(100, 30);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId: newSessionId(),
    logDir,
    ...extra,
  });
  shell.start();
  return {
    shell,
    term,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("这一轮收尾（Stop 钩子）期间不换手，/resume 同样不换；收尾完即可换", async () => {
  const runtime = new ScriptedRuntime(newSessionId());
  const stop = gatedHooks("Stop");
  const rebinds: string[] = [];
  const { shell, term, cleanup } = makeShell(runtime, {
    hooks: stop.hooks,
    resume: {
      root: tmpdir(),
      rebind: (id) => {
        rebinds.push(id);
        return { runtime: new ScriptedRuntime(id) };
      },
    },
  });
  try {
    await settle();
    term.input("干活");
    term.input("\r");
    await settle();
    assert.equal(stop.waiting(), 1, "Stop 钩子在跑");
    assert.equal(shell.handOffBlocked(), "can't switch sessions right now");
    term.input(`/resume ${newSessionId()}`);
    term.input("\r");
    await settle();
    assert.match(screenText(term), /can't switch sessions right now/);
    assert.deepEqual(rebinds, []);
    stop.release();
    await settle();
    assert.equal(shell.handOffBlocked(), undefined);
  } finally {
    cleanup();
  }
});

test("等 UserPromptSubmit 钩子期间换手：这一轮带自己的待用说明，换过去的会话的上下文留给它；交出去的停下即不再开跑", async () => {
  const runtimeA = new ScriptedRuntime(newSessionId());
  const prompt = gatedHooks("UserPromptSubmit");
  const { shell, term, cleanup } = makeShell(runtimeA, { hooks: prompt.hooks });
  try {
    await settle();
    shell.addNextInputNote("A 的说明");
    term.input("干活");
    term.input("\r");
    await settle();
    assert.equal(prompt.waiting(), 1);
    const handOff = shell.handOff();
    assert.ok(handOff.inflight !== undefined);
    const idB = newSessionId();
    const runtimeB = new ScriptedRuntime(idB);
    shell.switchSession(idB, { runtime: runtimeB }, { contexts: ["B 的上下文"] });
    prompt.release();
    await settle();
    assert.deepEqual(runtimeA.runs, ["A 的说明\n\n干活"]);
    // B 的上下文还在：随 B 的下一条输入带上
    term.input("B 干活");
    term.input("\r");
    await settle();
    assert.deepEqual(runtimeB.runs, ["B 的上下文\n\nB 干活"]);

    // 交出去的一轮还在等钩子：停下即不再开跑
    const idC = newSessionId();
    const runtimeC = new ScriptedRuntime(idC);
    const gate = gatedHooks("UserPromptSubmit");
    shell.switchSession(idC, { runtime: runtimeC, hooks: gate.hooks });
    term.input("C 干活");
    term.input("\r");
    await settle();
    const away = shell.handOff();
    away.interrupt?.();
    gate.release();
    await settle();
    assert.deepEqual(runtimeC.runs, [], "停下了，不再开跑");
  } finally {
    cleanup();
  }
});

test("在面板里中断当前会话时退回的排队内容随会话交出（held），不当作排着的输入", async () => {
  const runtime = new ScriptedRuntime(newSessionId());
  runtime.autoResolve = false;
  const { shell, term, cleanup } = makeShell(runtime, {
    pool: {
      source: new LocalSessionPool({
        open: async () => {
          throw new Error("unused");
        },
      }),
    },
  });
  try {
    await settle();
    term.input("长任务");
    term.input("\r");
    await settle();
    term.input("排着的话");
    term.input("\r");
    await settle();
    shell.openPanel();
    await settle();
    shell.requestInterrupt();
    await settle();
    const handOff = shell.handOff();
    assert.deepEqual(handOff.held, ["排着的话"]);
    assert.equal(handOff.queued, undefined);
  } finally {
    cleanup();
  }
});

function poolRuntime(id: string) {
  const runs: string[] = [];
  const finishers: Array<() => void> = [];
  const runtime: PooledRuntime = {
    sessionId: id,
    run: (text) => {
      runs.push(text);
      return new Promise<void>((resolve) => finishers.push(resolve));
    },
    interrupt: () => {},
    isRunning: () => false,
    transcript: () => [],
    close: async () => {},
  };
  return { runtime, runs, finishers };
}

test("会话池独占一段：期间发来的话排着做完再发，取不出、算忙；去掉等它做完", async () => {
  const pool = new LocalSessionPool({ open: async () => poolRuntime("unused").runtime });
  const session = poolRuntime("sess_x");
  pool.adopt(session.runtime, { name: "x", task: "一" });
  let finish: (() => void) | undefined;
  assert.equal(
    pool.exclusive(
      "sess_x",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    ),
    true
  );
  assert.equal(
    pool.exclusive("sess_x", async () => {}),
    false,
    "已有独占"
  );
  assert.equal(pool.busy("sess_x"), true);
  assert.equal(await pool.send("sess_x", "做二"), undefined);
  assert.deepEqual(session.runs, [], "独占期间不开跑");
  assert.equal(pool.detach("sess_x"), undefined, "取不出");
  finish?.();
  await settle();
  assert.deepEqual(session.runs, ["做二"], "做完再发");
  assert.equal(pool.busy("sess_x"), false);
  session.finishers[0]?.();
  await settle();
  let release: (() => void) | undefined;
  pool.exclusive(
    "sess_x",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  let removed = false;
  void pool.remove("sess_x").then(() => {
    removed = true;
  });
  await settle();
  assert.equal(removed, false, "去掉等独占的一段做完");
  release?.();
  await settle();
  assert.equal(removed, true);
});
