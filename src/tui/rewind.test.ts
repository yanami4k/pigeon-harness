// 决策 435：会话回退的入口与选点（终端界面，回退面用替身）。空闲且输入框为空时双击 Esc 打开消息树，单击、输入框有字、
// 运行中都不开（运行中 Esc 照旧是中断）；/rewind 同样打开、运行中被拒。列表只列当前路径上的消息，光标缺省在最下面；选一行
// 回车弹动作菜单，按情形给项（没有代码要退时不给含 code 的两项，看的不是当前版本时才有 Switch，可撤销时才有 Undo）；
// 退完原消息放回输入框、写回结果如实列出；手改过的文件逐个选（缺省保留，空格切换）；←/→ 切版本；消息的文字经 036 净化；
// 消息树开着时排队的输入不发出。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type {
  CodeCheck,
  PreparedRewind,
  RewindNode,
  RewindOutcome,
} from "../application/rewind.ts";
import { newSessionId } from "../state/ids.ts";
import type { RewindMode } from "../state/session-entries.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiRewindFace } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const NODES: RewindNode[] = [
  {
    key: "run:1",
    kind: "message",
    depth: 0,
    parent: null,
    text: "first task",
    timestamp: 0,
    onMain: true,
    current: false,
    target: null,
    prefill: "first task",
  },
  {
    key: "run:2",
    kind: "message",
    depth: 0,
    parent: "run:1",
    text: `second \u001b[2Jtask`,
    timestamp: 0,
    onMain: true,
    current: false,
    target: "e2",
    prefill: "second task",
  },
  {
    key: "tip:9",
    kind: "tip",
    depth: 0,
    parent: "run:2",
    text: "done",
    timestamp: 0,
    onMain: true,
    current: true,
    target: "e9",
  },
];

interface Calls {
  prepared: Array<string | null>;
  checked: number;
  applied: Array<{ mode: RewindMode; revert: string[] }>;
}

function face(
  options: {
    code: boolean;
    conflicts?: string[];
    undo?: boolean;
    failed?: boolean;
    nodes?: RewindNode[];
  },
  calls: Calls
): TuiRewindFace {
  return {
    tree: async () => options.nodes ?? NODES,
    prepareUndo: async () =>
      options.undo === true
        ? ({
            file: {},
            trees: undefined,
            plan: {
              from: "e9",
              to: "e9",
              files: [{ path: "a.txt" }],
              untouchable: [],
              createdAfter: new Map(),
              undo: true,
            },
          } as unknown as PreparedRewind)
        : undefined,
    prepare: async (to) => {
      calls.prepared.push(to);
      return {
        file: {},
        trees: undefined,
        plan: {
          from: "e9",
          to,
          files: options.code ? [{ path: "a.txt" }] : [],
          untouchable: [],
          createdAfter: new Map(),
        },
      } as unknown as PreparedRewind;
    },
    check: async () => {
      calls.checked += 1;
      return {
        before: { ref: "r", commit: "c", tree: "t" },
        classified: {
          actions: [{ path: "a.txt" }],
          conflicts: (options.conflicts ?? []).map((path) => ({
            path,
            reason: "agent 改过之后又被手改过",
          })),
        },
      } as unknown as CodeCheck;
    },
    apply: async (_prepared, applied) => {
      calls.applied.push({ mode: applied.mode, revert: [...(applied.revert ?? [])] });
      const outcome: RewindOutcome = {
        mode: applied.mode,
        kept: (options.conflicts ?? []).filter((path) => !(applied.revert ?? new Set()).has(path)),
        grantsAdded: 0,
        grantsRevoked: 0,
        untouchable: [],
        problems: [],
        ...(options.undo === true ? { undo: true } : {}),
        ...(options.failed === true ? { failed: { path: "b.txt", reason: "EPERM" } } : {}),
        ...(applied.mode !== "conversation"
          ? {
              restore: { written: ["a.txt"], removed: [], skipped: [], saved: [], removedDirs: [] },
            }
          : {}),
      };
      return outcome;
    },
  };
}

function makeShell(options: {
  code: boolean;
  conflicts?: string[];
  undo?: boolean;
  failed?: boolean;
  nodes?: RewindNode[];
}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-rewind-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 40);
  const runtime = new ScriptedRuntime(sessionId);
  const calls: Calls = { prepared: [], checked: 0, applied: [] };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    rewind: face(options, calls),
  });
  shell.start();
  return {
    shell,
    term,
    runtime,
    calls,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

test("双击 Esc（空闲、输入框为空）打开消息树；单击、输入框有字时不开；文字经净化", async () => {
  const { shell, term, cleanup } = makeShell({ code: true });
  try {
    await settle();
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== messages/);
    term.input("x");
    term.input(ESC);
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== messages/, "输入框有字不开");
    // 判断本身：输入框有字时取消键连按两下也不算双击
    assert.equal(shell.idleEscape(), false);
    assert.equal(shell.idleEscape(), false);
    term.input("\x15");
    term.input(ESC);
    term.input(ESC);
    await settle();
    const screen = screenText(term);
    assert.match(screen, /== messages/);
    assert.match(screen, /^ {2}first task +\d\d-\d\d \d\d:\d\d$/m);
    // 只列消息，不列回复与末端；光标缺省在最下面那一条
    assert.match(screen, /^› second ␛\[2Jtask +\d\d-\d\d \d\d:\d\d$/m);
    assert.doesNotMatch(screen, /done|current|reply:|\*/);
    assert.ok(!term.writes.join("").includes(`${ESC}[2Jtask`), "消息里的控制序列不写进终端");
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== messages/);
  } finally {
    cleanup();
  }
});

test("/rewind 打开；回车弹动作菜单，只退对话后原消息放回输入框；运行中 /rewind 被拒、Esc 仍是中断", async () => {
  const { term, runtime, calls, cleanup } = makeShell({ code: true });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(calls.prepared, ["e2"]);
    // 看的就是当前版本：没有 Switch；没有可撤销的：没有 Undo
    const menu = screenText(term).split("\n").slice(1, 6).join("\n");
    assert.equal(
      menu,
      [
        'Rewind to "second ␛[2Jtask"',
        "› Restore code and conversation",
        "  Restore conversation",
        "  Restore code",
        "  Cancel",
      ].join("\n")
    );
    term.input(DOWN);
    term.input("\r");
    await settle();
    assert.deepEqual(calls.applied, [{ mode: "conversation", revert: [] }]);
    assert.equal(calls.checked, 0, "只退对话不拍现状");
    const after = screenText(term);
    assert.match(after, /rewound conversation to before this message/);
    assert.match(after, /second task/);
    term.input("\x15");
    // 运行中：/rewind 被拒，Esc 是中断
    runtime.autoResolve = false;
    term.input("跑");
    term.input("\r");
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    assert.doesNotMatch(screenText(term), /== messages/);
    term.input(ESC);
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== messages/);
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
});

test("没有代码要退时菜单里不出现含 code 的两项；Cancel 回到列表", async () => {
  const { term, calls, cleanup } = makeShell({ code: false });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input(UP);
    term.input("\r");
    await settle();
    assert.deepEqual(calls.prepared, [null]);
    let screen = screenText(term);
    assert.match(screen, /Rewind to "first task"/);
    assert.match(screen, /^› Restore conversation$/m);
    assert.match(screen, /^ {2}Cancel$/m);
    assert.doesNotMatch(screen, /Restore code/);
    term.input(DOWN);
    term.input("\r");
    await settle();
    screen = screenText(term);
    assert.match(screen, /^› first task/m, "Cancel 回到列表，光标还在原处");
    assert.deepEqual(calls.applied, []);
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(calls.applied, [{ mode: "conversation", revert: [] }]);
  } finally {
    cleanup();
  }
});

test("退代码：手改过的文件逐个选（缺省保留，空格切换为退回）；写回结果如实列出", async () => {
  const { term, calls, cleanup } = makeShell({ code: true, conflicts: ["b.txt", "c.txt"] });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.equal(calls.checked, 1);
    let screen = screenText(term);
    assert.match(screen, /\[keep\] b\.txt/);
    assert.match(screen, /\[keep\] c\.txt/);
    term.input(DOWN);
    term.input(" ");
    await settle();
    screen = screenText(term);
    assert.match(screen, /\[revert\] c\.txt/);
    term.input("\r");
    await settle();
    assert.deepEqual(calls.applied, [{ mode: "both", revert: ["c.txt"] }]);
    const after = screenText(term);
    assert.match(after, /restored: a\.txt/);
  } finally {
    cleanup();
  }
});

test("消息树开着时排队的输入不发出，关了再发", async () => {
  const { shell, term, runtime, cleanup } = makeShell({ code: false });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    shell.enqueueInput("排队的一条");
    await settle();
    assert.deepEqual(runtime.runs, []);
    term.input(ESC);
    await settle();
    assert.deepEqual(runtime.runs, ["排队的一条"]);
  } finally {
    cleanup();
  }
});

test("有可撤销的上一次退代码时菜单里才有 Undo，撤销走拍现状与写回", async () => {
  const { term, calls, cleanup } = makeShell({ code: true, undo: true });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.match(screenText(term), /^ {2}Undo last code rewind$/m);
    for (let i = 0; i < 3; i++) term.input(DOWN);
    await settle();
    assert.match(screenText(term), /^› Undo last code rewind$/m);
    term.input("\r");
    await settle();
    assert.equal(calls.checked, 1);
    assert.deepEqual(calls.applied, [{ mode: "code", revert: [] }]);
    assert.match(screenText(term), /undid last code rewind/);
  } finally {
    cleanup();
  }
});

test("写回中途出错：如实列出写了哪些、哪个出错，对话没有退，原消息不放回输入框", async () => {
  const { term, cleanup } = makeShell({ code: true, failed: true });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /restoring files failed partway; conversation not rewound/);
    assert.match(screen, /restored: a\.txt/);
    assert.match(screen, /failed: b\.txt: EPERM/);
    assert.doesNotMatch(screen, /second task/);
  } finally {
    cleanup();
  }
});

// 第二条之后分了叉：原来的一支（"old second" 之后还有 "old third"，末端 e7）与重发的一支（当前）
const FORKED: RewindNode[] = [
  {
    key: "run:1",
    kind: "message",
    depth: 0,
    parent: null,
    text: "first task",
    timestamp: 0,
    onMain: true,
    current: false,
    target: null,
    prefill: "first task",
  },
  {
    key: "run:2",
    kind: "message",
    depth: 1,
    parent: "run:1",
    text: "old second",
    timestamp: 1,
    onMain: false,
    current: false,
    target: "e2",
    prefill: "old second",
  },
  {
    key: "run:3",
    kind: "message",
    depth: 1,
    parent: "run:2",
    text: "old third",
    timestamp: 2,
    onMain: false,
    current: false,
    target: "e5",
    prefill: "old third",
  },
  {
    key: "tip:7",
    kind: "tip",
    depth: 1,
    parent: "run:3",
    text: "old reply",
    timestamp: 3,
    onMain: false,
    current: false,
    target: "e7",
  },
  {
    key: "run:8",
    kind: "message",
    depth: 1,
    parent: "run:1",
    text: "new second",
    timestamp: 4,
    onMain: true,
    current: false,
    target: "e2",
    prefill: "new second",
  },
  {
    key: "tip:9",
    kind: "tip",
    depth: 1,
    parent: "run:8",
    text: "new reply",
    timestamp: 5,
    onMain: true,
    current: true,
    target: "e9",
  },
];

test("分叉的位置行尾显示版本箭头，←/→ 就地切换、下面的行跟着换；看的不是当前版本时菜单里有 Switch，整支切过去", async () => {
  const { term, calls, cleanup } = makeShell({ code: true, nodes: FORKED });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    let rows = screenText(term).split("\n").slice(1, 3);
    assert.match(rows[0] ?? "", /^ {2}first task {2,}\d\d-\d\d \d\d:\d\d$/);
    assert.match(rows[1] ?? "", /^› new second +‹2\/2› {3}\d\d-\d\d \d\d:\d\d$/);
    // 没分叉的行不显示箭头，时间与有箭头的行对齐
    assert.equal(rows[0]?.length, rows[1]?.length);
    term.input("\x1b[D");
    await settle();
    rows = screenText(term).split("\n").slice(1, 5);
    assert.match(rows[1] ?? "", /^› old second +‹1\/2›/);
    assert.match(rows[2] ?? "", /^ {2}old third +\d\d-\d\d \d\d:\d\d$/);
    assert.doesNotMatch(screenText(term), /new second/);
    // 到头不绕回
    term.input("\x1b[D");
    await settle();
    assert.match(screenText(term), /‹1\/2›/);
    term.input(DOWN);
    term.input("\r");
    await settle();
    // 退到 old third 之前（e5）与整支切过去（末端 e7）都规划了
    assert.deepEqual(calls.prepared, ["e5", "e7"]);
    const screen = screenText(term);
    assert.match(screen, /Rewind to "old third"/);
    assert.match(screen, /^ {2}Switch to this version$/m);
    for (let i = 0; i < 3; i++) term.input(DOWN);
    await settle();
    assert.match(screenText(term), /^› Switch to this version$/m);
    term.input("\r");
    await settle();
    assert.deepEqual(calls.applied, [{ mode: "both", revert: [] }]);
    assert.match(screenText(term), /switched code and conversation to this version/);
    assert.ok(!screenText(term).includes("> old third"), "整支切过去不往输入框放消息");
  } finally {
    cleanup();
  }
});

test("回退之后还没发消息：那个位置多一个暗色的「还没发」版本，往回切看得到原来那一支", async () => {
  const nodes = FORKED.filter((node) => node.key !== "run:8" && node.key !== "tip:9");
  const { term, cleanup } = makeShell({ code: true, nodes });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    const rows = screenText(term).split("\n").slice(1, 3);
    assert.match(rows[1] ?? "", /^› \(no message yet\) +‹2\/2›$/);
    assert.ok(term.writes.join("").includes("\x1b[2m(no message yet)"), "「还没发」那一行暗色");
    term.input("\x1b[D");
    await settle();
    assert.match(screenText(term), /^› old second +‹1\/2›/m);
    assert.match(screenText(term), /old third/);
  } finally {
    cleanup();
  }
});
