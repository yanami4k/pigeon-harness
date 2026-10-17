// 决策 488：/new 开一个新会话——装配方（main.ts）建好新会话核，壳换绑过去；旧的当前会话还在干活时由装配方退到面板
// 接着跑（不在本文件覆盖，那一段在 main.ts）。本文件只断言壳这一侧：命令分发、用法、没有入口时的如实说明、
// 换绑后会话号与花费换成新会话的。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { SLASH_COMMANDS } from "./command-table.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-new-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 24);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, ...extra });
  shell.start();
  return {
    shell,
    term,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("命令表：/new 运行中可用、作用于当前会话", () => {
  const spec = SLASH_COMMANDS.find((entry) => entry.name === "new");
  assert.ok(spec !== undefined, "/new 应在命令表里");
  assert.equal(spec.usage, "/new");
  assert.equal(spec.whileRunning.allow, true);
  assert.equal(spec.scope, "session");
});

test("/new：换到装配方建好的新会话，花费从零起算", async () => {
  const nextId = newSessionId();
  const created: number[] = [];
  const { shell, term, cleanup } = makeShell({
    newSession: {
      create: async () => {
        created.push(1);
        return { sessionId: nextId, binding: { runtime: new ScriptedRuntime(nextId) } };
      },
    },
  });
  try {
    await settle();
    term.input("/new");
    term.input("\r");
    await settle(200);
    assert.equal(created.length, 1, "应该只建一次");
    assert.equal(shell.sessionId(), nextId);
    assert.match(screenText(term), /0 tokens/, "新会话的花费从零起算");
  } finally {
    cleanup();
  }
});

test("/new 不带参数：给了参数即写用法，不建会话", async () => {
  const created: number[] = [];
  const { term, cleanup } = makeShell({
    newSession: {
      create: async () => {
        created.push(1);
        const id = newSessionId();
        return { sessionId: id, binding: { runtime: new ScriptedRuntime(id) } };
      },
    },
  });
  try {
    await settle();
    term.input("/new 多余");
    term.input("\r");
    await settle(200);
    assert.equal(created.length, 0);
    assert.match(screenText(term), /usage: \/new/);
  } finally {
    cleanup();
  }
});

test("没有 /new 入口时如实说明（不当成未知命令）", async () => {
  const { term, cleanup } = makeShell();
  try {
    await settle();
    term.input("/new");
    term.input("\r");
    await settle(200);
    assert.match(screenText(term), /\/new is not available in this session/);
  } finally {
    cleanup();
  }
});
