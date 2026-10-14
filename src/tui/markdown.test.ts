// 决策 439：模型回复按 Markdown 渲染——粗体与行内代码不露出标记、列表与代码块照样排、引用边与分隔线只用 ASCII（不出现
// │ ─ 这类歧义宽字符）、$…$ 不当公式；流式逐段生长；控制序列照样先净化（036）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

test("模型回复按 Markdown 渲染：标记不露出，引用与分隔线只用 ASCII，$…$ 原样，流式逐段生长", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-md-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 50);
  const runtime = new ScriptedRuntime(sessionId);
  runtime.autoResolve = false;
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
  try {
    shell.start();
    await settle();
    term.input("讲讲");
    term.input("\r");
    await settle();
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emitDelta("text", "## 结论\n\n这是**重点**与 `code`，费用 $5 到 $10。\n\n");
    await settle();
    assert.match(screenText(term), /这是重点与 code，费用 \$5 到 \$10。/);
    runtime.emitDelta(
      "text",
      "- 第一项\n- 第二项\n\n> 引用一句\n\n---\n\n```ts\nconst x = 1;\n```\n结尾\x1b]52;c;aGk=\x07"
    );
    await settle();
    const screen = screenText(term);
    assert.doesNotMatch(screen, /\*\*|`code`|## /);
    assert.match(screen, /- 第一项/);
    assert.match(screen, /\| 引用一句/);
    assert.match(screen, /^ ?-{10,}/m);
    assert.match(screen, /const x = 1;/);
    assert.doesNotMatch(screen, /[│─]/);
    assert.match(screen, /␛\]52/, "控制序列先净化再渲染");
    const raw = term.writes.join("");
    assert.ok(!raw.includes("\x1b]52;c;aGk="), "原始字节不落终端");
    assert.ok(raw.includes("\x1b[1m"), "粗体由受信主题加上");
    runtime.finishAll();
    await settle();
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
