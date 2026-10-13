// S5 审查修正：查找框开着时审批面板不收字母；kitty 键盘协议的松键与重复不算按键；复制后清选区；右键粘贴在面板挂着时不收；
// 图片的类型与数据校验；审批提示按实际键位；退出打印去掉行尾空格；链接扫描是线性的；Markdown 链接显示网址；点链接只开
// http/https/file；终端复位。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCapabilities,
  Markdown,
  setCapabilities,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { openExternalUrl, trimLineEnd } from "./alt-screen.ts";
import { approvalKeyLabels } from "./approval.ts";
import { installKeybindings } from "./keybindings.ts";
import { MARKDOWN_OPTIONS, MARKDOWN_THEME, revealLinkTargets } from "./markdown-theme.ts";
import { checkedImage, linkify } from "./message-flow.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { installTerminalReset, TERMINAL_RESET } from "./terminal-reset.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const capabilities = getCapabilities();
afterEach(() => {
  setCapabilities(capabilities);
  installKeybindings();
});

function makeShell(extra: Partial<TuiShellOptions> = {}, rows = 30) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-review-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, rows);
  const runtime = new ScriptedRuntime(sessionId);
  let exits = 0;
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    onExit: () => {
      exits += 1;
    },
    ...extra,
  });
  shell.start();
  return {
    shell,
    term,
    runtime,
    exits: () => exits,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("审批挂着时打开查找框：键入查找框的字母不被审批面板拿去作答；关了查找框再按 y 才批准", async () => {
  const { shell, term, cleanup } = makeShell();
  try {
    await settle();
    let decided: unknown;
    const panel = shell.askApproval({
      toolName: "write_file",
      toolCallId: "c1",
      args: { path: "a.txt" },
    });
    void panel.then((result) => {
      decided = result;
    });
    await settle();
    term.input("\x1bOR");
    await settle();
    for (const ch of "deploy") term.input(ch);
    await settle();
    assert.equal(decided, undefined, "查找框里的 d 与 y 都不作答");
    term.input("\x1b");
    await settle();
    term.input("y");
    await settle();
    assert.deepEqual(decided, { key: "y" });
  } finally {
    cleanup();
  }
});

test("kitty 键盘协议：Ctrl+C 的松键不算第二下（不退出）；运行中关查找框的 Esc 松键不取消这一轮", async () => {
  const { term, runtime, exits, cleanup } = makeShell();
  try {
    await settle();
    term.input("\x1b[99;5u");
    term.input("\x1b[99;5:3u");
    await settle();
    assert.equal(exits(), 0, "按一次 Ctrl+C 不退出");
    assert.match(screenText(term), /\[cleared\]/);
    runtime.autoResolve = false;
    term.input("跑");
    term.input("\r");
    await settle();
    term.input("\x1bOR");
    await settle();
    term.input("\x1b[27u");
    term.input("\x1b[27;1:3u");
    await settle();
    assert.equal(runtime.interrupts, 0, "Esc 关了查找框，松键不取消");
    // 按住重复也不算
    term.input("\x1b[27;1:2u");
    await settle();
    assert.equal(runtime.interrupts, 0);
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
});

test("拖选后 Ctrl+C 复制并清掉选区：下一次 Ctrl+C 照常清输入", async () => {
  const { term, exits, cleanup } = makeShell({}, 16);
  try {
    await settle();
    term.input("draft");
    term.input("\x1b[<0;4;12M");
    term.input("\x1b[<32;20;12M");
    await settle();
    term.input("\x03");
    await settle(150);
    assert.doesNotMatch(screenText(term), /\[cleared\]/);
    term.input("\x03");
    await settle();
    assert.match(screenText(term), /\[cleared\]/, "选区已清，这一下是清输入");
    assert.equal(exits(), 0);
  } finally {
    cleanup();
  }
});

test("右键粘贴：审批面板挂着时不收", async () => {
  const reads: string[] = [];
  const { shell, term, runtime, cleanup } = makeShell({
    readClipboard: async () => {
      reads.push("read");
      return "rm -rf /";
    },
  });
  try {
    await settle();
    void shell.askApproval({ toolName: "run_command", toolCallId: "c1", args: {} });
    await settle();
    // 右键按下（SGR 鼠标，按键 2）
    term.input("\x1b[<2;5;5M");
    await settle(200);
    assert.doesNotMatch(screenText(term), /rm -rf/);
    assert.deepEqual(runtime.runs, []);
  } finally {
    cleanup();
  }
});

test("图片：只认 png/jpeg/gif/webp 与严格 base64；不合格的只显示固定占位，不把对方给的类型写进终端", async () => {
  assert.deepEqual(checkedImage({ data: "QUJD", mimeType: "IMAGE/JPG" }), {
    data: "QUJD",
    mimeType: "image/jpeg",
  });
  assert.equal(checkedImage({ data: "QUJD", mimeType: "image/svg+xml" }), undefined);
  assert.equal(checkedImage({ data: "QUJ", mimeType: "image/png" }), undefined);
  assert.equal(checkedImage({ data: "QU\nJD", mimeType: "image/png" }), undefined);
  setCapabilities({ ...capabilities, images: null });
  const { term, runtime, cleanup } = makeShell();
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("看");
    term.input("\r");
    await settle();
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.toolResult({
      toolCallId: "c1",
      toolName: "mcp_tool",
      isError: false,
      text: "",
      details: {},
      images: [{ data: "QUJD", mimeType: "image/png\x1b]0;X\x07\x1b[2J" }],
    });
    await settle();
    assert.match(screenText(term), /\[image: 不能显示（类型或数据不认得）\]/);
    assert.ok(!term.writes.join("").includes("\x1b]0;X"));
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
});

test("审批提示按实际生效的键位写", () => {
  installKeybindings({ "pigeon.approval.approve": "j", "pigeon.approval.reject": ["k", "x"] });
  assert.equal(
    approvalKeyLabels("批准执行？[y] 批准一次 / [n] 拒绝 / [r] 拒绝并说明"),
    "批准执行？[j] 批准一次 / [k/x] 拒绝 / [r] 拒绝并说明"
  );
});

test("退出打印去掉行尾补齐的空格，行尾的样式复位留着", () => {
  assert.equal(trimLineEnd("abc   "), "abc");
  assert.equal(trimLineEnd("abc   \x1b[0m"), "abc\x1b[0m");
  assert.equal(trimLineEnd("  "), "");
});

test("链接扫描是线性的：5 万个 +/ 与 2 万字的一段都很快", () => {
  const started = Date.now();
  linkify("+/".repeat(50_000), true);
  linkify(`${"/a".repeat(10_000)} 和 https://example.com/x`, true);
  assert.ok(Date.now() - started < 500, `${Date.now() - started}ms`);
});

test("Markdown 链接：文字与网址不同时把网址也显示出来；相同的、代码里的不动", () => {
  assert.equal(
    revealLinkTargets("看[这里](https://evil.example/x)。"),
    "看[这里](https://evil.example/x) (<https://evil.example/x>)。"
  );
  assert.equal(
    revealLinkTargets("[https://a.example](https://a.example)"),
    "[https://a.example](https://a.example)"
  );
  assert.equal(revealLinkTargets("`[x](https://a)`"), "`[x](https://a)`");
  assert.equal(revealLinkTargets("```\n[x](https://a)\n```"), "```\n[x](https://a)\n```");
  setCapabilities({ ...capabilities, hyperlinks: true });
  const rendered = new Markdown(
    "[点我](https://evil.example/x)",
    0,
    0,
    MARKDOWN_THEME,
    undefined,
    MARKDOWN_OPTIONS
  )
    .render(80)
    .join("\n");
  assert.ok(rendered.includes("https://evil.example/x"));
  // 去掉 OSC 8 序列后，网址仍以可见文字出现
  const visible = stripTerminalSequences(rendered);
  assert.ok(visible.includes("https://evil.example/x"), visible);
});

test("点链接只开 http、https 与 file，参数固定、不经 shell", () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run = (file: string, args: string[]) => calls.push({ file, args });
  assert.equal(openExternalUrl("https://example.com/a b", run), true);
  assert.equal(openExternalUrl("javascript:alert(1)", run), false);
  assert.equal(openExternalUrl("ms-settings:privacy", run), false);
  assert.equal(openExternalUrl("not a url", run), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args.at(-1), "https://example.com/a%20b");
});

test("终端复位：未捕获的异常时写一次复位序列并报错退出；正常收尾之后不再写", () => {
  const listeners = new Map<string, (error?: unknown) => void>();
  const proc = {
    on: (event: string, listener: (error?: unknown) => void) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
  };
  const writes: string[] = [];
  const reports: unknown[] = [];
  const exits: number[] = [];
  const handle = installTerminalReset(
    (data) => writes.push(data),
    (error) => reports.push(error),
    (code) => exits.push(code),
    proc
  );
  listeners.get("uncaughtException")?.(new Error("boom"));
  listeners.get("exit")?.();
  assert.deepEqual(writes, [TERMINAL_RESET], "只写一次");
  assert.equal(exits[0], 1);
  assert.match(String(reports[0]), /boom/);
  assert.ok(TERMINAL_RESET.includes("\x1b[?1049l") && TERMINAL_RESET.includes("\x1b[?25h"));
  handle.dispose();
  assert.equal(listeners.size, 0);
  const clean: string[] = [];
  const second = installTerminalReset(
    (data) => clean.push(data),
    () => undefined,
    () => undefined,
    proc
  );
  second.markClean();
  listeners.get("exit")?.();
  assert.deepEqual(clean, []);
  second.dispose();
});
