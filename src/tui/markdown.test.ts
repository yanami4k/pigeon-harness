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

// 审查 H1：判成变量的配对两个 $ 都转义、配不上收尾的 $ 也转义——落单的 $ 不再让 pi-tui 把同一段后文当没写完的公式（粗体、
// 行内代码照常排版）；同一行几对变量各自认
test("决策 500：变量与落单的 $ 之后的粗体、行内代码照常排版；同一行几对变量都原样", () => {
  for (const [input, shown] of [
    ["cp $src/$dest 然后 **注意**", "cp $src/$dest 然后 注意"],
    ["用 $i/$n 表示进度，见 `cfg` 与 **粗**", "用 $i/$n 表示进度，见 cfg 与 粗"],
    ["费用 $5 到 $10，**注意**", "费用 $5 到 $10，注意"],
    ["价格 $5 元，**注意**", "价格 $5 元，注意"],
    ["mv $a/$b to $c/$d", "mv $a/$b to $c/$d"],
    ["cp $src/$dest $a/$b", "cp $src/$dest $a/$b"],
  ] as const) {
    const out = rendered(input);
    assert.ok(out.includes(shown), `${input} => ${out}`);
    assert.doesNotMatch(out, /\*\*|\\/, `${input} => ${out}`);
  }
});

// 审查 H2、L1：照 pi-tui 的配对从左往右认——中文里不留空格的连续公式、公式紧跟字母的写法照常渲染，不多出 $
test("决策 500：中文里不留空格的连续公式与 LaTeX 命令照常渲染", () => {
  for (const input of ["当$n$为偶数时，$f(n)$也是偶数", "设$a$与$b$为实数"]) {
    const out = rendered(input);
    assert.doesNotMatch(out, /\$/, `${input} => ${out}`);
  }
  const greek = rendered("$\\alpha$x$\\beta$");
  assert.match(greek, /α/);
  assert.match(greek, /β/);
  assert.doesNotMatch(greek, /\\alpha|\\beta/);
});

// 审查 M1、M2：缩进代码块、多个反引号的行内代码、网址与链接目标里的 $ 不动（不露出反斜杠）
test("决策 500：缩进代码块、双反引号行内代码、网址与链接目标里的 $ 原样，不露出反斜杠", () => {
  for (const [input, shown] of [
    ["说明：\n\n    cp $src/$dest\n", "cp $src/$dest"],
    ["看 `` $x/$y `` 这段", "$x/$y"],
    ["[接口](http://e.com/$a/$b)", "http://e.com/$a/$b"],
    ["见 https://api.x/y?$filter=a&$top=5 的说明", "https://api.x/y?$filter=a&$top=5"],
  ] as const) {
    const out = rendered(input);
    assert.ok(out.includes(shown), `${input} => ${out}`);
    assert.doesNotMatch(out, /\\\$/, `${input} => ${out}`);
  }
});
