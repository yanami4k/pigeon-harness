// 决策 450：壳这边的两处——忙闲变化告诉装配方（一轮开始为忙、真正空闲为闲，各一次）；/rename 交给装配方改名（决策 456：改的是
// 会话名），改成了回一行暗色的 "renamed to <名字>"（同 main.ts；主视图不显示会话名，没有这一行就看不出改没改成），名字不合规
// 返回的报错照显示；没给即命令不可用。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { isDimmed, MockTerminal, screenText, settle } from "./testing.ts";

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

test("/rename：交给装配方；改成了写一行暗色结果，返回的报错照显示；没给即命令不可用", async () => {
  const names: string[] = [];
  const { term, cleanup } = makeShell({
    // 同 main.ts 的 renameSession：改成了返回 "renamed to <名字>"，名字不合规返回一行报错
    renameSession: (name) => {
      names.push(name);
      return name.includes("/")
        ? "invalid name: use letters, digits, _, - and . (max 40)"
        : `renamed to ${name}`;
    },
  });
  try {
    await settle();
    term.writes.length = 0;
    term.input("/rename  api-fix ");
    term.input("\r");
    await settle();
    assert.deepEqual(names, ["api-fix"]);
    // 改成了：命令回显之下一行简短结果，暗色
    const lines = screenText(term).split("\n");
    const echo = lines.findIndex((line) => /^\s*> \/rename\s+api-fix\s*$/.test(line));
    assert.ok(echo >= 0, screenText(term));
    assert.ok(
      lines.slice(echo + 1).some((line) => line.trim() === "renamed to api-fix"),
      screenText(term)
    );
    assert.ok(isDimmed(term.writes.join(""), "renamed to api-fix"));
    term.input("/rename a/b");
    term.input("\r");
    await settle();
    assert.deepEqual(names, ["api-fix", "a/b"]);
    assert.match(screenText(term), /invalid name: use letters/);
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
    assert.match(screenText(plain.term), /unknown command: \/rename/);
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
