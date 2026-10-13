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
    assert.match(screenText(term), /用法：\/rename <名字>/);
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

test("决策 456：标题栏写会话名，会话号在后面用弱化样式；改名之后标题栏跟着变；没给名字时只写会话号", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-peer-shell-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const writes: string[] = [];
  const write = term.write.bind(term);
  term.write = (data: string) => {
    writes.push(data);
    write(data);
  };
  let name = "demo-abcd";
  const holder: { shell?: PigeonTuiShell } = {};
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    sessionName: () => name,
    renameSession: (next) => {
      name = next;
      holder.shell?.refreshTitle();
      return `本会话改名为 ${next}`;
    },
  });
  holder.shell = shell;
  try {
    shell.start();
    await settle();
    const title = term.screen.contentLines().find((line) => line.trim() !== "") ?? "";
    assert.equal(title.trim(), `== demo-abcd == ${sessionId}`);
    assert.ok(writes.join("").includes(`\u001b[2m${sessionId}\u001b[22m`), "会话号用弱化样式");
    term.input("/rename api-fix");
    term.input("\r");
    await settle();
    const renamed = term.screen.contentLines().find((line) => line.trim() !== "") ?? "";
    assert.equal(renamed.trim(), `== api-fix == ${sessionId}`);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("决策 456：换绑到别的会话时标题按新会话取名，不去取旧会话的名字（取名可能要读整个会话文件）", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-peer-shell-"));
  const sessionId = newSessionId();
  const target = newSessionId();
  const term = new MockTerminal(90, 30);
  const asked: string[] = [];
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    sessionName: (id) => {
      asked.push(id);
      return id === target ? "target-name" : "old-name";
    },
  });
  try {
    shell.start();
    await settle();
    asked.length = 0;
    shell.rebindSession(target, { runtime: new ScriptedRuntime(target) });
    await settle();
    assert.ok(asked.length > 0 && asked.every((id) => id === target), asked.join(", "));
    const title = term.screen.contentLines().find((line) => line.trim() !== "") ?? "";
    assert.equal(title.trim(), `== target-name == ${target}`);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
