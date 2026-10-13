// 决策 443：会话面板（终端界面，会话池用进程内实现加替身运行面）。/panel 打开整屏面板，按状态分组、等待回应在前；
// 底部输入框派新会话；空格偷看、偷看时输入发给选中的会话；空输入回车进入会话（历史与实时投影），Esc 回面板、再 Esc 关面板；
// 连按两次 Ctrl+X 停止；面板里不用斜杠命令；卡片文字经 036 净化；/take <名字> 取回会话工作树的改动。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { LocalSessionPool, type PooledRuntime } from "../application/session-pool.ts";
import type { StreamTextDelta } from "../pi-runtime/adapter.ts";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiPoolFace } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

interface Live {
  subscribe(listener: (event: never) => void): () => void;
  subscribeStream(listener: (delta: StreamTextDelta) => void): () => void;
}

function makeShell() {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-panel-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(110, 40);
  const runtime = new ScriptedRuntime(sessionId);
  const runs: string[] = [];
  const finishers: Array<(reply: string) => void> = [];
  const streams: Array<(delta: StreamTextDelta) => void> = [];
  const stopped: string[] = [];
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
        interrupt: () => pending?.(),
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
        take: () => `已取回 ${name} 的改动`,
      };
      return handle;
    },
  });
  const face: TuiPoolFace = {
    source: pool,
    live: (id) => pool.runtimeOf(id)?.live as ReturnType<NonNullable<TuiPoolFace["live"]>>,
  };
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, pool: face });
  shell.start();
  return {
    shell,
    term,
    runtime,
    pool,
    runs,
    finishers,
    streams,
    stopped,
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
    assert.match(screen, /在跑（1）/);
    assert.match(screen, /空闲（1）/);
    assert.match(screen, /s1 {2}修登录 {2}\| 登录修好了/);
    assert.ok(screen.indexOf("在跑") < screen.indexOf("空闲"));
    assert.ok(!term.writes.join("").includes(`${ESC}[2J 日志`), "卡片里的控制序列不写进终端");
    assert.equal(pool.list().length, 2);
  } finally {
    cleanup();
  }
});

test("空格偷看，偷看时输入发给选中的会话；空输入回车进入会话（实时投影），Esc 回面板、再 Esc 关面板", async () => {
  const { term, runs, finishers, streams, cleanup } = makeShell();
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
    assert.match(screenText(term), /== 会话 s1/);
    assert.match(screenText(term), /session: s1 running/);
    for (const listener of streams)
      listener({ runId: "run_x" as never, kind: "text", delta: "实时的正文" });
    await settle();
    assert.match(screenText(term), /实时的正文/);
    term.input(ESC);
    await settle();
    assert.match(screenText(term), /== sessions panel/);
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== sessions panel/);
  } finally {
    cleanup();
  }
});

test("连按两次 Ctrl+X 停止选中的会话（第一次只提示）；面板里不用斜杠命令；/take <名字> 取回", async () => {
  const { term, stopped, finishers, cleanup } = makeShell();
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
    assert.match(screenText(term), /再按一次 Ctrl\+X 停止 s1/);
    assert.deepEqual(stopped, []);
    term.input(CTRL_X);
    await settle();
    assert.deepEqual(stopped, ["s1"]);
    assert.match(screenText(term), /已停（1）/);
    term.input("/config");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /会话面板里不用斜杠命令/);
    term.input("\x15");
    term.input(ESC);
    await settle();
    finishers.length = 0;
    term.input("/take s1");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /已取回 s1 的改动/);
  } finally {
    cleanup();
  }
});
