// 决策 467：挂着的审批显示在底部的审批区（主视图里在输入框上方），不进消息流；答完收起，消息流只留一行暗色结论；
// 审批区高度上限按窗口取，超出时留开头与按键行、写明省略了几行；内容经 036 净化。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ApprovalArea } from "./approval-area.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle, withoutStyles } from "./testing.ts";

test("审批区：放得下全显示；超过上限留开头与末尾的按键行，中间写明省略了几行；控制序列可见化", () => {
  let cap = 50;
  const area = new ApprovalArea(() => cap);
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  area.setText(["-- approval --", ...body, "[y] approve / [n] reject"].join("\n"));
  assert.equal(area.render(80).filter((line) => line.trim() !== "").length, 32);
  cap = 10;
  const shown = area.render(80).map(withoutStyles);
  assert.equal(shown.length, 10);
  assert.match(shown[1] ?? "", /-- approval --/);
  assert.ok(
    shown.some((line) => /\.\.\. \d+ more lines not shown/.test(line)),
    shown.join("\n")
  );
  assert.ok(
    shown.some((line) => line.includes("[y] approve / [n] reject")),
    "按键行留着"
  );
  area.setText("diff:\n\x1b[2J伪造");
  const raw = area.render(80).join("\n");
  assert.ok(!raw.includes("\x1b[2J") && raw.includes("␛[2J"), raw);
  area.setText("");
  assert.deepEqual(area.render(80), []);
});

test("主视图：审批显示在输入框上方、不进消息流；答完收起，消息流只留一行暗色结论", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-approval-area-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
  try {
    shell.start();
    await settle();
    term.input("你好");
    term.input("\r");
    await settle();
    const answer = shell.askApproval({
      toolName: "edit_file",
      toolCallId: "tc-1",
      args: { path: "src/a.ts" },
    });
    await settle();
    const lines = term.screen.contentLines();
    const block = lines.findIndex((line) => line.includes("-- approval --"));
    const border = lines.findIndex((line, index) => index > block && /^-{20,}/.test(line));
    assert.ok(block >= 0 && border > block, screenText(term));
    assert.ok(
      lines.slice(block, border).some((line) => line.includes("tool: edit_file")),
      "审批块整块在输入框上方"
    );
    term.input("y");
    assert.deepEqual(await answer, { key: "y" });
    shell.noteApproval('✓ approved edit_file {"path":"src/a.ts"}');
    await settle();
    const after = screenText(term);
    assert.doesNotMatch(after, /-- approval --|tool: edit_file/);
    assert.equal(
      after.split("\n").filter((line) => line.includes("✓ approved edit_file")).length,
      1
    );
    assert.ok(term.writes.join("").includes("\x1b[2m ✓ approved edit_file"), "结论行暗色");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
