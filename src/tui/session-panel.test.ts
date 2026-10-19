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
import { SessionPanel, sessionCardText } from "./session-panel.ts";
import { PigeonTuiShell, type TuiPoolFace, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle, withoutStyles } from "./testing.ts";

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
        // 决策 490：/take 只列"现在能取"的（在工作树里干活的），替身也给一个工作树
        worktree: { path: `/tmp/pigeon-pool/${id}`, branch: `pigeon/${id}` },
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

test("决策 502：面板里去掉首尾空白后少于 3 个字不派新会话，字留在输入框、提示行写明；偷看时发话不受限", async () => {
  const { shell, term, runs, finishers, cleanup } = makeShell();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    for (const text of ["ab", "  修好  "]) {
      term.input("\x15");
      term.input(text);
      term.input("\r");
      await settle();
      assert.deepEqual(runs, [], `${JSON.stringify(text)} 不派`);
      assert.equal(shell.inputText(), text.trim(), "字留在输入框");
      assert.match(screenText(term), /too short to start a session/);
    }
    term.input("\x15");
    term.input("修登录");
    term.input("\r");
    await settle();
    assert.deepEqual(runs, ["s1:修登录"], "中文三个字即可");
    finishers[0]?.("修好了");
    await settle();
    term.input(" ");
    await settle();
    term.input("好");
    term.input("\r");
    await settle();
    assert.deepEqual(runs, ["s1:修登录", "s1:好"], "偷看时发给它的话照旧，不看长短");
  } finally {
    cleanup();
  }
});

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
    // 决策 489：当前会话也落在自己的状态组里（这一条里它是闲着的），不再单占一段
    assert.match(screen, /idle \(2\)/);
    // 决策 489：卡上写它干活的目录（这里是替身给的工作树路径）
    assert.match(screen, /s1 \S*pigeon-pool\S* +修登录 +\| 登录修好了/);
    assert.ok(screen.indexOf("running (1)") < screen.indexOf("idle (2)"));
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
    term.input("任务一");
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
    assert.deepEqual(runs, ["s1:任务一", "s1:接着做二"]);
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
    term.input("任务一");
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
    term.input("/take sess_pool1");
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

test("决策 509：会话面板里不显示审批——按键照常（字母进输入框），所属会话的卡片标等待回应；回到主视图才显示、照常能答", async () => {
  const { shell, term, cleanup } = makeShell({ sessionName: () => "demo-main" });
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
        sessionId: shell.sessionId(),
      })
      .then((result) => {
        decided = result;
      });
    await settle();
    const screen = screenText(term);
    assert.match(screen, /== sessions panel/);
    assert.doesNotMatch(screen, /approve once/);
    assert.match(screen, /demo-main current .*waiting: run_command/);
    term.input("y");
    await settle();
    assert.equal(decided, undefined, "面板里 y 不回答审批");
    assert.equal(shell.inputText(), "y", "字母照常进输入框");
    term.input("\x15");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.match(screenText(term), /npm test/);
    term.input("y");
    await settle();
    assert.deepEqual(decided, { key: "y" });
  } finally {
    cleanup();
  }
});

test("矮窗口里来了很高的审批块：按 r 写理由时输入框仍在屏幕上（审批框照常可压缩，输入框不压缩）", async () => {
  const { shell, term, cleanup } = makeShell({}, 24);
  try {
    await settle();
    let decided: unknown;
    void shell
      .askApproval({
        toolName: "write_file",
        toolCallId: "c2",
        args: { path: "big.txt", content: "x".repeat(3000) },
        diffPreview: Array.from({ length: 60 }, (_, index) => `+line ${index}`).join("\n"),
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
    term.input("任务一");
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
  const { shell, term, runtime, cleanup } = makeShell({ sessionName: () => "demo-main" });
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
    // 决策 489：当前会话按状态落在组里，卡上带 current 标签（不再单占一段、不再写状态词）
    assert.match(screen, /> demo-main current {2}先做一件 {2}\| 主会话的回复/);
    assert.match(screen, /^\s+idle \(1\)$/m);
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
    assert.match(screenText(term), /^\s+running \(1\)$/m);
    assert.match(screenText(term), /demo-main current/);
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
    term.input(`/take ${shell.sessionId()}`);
    term.input("\r");
    await settle();
    assert.match(screenText(term), /is the current session; nothing to take/);
  } finally {
    cleanup();
  }
});

test("决策 507：面板里对当前会话 Ctrl+X 第一下——在跑即中断这一轮（不退出），没在跑不做事；空输入回车回到主视图；它自己的审批挂着时卡片写等待回应", async () => {
  const { shell, term, runtime, cleanup } = makeShell({ sessionName: () => "demo-main" });
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    await settle();
    assert.equal(runtime.interrupts, 0, "没在跑：不做事");
    assert.equal(shell.currentView(), "panel");
    assert.match(screenText(term), /demo-main current/, "还在面板里");
    // 等过两秒的确认窗口再来（不算第二下）
    term.input(ESC);
    await settle(2100);
    runtime.autoResolve = false;
    term.input("跑一件");
    term.input("\r");
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    // 真实运行面的中断等这一轮停下才返回：这里挂起来，看中断途中的卡片
    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
    const interrupt = runtime.interrupt.bind(runtime);
    runtime.interrupt = () => interrupt().then(() => stopped);
    term.input(CTRL_X);
    await settle();
    assert.equal(runtime.interrupts, 1, "在跑：第一下即中断这一轮");
    assert.equal(shell.currentView(), "panel", "没有退出程序，也没离开面板");
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
    assert.match(screenText(term), /^\s+waiting \(1\)$/m);
    assert.match(screenText(term), /demo-main current {2}跑一件 {2}\| waiting: run_command/);
    // 空输入回车：回到主视图（决策 509：审批在主视图里答）
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "main");
    term.input("y");
    await settle();
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

test("决策 507：当前会话两秒内第二下 Ctrl+X 从面板去掉——留在面板，下一个会话成为当前会话、光标停在它上面；原来的删出面板与工作清单", async () => {
  const { shell, term, pool, entered, finishers, cleanup } = makeShell({
    sessionName: () => "demo-main",
  });
  const removed: string[] = [];
  const remove = pool.remove.bind(pool);
  pool.remove = async (id) => {
    removed.push(id);
    await remove(id);
  };
  try {
    await settle();
    const before = shell.sessionId();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("修登录");
    term.input("\r");
    await settle();
    finishers[0]?.("好了");
    await settle();
    // 光标回到当前会话那张卡
    shell.openPanel(before);
    await settle();
    term.input(CTRL_X);
    term.input(CTRL_X);
    await settle();
    assert.deepEqual(entered, ["sess_pool1"], "下一个会话成为当前会话");
    assert.equal(shell.sessionId(), "sess_pool1");
    assert.equal(shell.currentView(), "panel", "留在面板，不进入它的视图");
    assert.match(screenText(term), /> \S+ current/, "光标停在新的当前会话上");
    assert.deepEqual(removed, [before], "原来的当前会话删出面板与工作清单");
  } finally {
    cleanup();
  }
});

test("决策 507：下一个会话进不去（停下了等）——改开一个新的空会话，再去掉原来的", async () => {
  const requests: unknown[] = [];
  const fresh = newSessionId();
  const { shell, term, pool, finishers, cleanup } = makeShell({
    sessionName: () => "demo-main",
    newSession: {
      create: async (request) => {
        requests.push(request);
        return { sessionId: fresh, binding: { runtime: new ScriptedRuntime(fresh) } };
      },
    },
  });
  const removed: string[] = [];
  const remove = pool.remove.bind(pool);
  pool.remove = async (id) => {
    removed.push(id);
    await remove(id);
  };
  try {
    await settle();
    const before = shell.sessionId();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("修登录");
    term.input("\r");
    await settle();
    finishers[0]?.("好了");
    await settle();
    // 让面板里那个会话进不去：从池子里取走
    pool.detach("sess_pool1");
    shell.openPanel(before);
    await settle();
    term.input(CTRL_X);
    term.input(CTRL_X);
    await settle();
    assert.deepEqual(requests, [{ kind: "new" }]);
    assert.equal(shell.sessionId(), fresh);
    assert.deepEqual(removed, [before]);
    assert.equal(shell.currentView(), "panel", "仍留在面板");
    assert.match(screenText(term), /> \S+ current/, "光标停在新的当前会话上");
  } finally {
    cleanup();
  }
});

test("决策 507：面板里没有别的会话时去掉当前会话——开一个新的空会话作为当前会话（同不带路径的 /new），仍留在面板", async () => {
  const requests: unknown[] = [];
  const fresh = newSessionId();
  const { shell, term, pool, cleanup } = makeShell({
    sessionName: () => "demo-main",
    newSession: {
      create: async (request) => {
        requests.push(request);
        return { sessionId: fresh, binding: { runtime: new ScriptedRuntime(fresh) } };
      },
    },
  });
  const removed: string[] = [];
  pool.remove = async (id) => {
    removed.push(id);
  };
  try {
    await settle();
    const before = shell.sessionId();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input(CTRL_X);
    term.input(CTRL_X);
    await settle();
    assert.deepEqual(requests, [{ kind: "new" }]);
    assert.equal(shell.sessionId(), fresh);
    assert.equal(shell.currentView(), "panel", "仍留在面板");
    assert.match(screenText(term), /> \S+ current/, "光标停在新的当前会话上");
    assert.deepEqual(removed, [before]);
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
    term.input("/take sess_pool1");
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
  // 决策 490：会话池记着占位号到真会话号的映射，面板按它找回（不按名字）
  const renamed = new Map<string, string>();
  const panel = new SessionPanel({
    height: () => 20,
    cards: () => cards,
    peek: () => [],
    main: () => main,
    currentId: (id) => renamed.get(id) ?? id,
  });
  // 决策 489：当前会话落在自己的状态组里（这里 idle 排在 preparing 之后），光标默认在它上面，向上移一格即选到准备中的那一个
  panel.move(-1);
  assert.equal(panel.selected()?.id, "pending:s1");
  // 开好之后显示名也换了（缺省名是目录名加尾号），照样跟得住
  cards = [
    { ...cards[0], id: "sess_real_s1", name: "myapp-e5gj", state: "running" as const } as never,
  ];
  renamed.set("pending:s1", "sess_real_s1");
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
    // 决策 489：当前会话不再单占一段，按状态落在组里，卡上只多一个 current 标签
    assert.match(screenText(term), /^ {2}> .*current/m);
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
    // 决策 489：进入的会话成了当前会话，卡上带 current 标签（状态由分组表达）
    assert.match(screenText(term), /^ {2}> sess_pool1 current/m);
  } finally {
    cleanup();
  }
});

test("决策 489：共用目录的会话在卡上写它用的工作区，不再只写 shared dir", () => {
  const base = {
    id: "sess_shared",
    name: "s1",
    state: "idle" as const,
    task: "做事",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
    sharedDir: true,
  };
  // 标签是暗色（带控制序列），比对前先剥掉样式
  assert.match(withoutStyles(sessionCardText({ ...base, workspace: "~" })), /s1 ~/);
  assert.doesNotMatch(withoutStyles(sessionCardText({ ...base, workspace: "~" })), /shared dir/);
  // 拿不到工作区时退回旧说法
  assert.match(sessionCardText(base), /shared dir/);
  // 决策 489：每张卡都写它干活的目录；与当前会话的工作区相同则不写
  const tree = { ...base, sharedDir: false, workspace: "~/myapp/.pigeon/trees/x" };
  assert.match(withoutStyles(sessionCardText(tree)), /s1 ~\/myapp\/\.pigeon\/trees\/x/);
  assert.doesNotMatch(
    withoutStyles(sessionCardText(tree, [], undefined, "~/myapp/.pigeon/trees/x")),
    /trees/
  );
});

test("决策 490：/take 不带参数把命令填进输入框、候选随即弹出（只列现在能取的）；Esc 收起后按 Tab 补上会话号，回车才取", async () => {
  const { term, pool, taken, finishers, cleanup } = makeShell({
    autocomplete: { basePath: process.cwd(), fdPath: null },
  });
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("干活了");
    term.input("\r");
    await settle();
    term.input("还在干");
    term.input("\r");
    await settle();
    // 第一个干完（闲着，能取），第二个还在跑（不能取）
    finishers[0]?.("干完了");
    await settle();
    term.input("\x1b");
    await settle();
    const done = pool.list().find((card) => card.state === "idle");
    const busy = pool.list().find((card) => card.state === "running");
    assert.ok(done !== undefined && busy !== undefined);
    term.input("/take");
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.doesNotMatch(screen, /press Tab/, "不再写按 Tab 的提示");
    assert.doesNotMatch(screen, /== sessions panel ==/, "不开整屏列表");
    assert.ok(screen.includes(done.id), "候选直接弹出，列着能取的会话");
    assert.ok(!screen.includes(busy.id), "在跑的不列");
    // Esc 收起候选，输入框里仍是 /take
    term.input("\x1b");
    await settle();
    assert.ok(!screenText(term).includes(done.id));
    // 按 Tab 再弹：只有一个候选时按 pi-tui 的 Tab 规矩直接补上它的全量会话号；不直接取
    term.input("\t");
    await settle();
    assert.match(screenText(term), new RegExp(`/take ${done.id}`), "Tab 补上全量会话号");
    assert.deepEqual(taken, [], "补上会话号不等于取");
    term.input("\r");
    await settle();
    assert.equal(taken.length, 1, "回车才真取");
    for (const finish of finishers.slice(1)) finish("也干完了");
    await settle();
  } finally {
    cleanup();
  }
});

// 决策 490、489：会话池记着占位号到真会话号的映射，面板跟住刚派出的那张卡（开好之后显示名也换了）；卡上的工作区与当前会话相同则不写
test("会话池换号之后面板照样选中刚派出的会话；卡上与当前会话相同的工作区不写", async () => {
  let release: (() => void) | undefined;
  const pool = new LocalSessionPool<Live>({
    displayPath: (path) => path,
    open: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      const handle: PooledRuntime<Live> = {
        sessionId: "sess_real",
        name: () => "myapp-real",
        worktree: { path: "~/t/x", branch: "pigeon/x" },
        run: async () => {},
        interrupt: () => {},
        isRunning: () => false,
        transcript: () => [],
        close: async () => {},
        live: { subscribe: () => () => {}, subscribeStream: () => () => {} },
      };
      return handle;
    },
  });
  let currentWorkspace = "~/myapp";
  // 另有一张排在前面的卡（在跑的组排在空闲之前）：映射不对时选中会落到它上面
  const other = {
    id: "sess_other",
    name: "other-1",
    state: "running" as const,
    task: "别的",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
  };
  const panel = new SessionPanel({
    height: () => 20,
    cards: () => [other, ...pool.list()],
    peek: () => [],
    currentId: (id) => pool.currentId(id),
    currentWorkspace: () => currentWorkspace,
  });
  const card = await pool.spawn("干活");
  panel.followSpawn(card.id);
  assert.equal(panel.selected()?.id, card.id);
  release?.();
  for (let i = 0; i < 50 && pool.list()[0]?.id !== "sess_real"; i += 1) await settle(10);
  assert.equal(panel.selected()?.id, "sess_real", "换号之后照样选中它");
  assert.equal(panel.selected()?.name, "myapp-real");
  const lines = () => withoutStyles(panel.render(100).join("\n"));
  assert.match(lines(), /myapp-real ~\/t\/x/);
  currentWorkspace = "~/t/x";
  assert.doesNotMatch(lines(), /~\/t\/x/, "与当前会话相同的工作区不写");
  // 去掉之后占位号的映射一并清掉；面板已记下真会话号，不靠它
  await pool.remove("sess_real");
  assert.equal(pool.currentId(card.id), card.id, "映射已清");
  await pool.closeAll();
});

// 决策 509：经真实的进入面板会话路径（handOff 交出在跑的这一轮、switchSession 换过去）

async function spawnAndFinish(term: MockTerminal, finishers: Array<(reply: string) => void>) {
  term.input("/panel");
  term.input("\r");
  await settle();
  term.input("修登录");
  term.input("\r");
  await settle();
  finishers[0]?.("好了");
  await settle();
}

test("决策 509：挂着审批、这一轮在跑时进入面板里的会话——审批留在原会话（交接在途工作），换回来照常能答", async () => {
  const { shell, term, runtime, entered, finishers, cleanup } = makeShell({
    sessionName: (id) => (id.startsWith("sess_pool") ? "s1" : "demo-main"),
  });
  try {
    await settle();
    const original = shell.sessionId();
    await spawnAndFinish(term, finishers);
    term.input(ESC);
    await settle();
    runtime.autoResolve = false;
    term.input("跑一件");
    term.input("\r");
    await settle();
    let decided: unknown;
    void shell
      .askApproval({
        toolName: "run_command",
        toolCallId: "m1",
        args: { command: "npm test" },
        sessionId: original,
      })
      .then((result) => {
        decided = result;
      });
    await settle();
    // 面板里选中 s1，回车进入（真实路径：交出在跑的这一轮，换到 s1）
    shell.openPanel("sess_pool1");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(entered, ["sess_pool1"], screenText(term));
    assert.equal(shell.sessionId(), "sess_pool1");
    assert.doesNotMatch(screenText(term), /npm test/, "审批留在原会话，不在这里显示");
    assert.equal(decided, undefined);
    // 换回原会话：审批照常显示、能答
    const handOff = shell.handOff();
    shell.switchSession(original, { runtime }, handOff);
    await settle();
    assert.match(screenText(term), /npm test/);
    term.input("y");
    await settle();
    assert.deepEqual(decided, { key: "y" });
    runtime.finishAll();
  } finally {
    cleanup();
  }
});

test("决策 509：写拒绝理由途中换到别的会话——理由作废、从输入框收掉；换回来审批还在，按 r 重写", async () => {
  const { shell, term, pool, finishers, cleanup } = makeShell({
    sessionName: (id) => (id.startsWith("sess_pool") ? "s1" : "demo-main"),
  });
  try {
    await settle();
    const original = shell.sessionId();
    const originalRuntime = new ScriptedRuntime(original);
    await spawnAndFinish(term, finishers);
    term.input("\x1b");
    await settle();
    let decided: unknown;
    void shell
      .askApproval({
        toolName: "run_command",
        toolCallId: "m2",
        args: { command: "rm -rf build" },
        sessionId: original,
      })
      .then((result) => {
        decided = result;
      });
    await settle();
    term.input("r");
    term.input("half a reason");
    await settle();
    assert.equal(shell.inputText(), "half a reason");
    // 写理由时按键都归输入区，换会话只能由程序做（进入面板里会话的同一条路：取出、交出这一轮、换过去）
    const out = pool.detach("sess_pool1");
    assert.ok(out !== undefined);
    shell.switchSession(
      "sess_pool1" as SessionId,
      { runtime: new ScriptedRuntime("sess_pool1" as SessionId) },
      shell.handOff()
    );
    await settle();
    assert.equal(shell.sessionId(), "sess_pool1");
    assert.equal(shell.inputText(), "", "理由从输入框收掉");
    assert.equal(shell.reasonMode(), false);
    // 在别的会话里回车不会拿半截理由去拒绝原会话的审批
    term.input("在 s1 里说话");
    term.input("\r");
    await settle();
    assert.equal(decided, undefined);
    shell.switchSession(original, { runtime: originalRuntime }, shell.handOff());
    await settle();
    assert.match(screenText(term), /rm -rf build/);
    term.input("r");
    term.input("redo");
    term.input("\r");
    await settle();
    assert.deepEqual(decided, { key: "r", reason: "redo" });
  } finally {
    cleanup();
  }
});

test("决策 509：面板里对当前会话 Ctrl+X 中断这一轮时撤回它挂着的审批——卡片不再停在等待回应，留一行撤回的结论", async () => {
  const { shell, term, runtime, cleanup } = makeShell({ sessionName: () => "demo-main" });
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("跑一件");
    term.input("\r");
    await settle();
    const answer = shell.askApproval({
      toolName: "run_command",
      toolCallId: "m3",
      args: { command: "npm test" },
      sessionId: shell.sessionId(),
    });
    await settle();
    term.input("\x1b[D");
    term.input("\x1b[D");
    await settle();
    assert.match(screenText(term), /demo-main current .*waiting: run_command/);
    term.input("\x18");
    const result = await answer;
    assert.equal(result.key, "cancel");
    await settle();
    assert.equal(runtime.interrupts, 1);
    assert.doesNotMatch(screenText(term), /waiting: run_command/);
    runtime.finishAll();
    await settle();
    term.input("\r");
    await settle();
    assert.match(screenText(term), /withdrawn: run_command was stopped/);
  } finally {
    cleanup();
  }
});

test("决策 509：面板里会话的偷看按壳里的审批单写明在等什么（不靠会话池记的等待）", async () => {
  const { shell, term, finishers, cleanup } = makeShell({
    sessionName: (id) => (id.startsWith("sess_pool") ? "s1" : "demo-main"),
  });
  try {
    await settle();
    await spawnAndFinish(term, finishers);
    void shell.askApproval({
      toolName: "edit_file",
      toolCallId: "p1",
      args: { path: "a.ts" },
      sessionId: "sess_pool1" as SessionId,
    });
    await settle();
    shell.openPanel("sess_pool1");
    await settle();
    term.input(" ");
    await settle();
    assert.match(screenText(term), /waiting: edit_file/);
  } finally {
    cleanup();
  }
});

test("决策 507：去掉当前会话、换上来的会话带着退回来的排队内容——留在面板时不放进面板的输入框，回到主视图才放进去", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-panel-held-"));
  const term = new MockTerminal(110, 40);
  const other = {
    id: "sess_other",
    name: "other",
    state: "idle" as const,
    task: "别的任务",
    summary: "",
    startedAt: 0,
    updatedAt: 0,
  };
  const holder: { shell?: PigeonTuiShell } = {};
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(newSessionId()),
    sessionId: newSessionId(),
    logDir,
    sessionName: (id) => (id === "sess_other" ? "other" : "demo-main"),
    pool: {
      source: {
        list: () => [other],
        subscribe: () => () => {},
        spawn: async () => {
          throw new Error("unused");
        },
        send: async () => undefined,
        stop: async () => {},
        remove: async () => {},
        peek: async () => [],
      },
      // 同装配方：交出当前这一轮，换到它，接过它退回来的排队内容
      enter: async (id) => {
        const target = holder.shell;
        if (target === undefined) return "can't open";
        target.handOff();
        target.switchSession(
          id as SessionId,
          { runtime: new ScriptedRuntime(id as SessionId) },
          { held: ["排着的那条"] }
        );
        return undefined;
      },
    },
  });
  holder.shell = shell;
  shell.start();
  try {
    await settle();
    term.input("/panel");
    term.input("\r");
    await settle();
    term.input("\x18");
    term.input("\x18");
    await settle();
    assert.equal(shell.sessionId(), "sess_other");
    assert.equal(shell.currentView(), "panel");
    assert.equal(shell.inputText(), "", "不放进面板的输入框");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.equal(shell.inputText(), "排着的那条", "回到主视图才放进去");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
