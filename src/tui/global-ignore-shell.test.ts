// 决策 444 走终端界面提交路径：输入历史先于会话文件写（不带提示口），会话文件建出时带提示口——全局排除文件那一行提示仍到
// 消息区；只敲斜杠命令就退出不留 .pigeon。真实运行面（推迟建会话文件）+ 真实输入历史 + git 仓库；全局配置与 XDG 由测试总装
// 指到临时位置。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { noMcpSession } from "../application/mcp.ts";
import { promptHistoryStore } from "../application/prompt-history.ts";
import { disposeRuntime } from "../application/runtime.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { globalExcludesFile, resetGlobalIgnoreMemo } from "../persistence/global-ignore.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const dirs: string[] = [];
afterEach(() => {
  resetGlobalIgnoreMemo();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function openShell(root: string) {
  const warnings: string[] = [];
  const sessionId = newSessionId();
  const opened = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn: createFakeStreamFn({ replies: [{ text: "好" }] }),
    flags: {
      yolo: true,
      provider: "custom",
      modelId: "custom",
      persistThinking: true,
      pushedMemory: false,
    },
    deferSessionFile: true,
    warn: (line) => warnings.push(line),
    homeDir: temp("pigeon-gi-shell-home-"),
    startMcp: noMcpSession,
  });
  const term = new MockTerminal(100, 30);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: opened.bundle.adapter,
    sessionId,
    logDir: temp("pigeon-gi-shell-log-"),
    promptHistory: promptHistoryStore(root),
  });
  return { shell, term, bundle: opened.bundle, warnings };
}

function gitRepo(): string {
  const root = temp("pigeon-gi-shell-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

test("决策 444：终端界面里发第一条消息——先写输入历史、后建会话文件，写进全局排除文件的那一行提示照样给出", async () => {
  const root = gitRepo();
  const file = globalExcludesFile(root) ?? "";
  assert.ok(realpathSync.native(tmpdir()) !== "" && file.includes("pigeon-test-gitenv-"), file);
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const { shell, term, bundle, warnings } = await openShell(root);
  try {
    shell.start();
    await settle();
    term.input("你好");
    term.input("\r");
    await settle(300);
    await bundle.sessionStore.flush();
    assert.ok(existsSync(join(root, ".pigeon", "state", "tui-history.json")), "输入历史写了");
    assert.ok(existsSync(join(root, ".pigeon", "state", "sessions")), "会话文件建了");
    const after = readFileSync(file, "utf8");
    assert.notEqual(after, before);
    assert.ok(
      warnings.some((line) => line.includes("已在 git 全局排除文件")),
      `${warnings.join("\n")}\n${screenText(term)}`
    );
  } finally {
    shell.stop();
    await disposeRuntime(bundle);
  }
});

test("决策 444：只敲斜杠命令（不发消息）就退出，不建 .pigeon、不写全局排除文件", async () => {
  const root = gitRepo();
  const file = globalExcludesFile(root) ?? "";
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const { shell, term, bundle } = await openShell(root);
  try {
    shell.start();
    await settle();
    term.input("/search");
    term.input("\r");
    await settle(200);
  } finally {
    shell.stop();
    await disposeRuntime(bundle);
  }
  assert.equal(existsSync(join(root, ".pigeon")), false);
  assert.equal(existsSync(file) ? readFileSync(file, "utf8") : "", before);
});
