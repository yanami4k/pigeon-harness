// 决策 441：终端界面改用全屏（备用屏）。进全屏；标题在顶、输入框与状态栏固定在底，对话再长也不把它们挤走；退出时离开全屏
// 并把对话打印到普通屏幕；暂离全屏（外部编辑器）不打印；Home/End 留给输入框；F3 也能打开搜索（Windows Terminal 占用
// Ctrl+Shift+F），搜索框开着时按键交给它；拖选出选区后 Ctrl+C 复制选区、不计退出布防。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(cols = 80, rows = 20, extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-full-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(cols, rows);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, ...extra });
  return {
    shell,
    term,
    runtime,
    sessionId,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

function rows(term: MockTerminal): string[] {
  return Array.from({ length: term.rows }, (_, row) => term.screen.rowText(row));
}

test("进全屏：标题在顶、状态栏在底；对话超过一屏时最新的在、输入框与状态栏不被挤走", async () => {
  const { shell, term, runtime, cleanup } = makeShell(80, 16);
  try {
    shell.start();
    await settle();
    assert.ok(term.writes.join("").includes("\x1b[?1049h"), "进入备用屏");
    assert.ok(term.screen.alternate);
    for (let index = 0; index < 12; index += 1) {
      term.input(`第 ${index} 条`);
      term.input("\r");
      await settle(30);
    }
    await settle();
    assert.deepEqual(runtime.runs.length, 12);
    const screen = rows(term);
    // 标题在最上面（Text 自带上下各一行留白）
    assert.match(screen[1] ?? "", /== sess_\w+ ==/);
    assert.ok(
      screen.some((line) => line.includes("> 第 11 条")),
      screen.join("\n")
    );
    assert.ok(!screen.some((line) => line.includes("> 第 0 条")), "最早的滚出视口");
    assert.match(screen.join("\n"), /state: idle/);
    assert.match(screen.at(-1) ?? "", /cost \$0/);
  } finally {
    cleanup();
  }
});

test("退出：离开全屏，把对话完整打印到普通屏幕（含滚出视口的早先内容），不打印输入框与状态栏", async () => {
  const { shell, term, cleanup } = makeShell(80, 12);
  try {
    shell.start();
    await settle();
    for (let index = 0; index < 8; index += 1) {
      term.input(`消息 ${index}`);
      term.input("\r");
      await settle(30);
    }
    await settle();
    shell.stop();
    assert.equal(term.screen.alternate, false);
    const printed = term.screen.contentLines().join("\n");
    assert.match(printed, /== sess_\w+ ==/);
    assert.match(printed, /> 消息 0/);
    assert.match(printed, /> 消息 7/);
    assert.doesNotMatch(printed, /state: idle/);
    assert.doesNotMatch(printed, /cost \$0/);
  } finally {
    cleanup();
  }
});

test("暂离全屏（外部编辑器）：回到普通屏幕时不打印对话，回来后重新进全屏", async () => {
  const { shell, term, cleanup } = makeShell(80, 12);
  try {
    shell.start();
    await settle();
    term.input("先说一句");
    term.input("\r");
    await settle();
    const seen = shell.suspendFor(() => ({
      alternate: term.screen.alternate,
      main: term.screen.contentLines().join("\n"),
    }));
    assert.equal(seen.alternate, false);
    assert.doesNotMatch(seen.main, /== sess_|state: idle|先说一句/, "普通屏幕上什么都没打印");
    await settle();
    assert.equal(term.screen.alternate, true);
  } finally {
    cleanup();
  }
});

test("Home/End 留给输入框（视口回顶/底改为 Ctrl+Home/Ctrl+End）", async () => {
  const submitted: string[] = [];
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("abc");
    term.input("\x1b[H");
    term.input("X");
    term.input("\x1b[F");
    term.input("Y");
    term.input("\r");
    await settle();
    submitted.push(...runtime.runs);
    assert.deepEqual(submitted, ["XabcY"]);
  } finally {
    cleanup();
  }
});

test("F3 打开搜索：搜索框开着时按键交给它（不进输入框），Esc 关掉后输入照常", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    term.input("\x1bOR");
    await settle();
    term.input("zz");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, [], "搜索框开着时的回车不提交");
    term.input("\x1b");
    await settle();
    term.input("ok");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["ok"]);
  } finally {
    cleanup();
  }
});

test("拖选出选区后 Ctrl+C 复制选区（写出 OSC 52），不清输入、不计退出布防", async () => {
  const { shell, term, cleanup } = makeShell(80, 16);
  try {
    shell.start();
    await settle();
    term.input("draft");
    await settle();
    // 在标题行（第 2 行）上按下、拖动（SGR 鼠标序列，1 起的列与行）
    term.input("\x1b[<0;4;2M");
    term.input("\x1b[<32;20;2M");
    await settle();
    term.writes.length = 0;
    term.input("\x03");
    await settle();
    assert.ok(term.writes.join("").includes("\x1b]52;c;"), "复制走 OSC 52");
    assert.doesNotMatch(screenText(term), /\[cleared\]/);
    term.input("\x1b[<0;20;2m");
    await settle();
  } finally {
    cleanup();
  }
});

test("等模型时转圈（ASCII 帧）：一轮开始即出现，第一段输出到来即收起，跑完不留", async () => {
  const { shell, term, runtime, cleanup } = makeShell(80, 20);
  try {
    shell.start();
    await settle();
    runtime.autoResolve = false;
    term.input("问一句");
    term.input("\r");
    await settle(200);
    assert.match(screenText(term), /waiting for model/);
    assert.doesNotMatch(screenText(term), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    await settle();
    assert.match(screenText(term), /waiting for model/, "新的一轮开始仍在等");
    runtime.emitDelta("text", "答");
    await settle();
    assert.doesNotMatch(screenText(term), /waiting for model/);
    runtime.finishAll();
    await settle();
    assert.doesNotMatch(screenText(term), /waiting for model/);
  } finally {
    cleanup();
  }
});

test("运行中打开搜索：Esc 关搜索框，不取消正在跑的这一轮", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    shell.start();
    await settle();
    runtime.autoResolve = false;
    term.input("跑");
    term.input("\r");
    await settle();
    term.input("\x1bOR");
    await settle();
    term.input("\x1b");
    await settle();
    assert.equal(runtime.interrupts, 0, "Esc 归搜索框");
    // 搜索框关了之后 Esc 照常取消
    term.input("\x1b");
    await settle();
    assert.equal(runtime.interrupts, 1);
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
});
