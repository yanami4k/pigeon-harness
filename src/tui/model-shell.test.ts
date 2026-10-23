// 决策 550：/model 的整屏列表、直接给 provider/model、沙箱不可用与 Esc 退出。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import type { TuiShellOptions } from "./shell.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-model-shell-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    ...extra,
  });
  return {
    shell,
    term,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

function command(term: MockTerminal, text: string): void {
  term.input(text);
  term.input("\r");
}

test("MODEL-039 /model lists the credentialed packaged models and switches from the list", async () => {
  const applied: Array<[string, string]> = [];
  const { shell, term, cleanup } = makeShell({
    models: {
      list: async () => [
        { provider: "deepseek", id: "deepseek-chat", contextWindow: 200_000 },
        { provider: "deepseek", id: "deepseek-v4-pro" },
      ],
      apply: async (provider, id) => {
        applied.push([provider, id]);
        return `model set to ${provider}/${id} (from the next request)`;
      },
    },
  });
  try {
    shell.start();
    await settle();
    command(term, "/model");
    await settle();
    assert.equal(shell.currentView(), "model");
    assert.match(screenText(term), /> deepseek\/deepseek-chat · 200k/);
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.deepEqual(applied, [["deepseek", "deepseek-v4-pro"]]);
    assert.equal(shell.currentView(), "main");
    assert.match(
      screenText(term),
      /model set to deepseek\/deepseek-v4-pro \(from the next request\)/
    );
  } finally {
    cleanup();
  }
});

test("MODEL-039 /model <provider>/<id> switches directly, also for a custom provider", async () => {
  const applied: Array<[string, string]> = [];
  const { shell, term, cleanup } = makeShell({
    models: {
      list: async () => [],
      apply: async (provider, id) => {
        applied.push([provider, id]);
        return `model set to ${provider}/${id} (from the next request)`;
      },
    },
  });
  try {
    shell.start();
    await settle();
    command(term, "/model mine/custom-model");
    await settle();
    assert.deepEqual(applied, [["mine", "custom-model"]]);
    assert.match(screenText(term), /model set to mine\/custom-model/);
    // 参数不是 provider/model 即给用法
    command(term, "/model nope");
    await settle();
    assert.match(screenText(term), /usage: \/model \[provider\/model\]/);
    assert.equal(applied.length, 1);
  } finally {
    cleanup();
  }
});

test("MODEL-039 /model in a sandbox session explains it is unavailable", async () => {
  const sandbox = makeShell({ sandbox: { exportChanges: async () => "ok" } });
  try {
    sandbox.shell.start();
    await settle();
    command(sandbox.term, "/model");
    await settle();
    assert.match(screenText(sandbox.term), /can't use \/model in a sandbox session/);
  } finally {
    sandbox.cleanup();
  }
});

test("MODEL-039 Esc closes the model list without switching", async () => {
  const applied: string[] = [];
  const { shell, term, cleanup } = makeShell({
    models: {
      list: async () => [{ provider: "deepseek", id: "deepseek-chat" }],
      apply: async (provider, id) => {
        applied.push(`${provider}/${id}`);
        return "model set";
      },
    },
  });
  try {
    shell.start();
    await settle();
    command(term, "/model");
    await settle();
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.match(screenText(term), /model switch cancelled/);
    assert.deepEqual(applied, []);
  } finally {
    cleanup();
  }
});
