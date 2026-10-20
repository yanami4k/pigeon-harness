// 决策 469：状态栏最前面写当前会话的审批模式（决策 514：ask 青色、bypass 橙色），Shift+Tab 在两者之间切换、当场生效；审批挂着时按键
// 归审批，不切换也不替人回答；没有模式可切的（替身运行面）状态栏不写模式、Shift+Tab 不做事。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { type ApprovalModeControl, PigeonTuiShell } from "./shell.ts";
import { MockTerminal, settle } from "./testing.ts";

const SHIFT_TAB = "\x1b[Z";

function makeShell(control?: ApprovalModeControl) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-mode-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 24);
  const runtime = new ScriptedRuntime(sessionId);
  runtime.context = { tokens: 46_000, contextWindow: 200_000 };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    ...(control !== undefined ? { approvalMode: () => control } : {}),
  });
  shell.start();
  return {
    shell,
    term,
    bar: () => term.screen.contentLines().at(-1)?.trim() ?? "",
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("状态栏最前面写模式；Shift+Tab 切换当场生效，放手档显示 bypass 且为橙色、ask 青色（决策 514）", async () => {
  const changes: string[] = [];
  let mode: "prompt" | "yolo" = "prompt";
  const control: ApprovalModeControl = {
    get: () => mode,
    set: (next) => {
      changes.push(`${mode}->${next}`);
      mode = next;
    },
  };
  const { term, bar, cleanup } = makeShell(control);
  try {
    await settle();
    assert.equal(bar(), "ask · ctx 23% (46k/200k) · 0 tokens");
    term.writes.length = 0;
    term.input(SHIFT_TAB);
    await settle();
    assert.equal(bar(), "bypass · ctx 23% (46k/200k) · 0 tokens");
    assert.deepEqual(changes, ["prompt->yolo"]);
    // 决策 514：bypass 橙色（256 色 208 号），ask 青色
    assert.ok(term.writes.join("").includes("\x1b[38;5;208mbypass\x1b[39m"), "bypass 橙色");
    term.writes.length = 0;
    term.input(SHIFT_TAB);
    await settle();
    assert.equal(bar(), "ask · ctx 23% (46k/200k) · 0 tokens");
    assert.ok(term.writes.join("").includes("\x1b[36mask\x1b[39m"), "ask 青色");
    assert.deepEqual(changes, ["prompt->yolo", "yolo->prompt"]);
  } finally {
    cleanup();
  }
});

test("审批挂着时 Shift+Tab 归审批：不切换、不替人回答", async () => {
  let mode: "prompt" | "yolo" = "prompt";
  const control: ApprovalModeControl = {
    get: () => mode,
    set: (next) => {
      mode = next;
    },
  };
  const { shell, term, bar, cleanup } = makeShell(control);
  try {
    await settle();
    let answered = false;
    void shell
      .askApproval({ toolName: "edit_file", toolCallId: "t1", args: { path: "a" } })
      .then(() => {
        answered = true;
      });
    await settle();
    term.input(SHIFT_TAB);
    await settle();
    assert.equal(mode, "prompt");
    assert.equal(answered, false);
    assert.ok(shell.pendingApproval() !== null, "审批照旧挂着");
    term.input("n");
    await settle();
    assert.equal(answered, true);
    term.input(SHIFT_TAB);
    await settle();
    assert.equal(mode, "yolo");
    assert.match(bar(), /^bypass · /);
  } finally {
    cleanup();
  }
});

test("没有模式可切：状态栏不写模式，Shift+Tab 不做事", async () => {
  const { term, bar, cleanup } = makeShell();
  try {
    await settle();
    term.input(SHIFT_TAB);
    await settle();
    assert.equal(bar(), "ctx 23% (46k/200k) · 0 tokens");
  } finally {
    cleanup();
  }
});
