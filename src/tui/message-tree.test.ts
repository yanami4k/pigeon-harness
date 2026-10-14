// 消息树的版本视图（决策 464）：只列当前路径上的消息；分叉的位置给版本箭头，←/→ 切换后下面的行换成那一支（下层的分叉取这次
// 看过的、没看过的取当前路径上的、都不在取最近有动静的）；整支切过去的目标是正在看的那一支最后一条之后最近的末端
import assert from "node:assert/strict";
import { test } from "vitest";
import type { RewindNode } from "../application/rewind.ts";
import { MessageTree, MessageVersions } from "./message-tree.ts";
import { withoutStyles as plain } from "./testing.ts";

function node(
  key: string,
  parent: string | null,
  text: string,
  at: number,
  options: { tip?: boolean; onMain?: boolean; current?: boolean } = {}
): RewindNode {
  return {
    key,
    kind: options.tip === true ? "tip" : "message",
    depth: 0,
    parent,
    text,
    timestamp: new Date(2026, 9, 14, 4, at).getTime(),
    onMain: options.onMain ?? false,
    current: options.current ?? false,
    target: `t-${key}`,
  };
}

// 示意：第三条之后分成两枝；第一枝里 "介绍你自己" 之后又分了一次（".omp/" 最近、"再试一次" 较早）；当前在第二枝
const NODES: RewindNode[] = [
  node("a", null, "你好", 1, { onMain: true }),
  node("b", "a", "你写一条记忆", 2, { onMain: true }),
  node("c", "b", "你能的，相信我", 3, { onMain: true }),
  node("d", "c", "你好", 20),
  node("e", "d", "用", 20),
  node("f", "e", "介绍你自己", 22),
  node("h", "f", "再试一次", 23),
  node("t2", "h", "好的", 24, { tip: true }),
  node("g", "f", ".omp/", 25),
  node("t1", "g", "运行数据目录", 26, { tip: true }),
  node("i", "c", "你不好", 48, { onMain: true }),
  node("t3", "i", "抱歉", 49, { tip: true, onMain: true, current: true }),
];

const texts = (versions: MessageVersions): string[] =>
  versions
    .rows()
    .map(
      (row) =>
        `${row.node?.text ?? "(empty)"}${row.count > 1 ? ` ${row.index + 1}/${row.count}` : ""}`
    );

test("缺省看当前路径；切到别的版本后下面换成那一支，下层分叉取最近有动静的；再切回来照旧", () => {
  const versions = new MessageVersions(NODES);
  assert.deepEqual(texts(versions), ["你好", "你写一条记忆", "你能的，相信我", "你不好 2/2"]);
  assert.equal(versions.onCurrent(), true);
  assert.equal(versions.switchTarget()?.key, "t3");
  assert.equal(versions.shift("c", -1), true);
  assert.deepEqual(texts(versions), [
    "你好",
    "你写一条记忆",
    "你能的，相信我",
    "你好 1/2",
    "用",
    "介绍你自己",
    ".omp/ 2/2",
  ]);
  assert.equal(versions.onCurrent(), false);
  assert.equal(versions.switchTarget()?.key, "t1");
  // 下层切到较早的那个版本，记住；到头不绕回
  assert.equal(versions.shift("f", -1), true);
  assert.equal(versions.shift("f", -1), false);
  assert.deepEqual(texts(versions).slice(-1), ["再试一次 1/2"]);
  assert.equal(versions.switchTarget()?.key, "t2");
  // 上层切回当前、再切过去：下层仍是这次看过的那个
  versions.shift("c", 1);
  assert.equal(versions.onCurrent(), true);
  versions.shift("c", -1);
  assert.deepEqual(texts(versions).slice(-1), ["再试一次 1/2"]);
});

test("回退到第一条之前、还没发：会话开头多一个「还没发」版本，缺省看它", () => {
  const versions = new MessageVersions([
    node("a", null, "你好", 1),
    node("t", "a", "回复", 2, { tip: true }),
  ]);
  assert.deepEqual(texts(versions), ["(empty) 2/2"]);
  assert.equal(versions.onCurrent(), true);
  versions.shift(null, -1);
  assert.deepEqual(texts(versions), ["你好 1/2"]);
  assert.equal(versions.switchTarget()?.key, "t");
});

test("渲染：一行一条，时间右对齐，只在分叉的行显示箭头，箭头一栏对齐；光标缺省在最下面；不画树线", () => {
  const tree = new MessageTree({ height: () => 40 });
  tree.load(NODES);
  const width = 60;
  const shown = tree.render(width).slice(1).map(plain);
  assert.equal(shown.length, 4);
  assert.match(shown[0] ?? "", /^ {2}你好 +10-14 04:01$/);
  assert.match(shown[3] ?? "", /^› 你不好 +‹2\/2› {3}10-14 04:48$/);
  const cells = (line: string): number =>
    line.length + [...line].filter((ch) => ch.charCodeAt(0) > 0x2e80).length;
  for (const line of shown) assert.equal(cells(line), width, line);
  assert.ok(!shown.some((line) => /[|*]|`-|\+-|current|reply/.test(line)));
  // ←：就地切换，光标留在这一行
  tree.shift(-1);
  const switched = tree.render(width).slice(1).map(plain);
  assert.match(switched[3] ?? "", /^› 你好 +‹1\/2› {3}10-14 04:20$/);
  assert.match(switched[6] ?? "", /^ {2}\.omp\/ +‹2\/2› {3}10-14 04:25$/);
  // 光标不在分叉行上时 ←/→ 不动
  tree.move(1);
  tree.shift(1);
  assert.match(tree.render(width).slice(1).map(plain)[3] ?? "", /‹1\/2›/);
});
