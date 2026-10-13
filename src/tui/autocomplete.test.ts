// 决策 439：输入框补全。"/" 开头列出命令（取自命令表），回车先套用补全再发出（发出的文字去掉尾随空格后照常走命令）；
// 补全列表开着时 Esc 归它（关列表，不当作取消）；Tab 以工作区为根补全路径；没有 fd 时 "@" 不出结果。选中项前缀为 ASCII。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { slashCommandItems } from "./input-editor.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-complete-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "alpha-module.ts"), "x\n");
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir: root,
    autocomplete: { basePath: root, fdPath: null },
  });
  shell.start();
  return {
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("命令表：按首段去重、带用法", () => {
  const items = slashCommandItems();
  const names = items.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("resume") && names.includes("worktrees") && names.includes("grants"));
  assert.match(items.find((item) => item.name === "rename")?.description ?? "", /\/rename/);
});

test('"/" 开头列出命令，选中前缀为 ASCII；回车套用并发出命令（不交给模型）', async () => {
  const { term, runtime, cleanup } = makeShell();
  try {
    await settle();
    term.input("/sess");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /sessions/);
    assert.doesNotMatch(screen, /→/);
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, [], "斜杠命令不交给模型");
    assert.match(screenText(term), /会话|session/i);
  } finally {
    cleanup();
  }
});

test("补全列表开着时 Esc 只关列表；Tab 以工作区为根补全路径", async () => {
  const { term, runtime, cleanup } = makeShell();
  try {
    await settle();
    term.input("/wor");
    await settle();
    term.input("\x1b");
    await settle();
    assert.doesNotMatch(screenText(term), /\[cancel\]/);
    // 清空，改补路径
    term.input("\x15");
    term.input("看看 src/alp");
    term.input("\t");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["看看 src/alpha-module.ts"]);
  } finally {
    cleanup();
  }
});
