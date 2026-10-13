// 决策 446：壳的 afterTurn——一轮收尾后、空闲下来之前调用（会话移进工作树时在这里换运行面）。返回 Promise 时等它跑完才空闲，
// 期间新的输入排队、跑完再发；返回 undefined 照常同步空闲；抛错时说明一行并照常空闲；带上本轮是否被中止。
// 随下一条输入带给模型的说明（不开新的一轮）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { RunResult } from "../pi-runtime/adapter.ts";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

// 带程序通知的替身运行面：通知排着时壳在空闲下来之前叫醒 agent 再跑一轮
class NoticeRuntime extends ScriptedRuntime {
  notices: string[] = [];
  pendingNotices = (): number => this.notices.length;
  runNotices = (): Promise<RunResult> => {
    const text = this.notices.join("\n");
    this.notices = [];
    return this.run(text);
  };
}

test("决策 452：收尾后由通知自动续一轮（如换进工作树后接着做）算同一次工作：只落一行收尾，用时从发出消息算起", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-after-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const runtime = new NoticeRuntime(sessionId);
  let clock = 1_000_000;
  let calls = 0;
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    now: () => clock,
    afterTurn: () => {
      calls += 1;
      if (calls === 1) {
        clock += 5_000;
        runtime.notices.push("continue in the worktree");
      } else {
        clock += 55_000;
      }
      return undefined;
    },
  });
  try {
    shell.start();
    await settle();
    term.input("做");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["做", "continue in the worktree"]);
    const ends = screenText(term).match(/done · [0-9a-z ]+/g) ?? [];
    assert.deepEqual(
      ends.map((line) => line.trim()),
      ["done · 1m 0s"]
    );
    // 下一条人的输入：上一次工作的收尾行已在它的回显之前
    term.input("下一条");
    term.input("\r");
    await settle();
    const text = screenText(term);
    assert.ok(text.indexOf("done · 1m 0s") < text.indexOf("> 下一条"), text);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

function makeShell(afterTurn: (info: { cancelled: boolean }) => Promise<void> | undefined) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-after-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, afterTurn });
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

test("afterTurn 返回 Promise：等它跑完才空闲，期间的输入排队、跑完再发", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const { shell, term, runtime, cleanup } = makeShell(() => {
    calls += 1;
    if (calls > 1) return undefined;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  try {
    shell.start();
    await settle();
    term.input("第一条");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["第一条"]);
    assert.ok(release !== undefined, "收尾时调了 afterTurn");
    term.input("第二条");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["第一条"], "afterTurn 没跑完：第二条排队");
    release?.();
    await settle();
    assert.deepEqual(runtime.runs, ["第一条", "第二条"]);
  } finally {
    cleanup();
  }
});

test("afterTurn 带上本轮是否被中止：Esc 取消的那轮为 true，下一轮正常收尾为 false", async () => {
  const seen: boolean[] = [];
  const { shell, term, runtime, cleanup } = makeShell((info) => {
    seen.push(info.cancelled);
    return undefined;
  });
  try {
    shell.start();
    await settle();
    runtime.autoResolve = false;
    term.input("做");
    term.input("\r");
    await settle();
    term.input("\x1b");
    await settle();
    runtime.finishAll();
    await settle();
    runtime.autoResolve = true;
    term.input("再做");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["做", "再做"]);
    assert.deepEqual(seen, [true, false]);
  } finally {
    cleanup();
  }
});

test("afterTurn 返回 undefined 照常空闲；抛错时说明一行并照常空闲", async () => {
  let mode: "none" | "throw" = "none";
  const { shell, term, runtime, cleanup } = makeShell(() =>
    mode === "throw" ? Promise.reject(new Error("换不过去")) : undefined
  );
  try {
    shell.start();
    await settle();
    term.input("一");
    term.input("\r");
    await settle();
    mode = "throw";
    term.input("二");
    term.input("\r");
    await settle();
    term.input("三");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["一", "二", "三"]);
    assert.match(screenText(term), /收尾时出错：换不过去/);
  } finally {
    cleanup();
  }
});

test("随下一条输入带给模型的说明：不开新的一轮，人的下一条输入前缀带上，只带一次", async () => {
  const { shell, term, runtime, cleanup } = makeShell(() => undefined);
  try {
    shell.start();
    await settle();
    shell.addNextInputNote("[Pigeon] note");
    await settle();
    assert.deepEqual(runtime.runs, [], "不自己开一轮");
    term.input("继续");
    term.input("\r");
    await settle();
    term.input("再来");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["[Pigeon] note\n\n继续", "再来"]);
  } finally {
    cleanup();
  }
});
