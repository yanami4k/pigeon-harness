// 决策 446：壳的 afterTurn——一轮收尾后、空闲下来之前调用（会话移进工作树时在这里换运行面）。返回 Promise 时等它跑完才空闲，
// 期间新的输入排队、跑完再发；返回 undefined 照常同步空闲；抛错时说明一行并照常空闲。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(afterTurn: () => Promise<void> | undefined) {
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
