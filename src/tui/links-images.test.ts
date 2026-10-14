// 决策 439：网址与绝对路径在支持超链接的终端里输出成 OSC 8 链接（句末标点不算进去、相对路径与词中的斜杠不算）；不支持时原样。
// 工具结果里的图片块进消息区：不能显示图片的终端退回一行文字占位；控制序列照样先净化。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { linkify } from "./message-flow.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

const original = getCapabilities();
afterEach(() => {
  setCapabilities(original);
});

test("链接：网址与绝对路径加 OSC 8，句末标点留在外面；相对路径、词中斜杠不加；终端不支持时原样", () => {
  const st = "\x1b\\";
  const winPath = ["C:", "w", "b.md"].join(String.fromCharCode(92));
  const text = `见 https://example.com/a?b=1。 文件 /tmp/x.ts, 还有 src/a.ts 与 ${winPath}`;
  const linked = linkify(text, true);
  assert.ok(
    linked.includes(
      `\x1b]8;;https://example.com/a?b=1${st}https://example.com/a?b=1\x1b]8;;${st}。`
    )
  );
  assert.ok(linked.includes(`/tmp/x.ts\x1b]8;;${st},`), "句末逗号留在链接外");
  assert.ok(!linked.includes("]8;;file:///src/a.ts") && !linked.includes("]8;;file:///a.ts"));
  assert.ok(linked.includes(`${winPath}\x1b]8;;${st}`));
  assert.equal(linkify(text, false), text);
  // 网址后紧跟英文句号：句号不算进链接
  const dotted = linkify("see https://example.com/x.", true);
  assert.ok(dotted.includes(`https://example.com/x\x1b]8;;${st}.`), dotted);
});

test("工具结果里的图片：不能显示图片的终端退回文字占位", async () => {
  setCapabilities({ ...original, images: null });
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-img-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 30);
  const runtime = new ScriptedRuntime(sessionId);
  runtime.autoResolve = false;
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
  try {
    shell.start();
    await settle();
    term.input("看图");
    term.input("\r");
    await settle();
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.toolResult({
      toolCallId: "c1",
      toolName: "read_file",
      isError: false,
      text: "image/png 68 bytes",
      details: {},
      images: [
        {
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    });
    await settle();
    assert.match(screenText(term), /\[Image/i);
    runtime.finishAll();
    await settle();
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
