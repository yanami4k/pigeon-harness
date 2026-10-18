// 决策 439：模型回复按 Markdown 渲染——粗体与行内代码不露出标记、列表与代码块照样排、引用边与分隔线只用 ASCII（不出现
// │ ─ 这类歧义宽字符）；流式逐段生长；控制序列照样先净化（036）。决策 500：行内 $…$ 与独立成块的 $$…$$ 公式转成 Unicode，
// 金额、$HOME 与行内代码里的 $ 不受影响。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { RuntimeEventKind } from "../state/runtime-events.ts";
import { MARKDOWN_OPTIONS, MARKDOWN_THEME } from "./markdown-theme.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

test("模型回复按 Markdown 渲染：标记不露出，引用与分隔线只用 ASCII，金额里的 $ 原样，流式逐段生长", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-md-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(90, 50);
  const runtime = new ScriptedRuntime(sessionId);
  runtime.autoResolve = false;
  const shell = new PigeonTuiShell({ terminal: term, runtime, sessionId, logDir });
  try {
    shell.start();
    await settle();
    term.input("讲讲");
    term.input("\r");
    await settle();
    runtime.emit(RuntimeEventKind.TurnStarted, {});
    runtime.emitDelta("text", "## 结论\n\n这是**重点**与 `code`，费用 $5 到 $10。\n\n");
    await settle();
    assert.match(screenText(term), /这是重点与 code，费用 \$5 到 \$10。/);
    runtime.emitDelta(
      "text",
      "- 第一项\n- 第二项\n\n> 引用一句\n\n---\n\n```ts\nconst x = 1;\n```\n结尾\x1b]52;c;aGk=\x07"
    );
    await settle();
    const screen = screenText(term);
    assert.doesNotMatch(screen, /\*\*|`code`|## /);
    assert.match(screen, /- 第一项/);
    assert.match(screen, /\| 引用一句/);
    assert.match(screen, /^ ?-{10,}/m);
    assert.match(screen, /const x = 1;/);
    assert.doesNotMatch(screen, /[│─]/);
    assert.match(screen, /␛\]52/, "控制序列先净化再渲染");
    const raw = term.writes.join("");
    assert.ok(!raw.includes("\x1b]52;c;aGk="), "原始字节不落终端");
    assert.ok(raw.includes("\x1b[1m"), "粗体由受信主题加上");
    runtime.finishAll();
    await settle();
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

// 按界面用的主题与选项渲染一段，去掉颜色序列
function rendered(text: string): string {
  return stripTerminalSequences(
    new Markdown(text, 0, 0, MARKDOWN_THEME, undefined, MARKDOWN_OPTIONS).render(80).join("\n")
  );
}

test("决策 500：行内公式转成 Unicode，不露出 $ 与命令", () => {
  const out = rendered("矩阵是 $n\\times n$ 的，系数 $\\alpha + \\beta$。");
  assert.match(out, /n\s*×\s*n/);
  assert.match(out, /α\s*\+\s*β/);
  assert.doesNotMatch(out, /\\times|\\alpha|\$/);
});

test("决策 500：独立成块的 $$…$$ 公式转成 Unicode", () => {
  const out = rendered("求和：\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n完。");
  assert.match(out, /∑/);
  assert.doesNotMatch(out, /\\sum|\$\$/);
  assert.match(out, /完。/);
});

test("决策 500：金额、$HOME 与行内代码里的 $ 不受影响", () => {
  const out = rendered("费用 $5 到 $10，变量 $HOME 照写，`echo $x$` 是代码。");
  assert.match(out, /费用 \$5 到 \$10/);
  assert.match(out, /\$HOME/);
  assert.match(out, /echo \$x\$/);
});

// 决策 500：shell 变量里的 $ 不受影响——正文里两个 $ 之间没有空白、后一个 $ 紧跟字母或 { 的写法原样显示，公式照常渲染
test("决策 500：小写变量写法（$src/$dest、$i/$n、带花括号的变量等）原样显示，公式照常渲染", () => {
  // 带花括号的 shell 变量（$ 加 {a}）
  const braced = (name: string) => ["$", "{", name, "}"].join("");
  const cases: Array<[string, string]> = [
    ["cp $src/$dest", "cp $src/$dest"],
    ["$i/$n", "$i/$n"],
    ["$x+$y", "$x+$y"],
    ["PHP: $arr[$key]", "PHP: $arr[$key]"],
    ["($HOME)/$PATH", "($HOME)/$PATH"],
    [`${braced("a")}${braced("b")}`, `${braced("a")}${braced("b")}`],
    [`${braced("a")}-${braced("b")}`, `${braced("a")}-${braced("b")}`],
    ["$a/$b/$c", "$a/$b/$c"],
  ];
  for (const [input, shown] of cases) {
    assert.ok(rendered(input).includes(shown), `${input} => ${rendered(input)}`);
  }
  // 公式不受影响
  assert.match(rendered("矩阵是 $n\\times n$ 的"), /n\s*×\s*n/);
  assert.match(rendered("$\\alpha$ 与 $\\beta$"), /α 与 β/);
  // 代码与转义好的 $ 不动
  assert.ok(rendered("`cp $src/$dest`").includes("cp $src/$dest"));
});
