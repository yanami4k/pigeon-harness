// 决策 450：壳这边的两处——忙闲变化告诉装配方（一轮开始为忙、真正空闲为闲，各一次）；/rename 交给装配方改名并显示（决策 456：改的是会话名）
// 返回的一行，没给即命令不可用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(extra: Partial<TuiShellOptions>) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-peer-shell-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir, ...extra });
  shell.start();
  return {
    term,
    runtime,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("忙闲：一轮开始为忙、跑完空闲为闲，各告诉一次", async () => {
  const changes: boolean[] = [];
  const { term, runtime, cleanup } = makeShell({ onBusyChange: (busy) => changes.push(busy) });
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("做");
    term.input("\r");
    await settle();
    assert.deepEqual(changes, [true]);
    runtime.finishAll();
    await settle();
    assert.deepEqual(changes, [true, false]);
  } finally {
    cleanup();
  }
});

test("/rename：交给装配方并显示返回的一行；没给即命令不可用", async () => {
  const names: string[] = [];
  const { term, cleanup } = makeShell({
    renameSession: (name) => {
      names.push(name);
      return `本会话改名为 ${name}`;
    },
  });
  try {
    await settle();
    term.input("/rename  api-fix ");
    term.input("\r");
    await settle();
    assert.deepEqual(names, ["api-fix"]);
    assert.match(screenText(term), /改名为 api-fix/);
    term.input("/rename");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /usage: \/rename <name>/);
  } finally {
    cleanup();
  }
  const plain = makeShell({});
  try {
    await settle();
    plain.term.input("/rename x");
    plain.term.input("\r");
    await settle();
    assert.doesNotMatch(screenText(plain.term), /改名为/);
  } finally {
    plain.cleanup();
  }
});

test("验收修改（456 修订）：主视图不显示标题行——会话名与会话号都不在屏上；/rename 照常改名；换绑后同样不显示", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-peer-shell-"));
  const sessionId = newSessionId();
  const target = newSessionId();
  const term = new MockTerminal(90, 30);
  let name = "demo-abcd";
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    sessionName: (id) => (id === sessionId ? name : "target-name"),
    renameSession: (next) => {
      name = next;
      return `本会话改名为 ${next}`;
    },
  });
  try {
    shell.start();
    await settle();
    const screen = () => term.screen.contentLines().join("\n");
    assert.doesNotMatch(screen(), /demo-abcd/);
    assert.ok(!screen().includes(sessionId), "不显示会话号");
    term.input("/rename api-fix");
    term.input("\r");
    await settle();
    assert.match(screen(), /本会话改名为 api-fix/);
    assert.equal(shell.currentSessionName(), "api-fix");
    assert.doesNotMatch(screen(), /== api-fix ==/);
    shell.rebindSession(target, { runtime: new ScriptedRuntime(target) });
    await settle();
    assert.ok(!screen().includes(target), "换绑后同样不显示会话号");
    assert.doesNotMatch(screen(), /target-name/);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
