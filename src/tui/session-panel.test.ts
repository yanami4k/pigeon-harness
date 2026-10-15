// 决策 443：会话面板（终端界面，会话池用进程内实现加替身运行面）。/panel 打开整屏面板，按状态分组、等待回应在前；
// 底部输入框派新会话；空格偷看、偷看时输入发给选中的会话；空输入回车进入会话（决策 484：它成为当前会话，原来的当前会话
// 退到面板），Esc 关面板；Ctrl+X 第一下停下、两秒内再按去掉（483）；面板里的斜杠命令作用于当前会话；卡片文字经 036 净化；
// /take <名字> 取回会话工作树的改动。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { LocalSessionPool, type PooledRuntime } from "../application/session-pool.ts";
import type { StreamTextDelta } from "../pi-runtime/adapter.ts";
import type { EventEnvelope } from "../state/events.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { MessageFlow, projectRuntimeEvent } from "./message-flow.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { SessionPanel } from "./session-panel.ts";
import { PigeonTuiShell, type TuiPoolFace, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

test("面板会话的实时消息区没有收尾行：轮内出错照样写一行原因（只取首行）；主会话的投影不写（由收尾行写）", () => {
  const turnFailed = {
    kind: RuntimeEventKind.TurnCompleted,
    payload: {
      stopReason: "error",
      syntheticFailure: true,
      errorMessage: "503 upstream down\nmore",
    },
  } as unknown as EventEnvelope;
  const pooled = new MessageFlow();
  projectRuntimeEvent(pooled, turnFailed, { turnErrors: true });
  assert.ok(pooled.view.render(80).join("\n").includes("error · 503 upstream down"));
  assert.ok(!pooled.view.render(80).join("\n").includes("more"));
  const main = new MessageFlow();
  projectRuntimeEvent(main, turnFailed);
  assert.ok(!main.view.render(80).join("\n").includes("503"));
});

interface Live {
  subscribe(listener: (event: never) => void): () => void;
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void;
}

function makeShell(extra: Partial<TuiShellOptions> = {}, rows = 40) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-panel-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(110, rows);
  const runtime = new ScriptedRuntime(sessionId);
  const runs: string[] = [];
  const finishers: Array<(reply: string) => void> = [];
  const streams: Array<(delta: StreamTextDelta) => void> = [];
  const stopped: string[] = [];
  const taken: string[] = [];
  let seq = 0;
  const pool = new LocalSessionPool<Live>({
    open: async ({ name }) => {
      seq += 1;
      const id = `sess_pool${seq}`;
      const transcript: Array<{ role: string; content: string }> = [];
      let pending: (() => void) | undefined;
      const handle: PooledRuntime<Live> = {
        sessionId: id,
        run: (text) => {
          runs.push(`${name}:${text}`);
          transcript.push({ role: "user", content: text });
          return new Promise<void>((resolve) => {
            pending = resolve;
            finishers.push((reply) => {
              transcript.push({ role: "assistant", content: reply });
              pending = undefined;
              resolve();
            });
          });
        },
        interrupt: () => {
          const current = pending;
          pending = undefined;
          current?.();
        },
        isRunning: () => pending !== undefined,
        transcript: () => transcript,
        close: async () => {
          stopped.push(name);
        },
        live: {
          subscribe: () => () => {},
          subscribeStream: (listener) => {
            streams.push(listener);
            return () => {
              streams.splice(streams.indexOf(listener), 1);
            };
          },
        },
        take: () => {
          taken.push(name);
          return `已取回 ${name} 的改动`;
        },
      };
      return handle;
    },
  });
  // 决策 484：进入即换手——装配方（main.ts）的做法：从面板取出、壳交出当前这一轮、换到它；这里原来的当前会话不收进面板
  const entered: string[] = [];
  const holder: { shell?: PigeonTuiShell } = {};
  const face: TuiPoolFace = {
    source: pool,
    enter: async (id) => {
      const shell = holder.shell;
      const out = pool.detach(id);
      if (shell === undefined || out === undefined) return "can't open";
      entered.push(id);
      shell.handOff();
      shell.switchSession(
        id as SessionId,
        { runtime: new ScriptedRuntime(id as SessionId) },
        {
          ...(out.inflight !== undefined ? { inflight: out.inflight } : {}),
          ...(out.queued !== undefined ? { queued: out.queued } : {}),
        }
      );
      return undefined;
    },
  };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    pool: face,
    resume: {
      root: logDir,
      rebind: () => {
        throw new Error("不该换过去");
      },
    },
    ...extra,
  });
  holder.shell = shell;
  shell.start();
  return {
    shell,
    term,
    runtime,
    pool,
    entered,
    runs,
    finishers,
    streams,
    stopped,
    taken,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

const ESC = "\x1b";
const CTRL_X = "\x18";

test("/panel 打开面板；输入框里的话派新会话；按状态分组，等待回应在前；卡片文字经净化", async () => {
  const { term, runs, finishers, pool, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /== sessions panel/);
    term.input("修登录");
    term.input("\r");
    await settle();
    term.input(`查 ${ESC}[2J 日志`);
    term.input("\r");
    await settle();
    assert.deepEqual(runs, ["s1:修登录", `s2:查 ${ESC}[2J 日志`]);
    finishers[0]?.("登录修好了");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /running \(1\)/);
    assert.match(screen, /idle \(1\)/);
    assert.match(screen, /s1 {2}修登录 {2}\| 登录修好了/);
    assert.ok(screen.indexOf("running (1)") < screen.indexOf("idle (1)"));
    assert.ok(!term.writes.join("").includes(`${ESC}[2J 日志`), "卡片里的控制序列不写进终端");
    assert.equal(pool.list().length, 2);
  } finally {
    cleanup();
  }
});

test("空格偷看，偷看时输入发给选中的会话；决策 484：空输入回车进入会话即换成当前会话（接过它在跑的这一轮），Esc 关面板", async () => {
  const { shell, term, pool, entered, runs, finishers, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("一");
    term.input("\r");
    await settle();
    finishers[0]?.("一做完了");
    await settle();
    term.input(" ");
    await settle();
    assert.match(screenText(term), /-- peek --/);
    assert.match(screenText(term), /一做完了/);
    term.input("接着做二");
    term.input("\r");
    await settle();
    assert.deepEqual(runs, ["s1:一", "s1:接着做二"]);
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /-- peek --/);
    term.input("\r");
    await settle();
    assert.deepEqual(entered, ["sess_pool1"]);
    assert.equal(shell.currentView(), "main");
    assert.equal(shell.sessionId(), "sess_pool1");
    assert.equal(shell.isRunning(), true, "接过它在跑的这一轮");
    assert.ok(
      pool.list().every((card) => card.id !== "sess_pool1"),
      "成了当前会话，不再是面板里的会话"
    );
    finishers[1]?.("二也做完了");
    await settle();
    assert.equal(shell.isRunning(), false, "这一轮跑完，当前会话空闲");
    term.input("/panel");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /== sessions panel/);
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== sessions panel/);
  } finally {
    cleanup();
  }
});

test("决策 483：Ctrl+X 第一下停下选中的会话（运行面不释放），两秒内再按一下从面板去掉并释放；决策 484：面板里的斜杠命令回到主视图作用于当前会话；/take <名字> 取回", async () => {
  const { shell, term, stopped, finishers, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("一");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    await settle();
    assert.deepEqual(stopped, [], "第一下只停这一轮，不释放");
    assert.match(screenText(term), /stopped \(1\)/);
    assert.doesNotMatch(screenText(term), /press Ctrl\+X again/);
    term.input("/tasks");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.match(screenText(term), /> \/tasks/);
    finishers.length = 0;
    term.input("/take s1");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /已取回 s1 的改动/);
    // 再进面板，连按两下：第二下从面板去掉并释放
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    term.input(CTRL_X);
    await settle();
    assert.deepEqual(stopped, ["s1"]);
    assert.doesNotMatch(screenText(term), /stopped \(1\)/);
  } finally {
    cleanup();
  }
});

test("面板里审批块照样显示并写明来源；审批挂着时按键归审批，字母不进输入框", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    let decided: unknown;
    void shell
      .askApproval({
        toolName: "run_command",
        toolCallId: "c1",
        args: { command: "npm test" },
        sessionId: "sess_pool9" as never,
        pooled: { name: "s9" },
      })
      .then((result) => {
        decided = result;
      });
    await settle();
    const screen = screenText(term);
    assert.match(screen, /== sessions panel/);
    assert.match(screen, /source: session s9/);
    term.input("y");
    await settle();
    assert.deepEqual(decided, { key: "y" });
    assert.doesNotMatch(screenText(term), /> y\b/);
  } finally {
    cleanup();
  }
});

test("矮窗口里面板来了很高的审批块：按 r 写理由时输入框仍在屏幕上（审批框照常可压缩，输入框不压缩）", async () => {
  const { shell, term, cleanup } = makeShell({}, 24);
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    let decided: unknown;
    void shell
      .askApproval({
        toolName: "write_file",
        toolCallId: "c2",
        args: { path: "big.txt", content: "x".repeat(3000) },
        diffPreview: Array.from({ length: 60 }, (_, index) => `+line ${index}`).join("\n"),
        sessionId: "sess_pool9" as never,
        pooled: { name: "s9" },
      })
      .then((result) => {
        decided = result;
      });
    await settle();
    term.input("r");
    await settle();
    term.input("REASON-TYPED-HERE");
    await settle();
    assert.ok(screenText(term).includes("REASON-TYPED-HERE"), screenText(term));
    term.input("\r");
    await settle();
    assert.deepEqual(decided, { key: "r", reason: "REASON-TYPED-HERE" });
  } finally {
    cleanup();
  }
});

test("面板里退回排队的键不动主会话排队的内容", async () => {
  const { term, runtime, cleanup } = makeShell();
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("跑");
    term.input("\r");
    await settle();
    term.input("排队的一条");
    term.input("\r");
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("\x1bq");
    await settle();
    assert.doesNotMatch(screenText(term), /排队的一条/);
    term.input(ESC);
    await settle();
    runtime.finishAll();
    await settle();
    assert.deepEqual(runtime.runs, ["跑", "排队的一条"]);
  } finally {
    cleanup();
  }
});

test("/resume 不能换到面板里还开着的会话", async () => {
  const { term, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("一");
    term.input("\r");
    await settle();
    term.input(ESC);
    await settle();
    term.input("/resume sess_pool1");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /session sess_pool1 is open in the session panel/);
  } finally {
    cleanup();
  }
});

test("决策 458：当前会话是面板的第一张卡（标 current、状态写在卡里），空状态那句不出现；偷看看它最近的对话，偷看时输入发给它；/take 它的名字说明不用取回", async () => {
  const { term, runtime, cleanup } = makeShell({ sessionName: () => "demo-main" });
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("先做一件");
    term.input("\r");
    await settle();
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emitDelta("text", "主会话的回复");
    runtime.finishAll();
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    let screen = screenText(term);
    assert.match(screen, /^\s+current$/m);
    assert.match(screen, /> {3}demo-main current · idle {2}先做一件 {2}\| 主会话的回复/);
    assert.doesNotMatch(screen, /\(no sessions\)/);
    assert.match(screen, /panel: 1 session(?!s)/);
    // 偷看：最近的对话
    term.input(" ");
    await settle();
    screen = screenText(term);
    assert.match(screen, /-- peek --/);
    assert.match(screen, /> 先做一件/);
    // 偷看时输入框里的话发给主会话（空闲即发）
    runtime.autoResolve = false;
    term.input("再做一件");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["先做一件", "再做一件"]);
    assert.match(screenText(term), /demo-main current · running/);
    // 在跑时再发：排队，这一轮跑完后发出
    term.input("排队的一条");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["先做一件", "再做一件"]);
    assert.match(screenText(term), / queued/);
    runtime.finishAll();
    await settle();
    assert.deepEqual(runtime.runs, ["先做一件", "再做一件", "排队的一条"]);
    runtime.finishAll();
    await settle();
    // /take 当前会话的名字：说明不用取回
    term.input(ESC);
    await settle();
    term.input(ESC);
    await settle();
    term.input("/take demo-main");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /demo-main is the current session; nothing to take/);
  } finally {
    cleanup();
  }
});

test("决策 458：在面板里对当前会话按两次 Ctrl+X 是中断它这一轮（不退出），没在跑时说明；空输入回车回到主视图；它自己的审批挂着时卡片写等待回应", async () => {
  const { shell, term, runtime, cleanup } = makeShell({ sessionName: () => "demo-main" });
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    await settle();
    assert.match(screenText(term), /demo-main is not running/);
    // 跑起来再停：两次 Ctrl+X 中断这一轮
    term.input(ESC);
    await settle();
    runtime.autoResolve = false;
    term.input("跑一件");
    term.input("\r");
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    await settle();
    assert.match(screenText(term), /press Ctrl\+X again to interrupt demo-main/);
    // 真实运行面的中断等这一轮停下才返回：这里挂起来，看中断途中的卡片
    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
    const interrupt = runtime.interrupt.bind(runtime);
    runtime.interrupt = () => interrupt().then(() => stopped);
    term.input(CTRL_X);
    await settle();
    assert.equal(runtime.interrupts, 1);
    assert.equal(shell.currentView(), "panel", "没有退出程序，也没离开面板");
    // 已请求中断、这一轮还没停下：卡片写 cancelling，"再按一次"的提示不留着
    assert.doesNotMatch(screenText(term), /press Ctrl\+X again/);
    assert.match(screenText(term), /demo-main current · cancelling/);
    stop();
    runtime.finishAll();
    await settle();
    // 主会话自己的审批挂着：卡片写等待回应与在等什么
    void shell.askApproval({
      toolName: "run_command",
      toolCallId: "m1",
      args: { command: "npm test" },
    });
    await settle();
    assert.match(
      screenText(term),
      /demo-main current · waiting {2}跑一件 {2}\| waiting: run_command/
    );
    term.input("y");
    await settle();
    // 空输入回车：回到主视图
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
  } finally {
    cleanup();
  }
});

test("决策 458 复查：偷看当前会话后回车回主视图，再开面板时从不偷看开始，输入框里的话照常派新会话", async () => {
  const { term, runtime, runs, cleanup } = makeShell({ sessionName: () => "demo-main" });
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(" ");
    await settle();
    term.input("\r");
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("新的独立任务");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, []);
    assert.deepEqual(runs, ["s1:新的独立任务"]);
  } finally {
    cleanup();
  }
});

test("决策 458 复查：在面板里中断主会话时，排队的话不退进面板的输入框，回到主视图时放进输入框", async () => {
  const { term, runtime, runs, cleanup } = makeShell({ sessionName: () => "demo-main" });
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("长任务");
    term.input("\r");
    await settle();
    term.input("排队一条");
    term.input("\r");
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    term.input(CTRL_X);
    await settle();
    assert.equal(runtime.interrupts, 1);
    runtime.finishAll();
    await settle();
    // 面板的输入框是空的：回车不会把排队的话当新任务派出去
    term.input("\r");
    await settle();
    assert.deepEqual(runs, []);
    assert.deepEqual(runtime.runs, ["长任务"]);
    term.input(ESC);
    await settle();
    assert.match(screenText(term), /排队一条/);
  } finally {
    cleanup();
  }
});

test("决策 458 复查：对当前会话的两次 Ctrl+X 须落在同一次工作上——中间换了一次工作即重新要求确认", async () => {
  let clock = 1_000_000;
  const { term, runtime, cleanup } = makeShell({
    sessionName: () => "demo-main",
    now: () => clock,
  });
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("第一件");
    term.input("\r");
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    await settle();
    runtime.finishAll();
    await settle();
    // 偷看着发出下一件（新的一次工作），再按一次 Ctrl+X：不中断，重新要求确认
    clock += 10;
    term.input(" ");
    term.input("第二件");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    await settle();
    assert.equal(runtime.interrupts, 0);
    assert.match(screenText(term), /press Ctrl\+X again to interrupt demo-main/);
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
});

test("决策 458 复查：/resume 换到别的会话后，当前会话卡的首条输入与偷看从新会话重新记", async () => {
  const { shell, term, cleanup } = makeShell({ sessionName: (id) => id.slice(-4) });
  try {
    await settle();
    term.input("A 的第一句");
    term.input("\r");
    await settle();
    shell.rebindSession(newSessionId(), { runtime: new ScriptedRuntime(newSessionId()) });
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    const card = screenText(term)
      .split("\n")
      .find((line) => line.includes("current"));
    assert.ok(card !== undefined && !card.includes("A 的第一句"), card);
  } finally {
    cleanup();
  }
});

test("决策 458 复查：当前会话与面板会话同名时，派出的同名会话选中的是它自己；/take <名字> 取那个面板会话", async () => {
  const { term, runtime, runs, finishers, taken, cleanup } = makeShell({
    sessionName: () => "s1",
  });
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("面板里的任务");
    term.input("\r");
    await settle();
    // 面板会话跑完这一轮、空闲下来才收下一句
    finishers[0]?.("做完了");
    await settle();
    term.input(" ");
    term.input("给 s1 的回复");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, [], "没有发给同名的当前会话");
    assert.deepEqual(runs, ["s1:面板里的任务", "s1:给 s1 的回复"]);
    finishers[1]?.("也做完了");
    await settle();
    term.input(ESC);
    await settle();
    term.input(ESC);
    await settle();
    term.input("/take s1");
    term.input("\r");
    await settle();
    assert.deepEqual(taken, ["s1"]);
  } finally {
    cleanup();
  }
});

test("决策 458 复查：准备中的会话开好、会话号换了之后，选中仍是它（按名字找回），不跳回当前会话", () => {
  let cards = [
    {
      id: "pending:s1",
      name: "s1",
      state: "preparing" as const,
      task: "t",
      summary: "",
      startedAt: 0,
      updatedAt: 0,
    },
  ];
  const main = {
    id: "sess_main",
    name: "demo-main",
    state: "idle" as const,
    task: "",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
  };
  const panel = new SessionPanel({
    height: () => 20,
    cards: () => cards,
    peek: () => [],
    main: () => main,
  });
  panel.move(1);
  assert.equal(panel.selected()?.id, "pending:s1");
  cards = [{ ...cards[0], id: "sess_real_s1", state: "running" as const } as never];
  assert.equal(panel.selected()?.id, "sess_real_s1");
});

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

test("决策 470：输入框为空时按两下 ← 打开面板并选中当前会话（第一下只在状态行提示）；输入框有字时 ← 照旧移光标", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    term.input(LEFT);
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.match(screenText(term), /press Left again to open the panel/);
    term.input(LEFT);
    await settle();
    assert.equal(shell.currentView(), "panel");
    assert.match(screenText(term), /^ > {3}\S+ current/m);
    term.input(ESC);
    await settle();
    // 有字：← 移光标，不开面板也不提示
    term.input("ab");
    term.input(LEFT);
    term.input(LEFT);
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.doesNotMatch(screenText(term), /press Left again/);
    term.input("X");
    await settle();
    assert.match(screenText(term), /Xab/);
  } finally {
    cleanup();
  }
});

test("决策 470：第一下之后按别的键即撤掉；设置关掉时 ← 不开面板", async () => {
  let enabled = true;
  const { shell, term, cleanup } = makeShell({ leftArrowOpensPanel: () => enabled });
  try {
    await settle();
    term.input(LEFT);
    term.input("\x1b[B");
    term.input(LEFT);
    await settle();
    assert.equal(shell.currentView(), "main", "中间按了别的键，第二下只算新的第一下");
    enabled = false;
    term.input(LEFT);
    term.input(LEFT);
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.doesNotMatch(screenText(term), /press Left again/);
  } finally {
    cleanup();
  }
});

test("决策 470、484：面板里 → 进入选中的会话（成为当前会话）；输入框为空按两下 ← 回面板并选中它", async () => {
  const { shell, term, finishers, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("修登录");
    term.input("\r");
    await settle();
    finishers[0]?.("好了");
    await settle();
    // 光标在新派出的 s1 上：→ 进入
    term.input(RIGHT);
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.equal(shell.sessionId(), "sess_pool1");
    term.input(LEFT);
    term.input(LEFT);
    await settle();
    assert.equal(shell.currentView(), "panel");
    assert.match(screenText(term), /^ > {3}sess_pool1 current/m);
  } finally {
    cleanup();
  }
});
