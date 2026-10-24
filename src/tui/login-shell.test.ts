// 决策 546：/login、/logout 的整屏交互与零凭据时的发送拦截。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { writeProviderKey } from "../persistence/credentials.ts";
import { newSessionId } from "../state/ids.ts";
import { userCredentialsPath } from "../state/paths.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import type { TuiShellOptions } from "./shell.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell(extra: Partial<TuiShellOptions> = {}) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-login-shell-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    ...extra,
  });
  return {
    shell,
    term,
    runtime,
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

test("MODEL-034 without credentials the shell refuses messages and points at /login", async () => {
  const { shell, term, runtime, cleanup } = makeShell({
    sendBlocked: () => "no credentials: run /login to pick a provider and paste its API key",
  });
  try {
    shell.start();
    await settle();
    command(term, "hello");
    await settle();
    assert.deepEqual(runtime.runs, [], "消息没有交给模型");
    assert.match(screenText(term), /run \/login/);
    assert.equal(shell.inputText(), "hello", "文字留在输入框");
  } finally {
    cleanup();
  }
});

test("MODEL-033 /login selects a provider, hides the pasted key and /logout removes it", async () => {
  const submitted: Array<[string, string]> = [];
  const { shell, term, cleanup } = makeShell({
    login: {
      providers: async () => [
        { id: "deepseek", envName: "DEEPSEEK_API_KEY", source: "env", custom: false },
        { id: "mine", source: "file", custom: true },
      ],
      submit: async (provider, key) => {
        submitted.push([provider, key]);
        return `logged in ${provider}`;
      },
      logout: async (provider) => `logged out ${provider}`,
      stored: () => ["deepseek"],
    },
  });
  try {
    shell.start();
    await settle();
    command(term, "/login");
    await settle();
    assert.equal(shell.currentView(), "login");
    assert.match(screenText(term), /deepseek · env \(DEEPSEEK_API_KEY\)/);
    // 第二行是自定义服务商
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    term.input("sk-secret-value");
    await settle();
    assert.doesNotMatch(screenText(term), /sk-secret-value/, "key 不回显");
    assert.match(screenText(term), /\*+/, "只显示星号");
    term.input("\r");
    await settle();
    assert.deepEqual(submitted, [["mine", "sk-secret-value"]]);
    assert.match(screenText(term), /logged in mine/);
    assert.equal(shell.currentView(), "main");

    // /login <provider> 跳过选择，直接粘 key
    command(term, "/login deepseek");
    await settle();
    term.input("sk-second");
    term.input("\r");
    await settle();
    assert.deepEqual(submitted[1], ["deepseek", "sk-second"]);

    // /logout 不带参数列出文件里存着的；带参数删掉
    command(term, "/logout");
    await settle();
    assert.match(screenText(term), /stored credentials: deepseek/);
    command(term, "/logout deepseek");
    await settle();
    assert.match(screenText(term), /logged out deepseek/);
  } finally {
    cleanup();
  }
});

test("MODEL-033 /login and /logout explain they are unavailable in a sandbox session", async () => {
  const { shell, term, cleanup } = makeShell({ sandbox: { exportChanges: async () => "ok" } });
  try {
    shell.start();
    await settle();
    command(term, "/login");
    await settle();
    assert.match(screenText(term), /can't use \/login in a sandbox session/);
    command(term, "/logout deepseek");
    await settle();
    assert.match(screenText(term), /can't use \/logout in a sandbox session/);
  } finally {
    cleanup();
  }
});

test("MODEL-033 Esc leaves the login view without saving", async () => {
  const submitted: string[] = [];
  const { shell, term, cleanup } = makeShell({
    login: {
      providers: async () => [{ id: "deepseek", custom: false }],
      submit: async (provider) => {
        submitted.push(provider);
        return "logged in";
      },
      logout: async () => "logged out",
      stored: () => [],
    },
  });
  try {
    shell.start();
    await settle();
    command(term, "/login");
    await settle();
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.match(screenText(term), /login cancelled/);
    assert.deepEqual(submitted, []);
  } finally {
    cleanup();
  }
});

// 登录 key 加固：只有空白的 key 不写文件；提示重新粘贴
test("MODEL-033 全空白的 key 不写文件，回 paste a key first", async () => {
  const home = mkdtempSync(join(tmpdir(), "pigeon-login-trim-"));
  const { shell, term, cleanup } = makeShell({
    login: {
      providers: async () => [{ id: "deepseek", source: "file", custom: false }],
      submit: async (provider, key) => {
        if (!writeProviderKey(provider, key, { homeDir: home })) return "paste a key first";
        return `logged in ${provider}`;
      },
      logout: async (provider) => `logged out ${provider}`,
      stored: () => [],
    },
  });
  try {
    shell.start();
    await settle();
    command(term, "/login deepseek");
    await settle();
    term.input("   ");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /paste a key first/);
    assert.equal(existsSync(userCredentialsPath(home)), false, "不建凭据文件");
  } finally {
    cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});
