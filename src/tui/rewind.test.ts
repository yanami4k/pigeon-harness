// 决策 435：会话回退的入口与选点（终端界面，回退面用替身）。空闲且输入框为空时双击 Esc 打开消息树，单击、输入框有字、
// 运行中都不开（运行中 Esc 照旧是中断）；/rewind 同样打开、运行中被拒；选一条消息后三选一（没有代码要退时只给退对话），
// 退完原消息放回输入框、写回结果如实列出；手改过的文件逐个选（缺省保留，空格切换）；当前位置回车不动；消息与回复的
// 文字经 036 净化；消息树开着时排队的输入不发出。
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
  options: { code: boolean; conflicts?: string[]; undo?: boolean; failed?: boolean },
  calls: Calls
): TuiRewindFace {
  return {
    tree: async () => NODES,
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
    assert.match(screen, /first task/);
    assert.match(screen, /\(end\) done {2}\(current\)/);
    assert.ok(!term.writes.join("").includes(`${ESC}[2Jtask`), "消息里的控制序列不写进终端");
    assert.match(screen, /second ␛\[2Jtask/);
    // 当前位置回车不动
    term.input("\r");
    await settle();
    assert.match(screenText(term), /已经在这里/);
    term.input(ESC);
    await settle();
    assert.doesNotMatch(screenText(term), /== messages/);
  } finally {
    cleanup();
  }
});

test("/rewind 打开；选一条消息三选一，只退对话后原消息放回输入框；运行中 /rewind 被拒、Esc 仍是中断", async () => {
  const { term, runtime, calls, cleanup } = makeShell({ code: true });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input(UP);
    term.input("\r");
    await settle();
    assert.deepEqual(calls.prepared, ["e2"]);
    const screen = screenText(term);
    assert.match(screen, /\[1\] 代码与对话都退/);
    assert.match(screen, /\[2\] 只退对话/);
    assert.match(screen, /\[3\] 只退代码/);
    term.input("2");
    await settle();
    assert.deepEqual(calls.applied, [{ mode: "conversation", revert: [] }]);
    assert.equal(calls.checked, 0, "只退对话不拍现状");
    const after = screenText(term);
    assert.match(after, /已退回（对话）到这条消息之前/);
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

test("没有代码要退时只给退对话", async () => {
  const { term, calls, cleanup } = makeShell({ code: false });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input(UP);
    term.input(UP);
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /\[1\] 只退对话/);
    assert.doesNotMatch(screen, /只退代码/);
    assert.match(screen, /只退对话$/m);
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
    term.input(UP);
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
    assert.match(after, /写回：a\.txt/);
    assert.doesNotMatch(after, /保留了拿不准的/);
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

test("当前位置回车：有可撤销的上一次退代码即给撤销，撤销走拍现状与写回", async () => {
  const { term, calls, cleanup } = makeShell({ code: true, undo: true });
  try {
    await settle();
    term.input("/rewind");
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.match(screenText(term), /\[1\] 撤销上次退代码/);
    term.input("\r");
    await settle();
    assert.equal(calls.checked, 1);
    assert.deepEqual(calls.applied, [{ mode: "code", revert: [] }]);
    assert.match(screenText(term), /已撤销上次退代码/);
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
    term.input(UP);
    term.input("\r");
    await settle();
    term.input("1");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /写回中途出错，停在出错的那个文件：对话没有退/);
    assert.match(screen, /写回：a\.txt/);
    assert.match(screen, /出错：b\.txt：EPERM/);
    assert.doesNotMatch(screen, /已写的可撤销/);
    assert.doesNotMatch(screen, /second task/);
  } finally {
    cleanup();
  }
});
