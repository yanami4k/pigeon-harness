// 决策 286 第 6 项：运行期告警（复盘、压缩、会话存储失败等）在终端界面运行期间落消息区、不写标准错误输出，
// 保留原有的去重与文案；壳接管终端之前与停止之后照旧写标准错误输出。窗口缩放重绘的自动化用例也在此。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { noMcpSession } from "../application/mcp.ts";
import { disposeRuntime } from "../application/runtime.ts";
import { openSessionRuntime } from "../application/session-runtime.ts";
import { sessionDirectoryName } from "../persistence/session-reader.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { registerModelAccess } from "../pi-runtime/model-access.ts";
import { newSessionId } from "../state/ids.ts";
import { emptySettingsSnapshot } from "../state/settings.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import {
  assertWidthsWithin,
  isDimmed,
  MockTerminal,
  screenFlat,
  screenText,
  settle,
} from "./testing.ts";
import { bufferedNotice, switchableWarn } from "./warn-sink.ts";

// 截获标准错误输出（用例结束还原）
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => (process.stderr.write = original) };
}

test("告警出口切换：接管期间交给壳，之前与之后写标准错误输出", () => {
  const stderr = captureStderr();
  const got: string[] = [];
  try {
    const sink = switchableWarn();
    sink.warn("启动告警");
    sink.attach((line) => got.push(line));
    sink.warn("运行期告警");
    sink.detach();
    sink.warn("退出后告警");
  } finally {
    stderr.restore();
  }
  assert.deepEqual(got, ["运行期告警"]);
  assert.deepEqual(stderr.lines, ["启动告警\n", "退出后告警\n"]);
});

test("会话存储告警：终端界面运行期间落消息区、只说一次、不写标准错误输出", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-warn-"));
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // 会话存储要建的子目录位置被一个普通文件占着：每次写都失败
  writeFileSync(join(sessionsDir, sessionDirectoryName(root)), "占位");
  const sink = switchableWarn();
  const sessionId = newSessionId();
  const opened = await openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn: createFakeStreamFn({ replies: [{ text: "一好" }, { text: "二好" }] }),
    flags: { yolo: true, provider: "custom", modelId: "custom", persistThinking: true },
    homeDir: root,
    startMcp: noMcpSession,
    warn: sink.warn,
  });
  const term = new MockTerminal(120, 40);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: opened.bundle.adapter,
    sessionId,
    logDir: join(root, "log"),
  });
  const stderr = captureStderr();
  try {
    shell.start();
    sink.attach((line) => shell.addWarning(line));
    await settle();
    term.input("一");
    term.input("\r");
    await settle(300);
    term.input("二");
    term.input("\r");
    await settle(300);
  } finally {
    stderr.restore();
    shell.stop();
    sink.detach();
    await disposeRuntime(opened.bundle);
    rmSync(root, { recursive: true, force: true });
  }
  const flat = screenFlat(term);
  assert.ok(
    flat.includes("session store warning: opening the session file failed"),
    screenText(term)
  );
  assert.equal(flat.split("session store warning").length - 1, 1, "同一类只说一次");
  assert.ok(flat.includes("二好"), "运行不受影响");
  assert.deepEqual(
    stderr.lines.filter((line) => line.includes("warning")),
    [],
    "运行期间告警不写标准错误输出"
  );
});

test("窗口缩放：变窄后全量重绘，内容仍在、行宽不越界，状态栏仍是一行；再变宽照常", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-resize-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const runtime = new ScriptedRuntime(sessionId);
  runtime.context = { tokens: 60_000, contextWindow: 200_000 };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
  });
  try {
    shell.start();
    await settle();
    const long = "这是一段很长的中文与 English mixed 内容，用来在变窄之后折行。".repeat(3);
    shell.addSystem(long);
    term.input("草稿文字");
    await settle();
    term.resize(40, 30);
    await settle();
    assertWidthsWithin(term, 40);
    const narrow = screenFlat(term).replaceAll(" ", "");
    assert.ok(narrow.includes(long.replaceAll(" ", "")), "消息区内容重绘后零丢失");
    assert.ok(screenText(term).includes("草稿文字"), "输入框内容保留");
    const bars = term.screen.contentLines().filter((line) => line.includes("ctx 30%"));
    assert.equal(bars.length, 1, "状态栏仍是一行");
    term.resize(120, 30);
    await settle();
    assertWidthsWithin(term, 120);
    assert.ok(screenText(term).includes("ctx 30% (60k/200k) · 0 tokens"), "变宽后状态栏恢复全写");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

// 决策 562：档位回落说明是给人看的次要提示——落消息区的系统行（addSystem → secondary 暗色），
// 不走运行期告警那条醒目通道（addWarning → addAlert）
test("VIEWS-062 档位回落说明落消息区的暗色系统行，与醒目告警分开", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-notice-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(120, 30);
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
  try {
    shell.start();
    await settle();
    shell.addSystem('effort "xhigh" is not supported by fake/fake; using "high"');
    term.input("draft");
    await settle();
    assert.ok(screenText(term).includes('effort "xhigh" is not supported'), screenText(term));
    // secondary 的 SGR 序列紧贴在这一行文字前面（暗色），alert 行不带
    assert.ok(
      isDimmed(term.writes.join(""), 'effort "xhigh" is not supported by fake/fake; using "high"'),
      "系统行是暗色"
    );
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

// 决策 562：启动阶段运行面先于壳装配——回落说明先攒着，壳接管后随首屏落进消息区，不先写 stderr
test("VIEWS-062 启动即回落：壳起来之前的说明先缓冲，接管后落暗色系统行", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-tui-notice-startup-"));
  const sessionId = newSessionId();
  const buffer = bufferedNotice();
  const stderr = captureStderr();
  let opened: Awaited<ReturnType<typeof openSessionRuntime>> | undefined;
  try {
    const settings = emptySettingsSnapshot(root);
    opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn: registerModelAccess(createFakeStreamFn({ replies: [{ text: "一" }] }), {
        declared: { reasoning: true },
        catalog: () => ({ reasoning: true, thinkingLevels: ["off", "low", "high", "max"] }),
      }),
      flags: { yolo: true, provider: "fake", modelId: "fake", persistThinking: true },
      settings: { ...settings, merged: { ...settings.merged, thinking: { level: "xhigh" } } },
      homeDir: root,
      startMcp: noMcpSession,
      notice: buffer.notice,
    });
    assert.deepEqual(stderr.lines, [], "壳接管前不写标准错误输出");

    const term = new MockTerminal(120, 30);
    const shell = new PigeonTuiShell({
      terminal: term,
      runtime: opened.bundle.adapter,
      sessionId,
      logDir: join(root, "log"),
    });
    try {
      buffer.attach((line) => shell.addSystem(line));
      shell.start();
      await settle();
      term.input("draft");
      await settle();
      assert.ok(screenText(term).includes('effort "xhigh" is not supported'), screenText(term));
      assert.ok(
        isDimmed(term.writes.join(""), 'effort "xhigh" is not supported by fake/fake'),
        "启动时的回落说明是暗色系统行"
      );
      assert.deepEqual(stderr.lines, [], "接管后也不写标准错误输出");
    } finally {
      shell.stop();
    }
  } finally {
    if (opened !== undefined) await disposeRuntime(opened.bundle);
    stderr.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// 决策 562：壳始终没起来（启动阶段出错退出）——攒下的说明写回标准错误输出，不能丢
test("VIEWS-062 壳始终没起来：攒下的回落说明退出时写回标准错误输出", () => {
  const stderr = captureStderr();
  try {
    const buffer = bufferedNotice();
    buffer.notice('effort "xhigh" is not supported by fake/fake; using "high"');
    assert.deepEqual(stderr.lines, [], "接管前先攒着");
    // main.ts 在进程退出时对同一个出口调 detach
    buffer.detach();
  } finally {
    stderr.restore();
  }
  assert.deepEqual(stderr.lines, ['effort "xhigh" is not supported by fake/fake; using "high"\n']);
});
