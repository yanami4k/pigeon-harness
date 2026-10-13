// 决策 450：终端界面里扣住待放行的消息。面板只收 [y] 放行、[n] 丢弃（[a] 等放权键与 [r] 不起作用）；工具审批要上面板时它让位，
// 稍后重弹；到时限被丢弃的撤下面板；多条逐条弹。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { HeldMessage } from "../application/peer-messaging.ts";
import { newSessionId } from "../state/ids.ts";
import { APPROVAL_YIELDED } from "./approval.ts";
import { HeldPresenter } from "./peer-inbox.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell() {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-peer-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 40);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
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

function held(id: string, text: string): HeldMessage {
  return {
    id,
    from: { sessionId: "s-other", name: "other", cwd: "/work/other", mode: "permissive" },
    text,
    receivedAt: 0,
  };
}

function presenterFor(shell: PigeonTuiShell) {
  const decided: string[] = [];
  const presenter = new HeldPresenter({
    ask: (request) => shell.askApproval(request),
    approve: (id) => decided.push(`approve ${id}`),
    decline: (id) => decided.push(`decline ${id}`),
    retryMs: 20,
  });
  return { presenter, decided };
}

test("扣住的消息弹到面板：写明来源与内容；放权键与 r 不起作用，y 放行、n 丢弃，多条逐条弹", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const { presenter, decided } = presenterFor(shell);
    presenter.held(held("m1", "please look at the failing test"));
    presenter.held(held("m2", "second"));
    await settle();
    const screen = screenText(term);
    assert.match(screen, /别的会话发来的消息（扣住，等你放行）/);
    assert.match(screen, /来自：other（工作目录 \/work\/other）/);
    assert.match(screen, /please look at the failing test/);
    assert.match(screen, /\[y\] 放行 \/ \[n\] 丢弃/);
    for (const key of ["a", "d", "r", "s"]) term.input(key);
    await settle();
    assert.deepEqual(decided, []);
    term.input("y");
    await settle();
    assert.deepEqual(decided, ["approve m1"]);
    assert.match(screenText(term), /second/);
    term.input("n");
    await settle();
    assert.deepEqual(decided, ["approve m1", "decline m2"]);
  } finally {
    cleanup();
  }
});

test("工具审批要上面板时扣住的消息让位，工具审批照常；答完之后消息重弹", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const { presenter, decided } = presenterFor(shell);
    presenter.held(held("m1", "held text"));
    await settle();
    const tool = shell.askApproval({
      toolName: "run_command",
      toolCallId: "c1",
      args: { command: "npm test" },
      tier: "exec",
      command: "npm test",
    });
    await settle();
    assert.match(screenText(term), /工具：run_command/);
    term.input("y");
    assert.deepEqual(await tool, { key: "y" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    assert.match(screenText(term), /held text/);
    term.input("y");
    await settle();
    assert.deepEqual(decided, ["approve m1"]);
  } finally {
    cleanup();
  }
});

test("到时限被丢弃（gone）：面板撤下，不再处理；还在队里的直接移出", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    const { presenter, decided } = presenterFor(shell);
    presenter.held(held("m1", "first"));
    presenter.held(held("m2", "queued"));
    await settle();
    presenter.gone("m2");
    presenter.gone("m1");
    await settle();
    assert.match(screenText(term), /这条扣住的消息已不在/);
    term.input("y");
    await settle();
    assert.deepEqual(decided, []);
  } finally {
    cleanup();
  }
});

test("面板让位时的取消理由是 APPROVAL_YIELDED（presenter 据此重弹）", async () => {
  const { shell, cleanup } = makeShell();
  try {
    await settle();
    const peer = shell.askApproval({
      toolName: "peer_message",
      toolCallId: "p1",
      args: {},
      peerMessage: { from: "x", cwd: "/x", text: "t" },
    });
    await settle();
    void shell.askApproval({ toolName: "read_file", toolCallId: "c2", args: { path: "a" } });
    assert.deepEqual(await peer, { key: "cancel", reason: APPROVAL_YIELDED });
  } finally {
    cleanup();
  }
});
