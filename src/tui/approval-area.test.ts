// 决策 467、472：挂着的审批显示在底部的审批区（主视图里在输入框上方），不进消息流；答完收起，消息流只留一行暗色结论。
// 审批区画圆角边框（暗色），框内第一行工具名（加粗），接着是要批的那件事（命令、路径，正常色），来源、参数与细节暗色，改动
// 预览的增删行红绿，按键行的字母正常色、说明暗色；专门显示过的字段不在参数里重复，没覆盖的照旧列出；高度上限按窗口取，超出时
// 留开头与按键行、写明省略了几行；窄窗口里边框随之收窄；内容经 036 净化。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { approvalBlockLines } from "./approval.ts";
import { ApprovalArea } from "./approval-area.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle, withoutStyles } from "./testing.ts";

const RUN_COMMAND = {
  toolName: "run_command",
  toolCallId: "tc-1",
  tier: "exec",
  command: "npm test",
  args: { command: "npm test", timeoutSeconds: 60 },
  diffPreview: 'command: npm test\nargv: ["npm","test"] (no shell)\ncwd: /work',
} as const;

test("分类：工具名一行，命令一行（只出现一次），没覆盖的参数照旧列出，预览里重复的命令行去掉，按键行在最后", () => {
  const lines = approvalBlockLines({ ...RUN_COMMAND }, false);
  assert.deepEqual(lines[0], { kind: "title", text: "run_command" });
  assert.deepEqual(lines[1], { kind: "subject", text: "npm test" });
  const texts = lines.map((line) => line.text).join("\n");
  assert.equal(texts.split("npm test").length - 1, 1, texts);
  assert.match(texts, /"timeoutSeconds": 60/);
  assert.doesNotMatch(texts, /"command"/);
  assert.match(texts, /argv: \["npm","test"\]/);
  assert.equal(lines.at(-1)?.kind, "keys");
  // 改文件：路径是要批的那件事，增删行分出来
  const edit = approvalBlockLines(
    {
      toolName: "edit_file",
      toolCallId: "tc-2",
      args: { path: "src/a.ts", old_string: "a", new_string: "b" },
      diffPreview: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b",
    },
    true
  );
  assert.deepEqual(edit[1], { kind: "subject", text: "src/a.ts" });
  assert.ok(edit.some((line) => line.kind === "added" && line.text === "+b"));
  assert.ok(edit.some((line) => line.kind === "removed" && line.text === "-a"));
  assert.ok(edit.some((line) => line.kind === "detail" && line.text === "--- a/src/a.ts"));
  assert.ok(!edit.some((line) => line.kind === "detail" && line.text.includes('"path"')));
});

test("审批区：圆角边框暗色、工具名加粗、命令正常色、参数暗色、增删红绿、按键字母正常色；窄窗口收窄；超高截断；净化", () => {
  let cap = 50;
  const area = new ApprovalArea(() => cap);
  area.setBlock([
    { kind: "title", text: "edit_file" },
    { kind: "subject", text: "src/a.ts" },
    { kind: "detail", text: "args: {}" },
    { kind: "removed", text: "-a" },
    { kind: "added", text: "+b" },
    { kind: "keys", text: "[y] approve once / [n] reject" },
  ]);
  const raw = area.render(60);
  const plain = raw.map(withoutStyles);
  assert.match(plain[0] ?? "", /^ ╭─+╮$/);
  assert.match(plain.at(-1) ?? "", /^ ╰─+╯$/);
  assert.ok(
    plain.every((line) => visibleWidth(line) === 59),
    plain.join("\n")
  );
  assert.ok(raw[0]?.includes("\x1b[2m╭"), "边框暗色");
  assert.ok(raw[1]?.includes("\x1b[1medit_file"), "工具名加粗");
  assert.ok((raw[2] ?? "").includes("│\x1b[22m src/a.ts"), raw[2]);
  assert.ok(raw[3]?.includes("\x1b[2margs: {}"), "参数暗色");
  assert.ok(raw[4]?.includes("\x1b[31m-a"), "删行红");
  assert.ok(raw[5]?.includes("\x1b[32m+b"), "增行绿");
  assert.ok(raw[6]?.includes("[y]\x1b[2m approve once / \x1b[22m[n]"), raw[6]);
  assert.ok(!plain.some((line) => line.includes("-- approval --")));
  // 窄窗口：边框随之收窄，长行折行
  const narrow = area.render(24).map(withoutStyles);
  assert.ok(
    narrow.every((line) => visibleWidth(line) === 23),
    narrow.join("\n")
  );
  // 超高：留开头与按键行，写明省略了几行
  area.setBlock([
    { kind: "title", text: "edit_file" },
    ...Array.from({ length: 30 }, (_, i) => ({ kind: "added" as const, text: `+line ${i}` })),
    { kind: "keys", text: "[y] approve once / [n] reject" },
  ]);
  cap = 10;
  const tall = area.render(60).map(withoutStyles);
  assert.equal(tall.length, 10);
  assert.ok(
    tall.some((line) => /\.\.\. \d+ more lines not shown/.test(line)),
    tall.join("\n")
  );
  assert.match(tall.at(-2) ?? "", /\[y\] approve once/);
  // 净化
  area.setBlock([{ kind: "added", text: "+\x1b[2J伪造" }]);
  const injected = area.render(60).join("\n");
  assert.ok(!injected.includes("\x1b[2J") && injected.includes("␛[2J"), injected);
  area.clear();
  assert.deepEqual(area.render(60), []);
});

test("主视图：审批显示在输入框上方的框里、不进消息流；答完收起，消息流只留一行暗色结论", async () => {
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
    const answer = shell.askApproval({ ...RUN_COMMAND });
    await settle();
    const lines = term.screen.contentLines();
    const top = lines.findIndex((line) => line.includes("╭"));
    const bottom = lines.findIndex((line) => line.includes("╰"));
    const input = lines.findIndex((line, index) => index > bottom && /^-{20,}/.test(line));
    assert.ok(top >= 0 && bottom > top && input > bottom, screenText(term));
    const box = lines.slice(top, bottom + 1).join("\n");
    assert.match(box, /run_command/);
    assert.equal(box.split("npm test").length - 1, 1, box);
    assert.doesNotMatch(screenText(term), /-- approval --/);
    term.input("y");
    assert.deepEqual(await answer, { key: "y" });
    shell.noteApproval("✓ approved run_command: npm test");
    await settle();
    const after = screenText(term);
    assert.doesNotMatch(after, /╭/);
    assert.equal(
      after.split("\n").filter((line) => line.includes("✓ approved run_command")).length,
      1
    );
    assert.ok(term.writes.join("").includes("\x1b[2m ✓ approved run_command"), "结论行暗色");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
