// 验收修改：消息树的画法——ASCII 连接线画分叉（多层逐层画），当前路径正常亮度、其余分支暗色，当前位置标 current，
// 分支末尾一行 "`- reply: …"（暗色），时间右对齐，">" 只表示选中行
import assert from "node:assert/strict";
import { test } from "vitest";
import type { RewindNode } from "../application/rewind.ts";
import { MessageTree, messageTreePrefixes } from "./message-tree.ts";
import { withoutStyles as plain } from "./testing.ts";

function node(
  key: string,
  parent: string | null,
  text: string,
  options: { tip?: boolean; onMain?: boolean; current?: boolean } = {}
): RewindNode {
  return {
    key,
    kind: options.tip === true ? "tip" : "message",
    depth: 0,
    parent,
    text,
    timestamp: new Date(2026, 9, 14, 4, 20).getTime(),
    onMain: options.onMain ?? false,
    current: options.current ?? false,
    target: null,
  };
}

// 示意：第三条消息之后分成两枝，第一枝里又分了一次；当前在第二枝
const NODES: RewindNode[] = [
  node("a", null, "你好", { onMain: true }),
  node("b", "a", "你写一条记忆", { onMain: true }),
  node("c", "b", "你能的，相信我", { onMain: true }),
  node("d", "c", "你好"),
  node("e", "d", "用"),
  node("f", "e", "介绍你自己"),
  node("g", "f", ".omp/"),
  node("t1", "g", "`.omp/` 是另一个工具的运行数据目录", { tip: true }),
  node("h", "f", "再试一次"),
  node("t2", "h", "好的", { tip: true }),
  node("i", "c", "你不好", { onMain: true }),
  node("t3", "i", "抱歉让你失望了", { tip: true, onMain: true, current: true }),
];

test("连接线：分叉各枝 +- 起、最后一枝 `- 起，枝里接着的行在 | 之后，多层逐层画；链不缩进，末尾回复行 `- 起", () => {
  assert.deepEqual(messageTreePrefixes(NODES), [
    "",
    "",
    "",
    "+- ",
    "|  ",
    "|  ",
    "|  +- ",
    "|  |  `- ",
    "|  `- ",
    "|     `- ",
    "`- ",
    "   `- ",
  ]);
});

test("渲染：当前路径正常亮度、其余暗色；current 标在当前末端的上一条消息后面；时间右对齐；只用 ASCII", () => {
  const tree = new MessageTree({ height: () => 40 });
  tree.load(NODES);
  const width = 60;
  const lines = tree.render(width);
  const rows = lines.slice(1);
  const shown = rows.map(plain);
  // 光标落在当前末端那一行
  assert.match(shown[11] ?? "", /^> {4}`- reply: 抱歉让你失望了$/);
  assert.match(shown[0] ?? "", /^ {2}你好 +10-14 04:20$/);
  assert.match(shown[3] ?? "", /^ {2}\+- 你好 +10-14 04:20$/);
  assert.match(shown[7] ?? "", /^ {2}\| {2}\| {2}`- reply: `\.omp\/` 是/);
  assert.match(shown[10] ?? "", /^ {2}`- 你不好 +current {2}10-14 04:20$/);
  // 时间右对齐：带时间的行都写满到同一宽度
  for (const line of shown.filter((text) => /\d\d:\d\d$/.test(text))) {
    assert.equal(
      line.length + [...line].filter((ch) => ch.charCodeAt(0) > 0x2e80).length,
      width,
      line
    );
  }
  // 暗色：其余分支整行暗、回复行整行暗；当前路径上的消息不暗；current 暗
  assert.ok(!(rows[0] ?? "").includes("\x1b[2m"), rows[0]);
  assert.ok((rows[3] ?? "").startsWith("  \x1b[2m+- 你好"), rows[3]);
  assert.ok((rows[11] ?? "").includes("\x1b[2m   `- reply:"), rows[11]);
  assert.ok((rows[10] ?? "").includes("\x1b[2mcurrent\x1b[22m"), rows[10]);
  assert.ok(!(rows[10] ?? "").startsWith("  \x1b[2m"), rows[10]);
  assert.ok(!shown.some((line) => line.includes("*") || line.includes("\t")));
  // 移动光标：">" 跟着选中行走，current 不动
  tree.move(-1);
  const moved = tree.render(width).slice(1).map(plain);
  assert.match(moved[10] ?? "", /^> `- 你不好 +current/);
});

test("会话开头即当前末端（还没回复）：current 标在末端那一行", () => {
  const tree = new MessageTree({ height: () => 10 });
  tree.load([node("t", null, "", { tip: true, onMain: true, current: true })]);
  const shown = tree.render(40).slice(1).map(plain);
  assert.match(shown[0] ?? "", /^> `- \(no reply\) +current$/);
});
