// 决策 451、453、454：欢迎头——鸽子与三行字并排、文字与鸽子纵向居中、鸽子不上色；窄终端只留文字、各行不超宽；
// 模型名取模型信息（占位标签时不写）；主目录缩写为 ~；在对话流最上方、随消息滚动，清空消息区后仍在最上方。
// 次要信息（模型、目录、状态栏、状态行、选择器提示）用统一的弱化样式
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { emptyCostTally } from "../application/session-cost.ts";
import { newSessionId } from "../state/ids.ts";
import { MessageFlow } from "./message-flow.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { StatusBar } from "./status-bar.ts";
import { secondary } from "./style.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";
import { modelLabelOf, PIGEON_LOGO, tildePath, WelcomeHeader, welcomeLines } from "./welcome.ts";

const INFO = { version: "0.9.1", model: "deepseek-flash", cwd: "~/code/demo" };
const ESC = "\u001b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plain = (line: string): string => line.replace(SGR, "");

test("欢迎头：鸽子 11 列 × 4 行在左，三行字在右与鸽子纵向居中；名字与版本加粗，模型与目录弱化；鸽子不上色", () => {
  const lines = welcomeLines(INFO, 80);
  // 上下各一行空行，中间 4 行
  assert.equal(PIGEON_LOGO.length, 4);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "");
  assert.equal(lines[5], "");
  const rows = lines.slice(1, 5);
  for (const [index, logo] of PIGEON_LOGO.entries()) {
    assert.equal(visibleWidth(logo), 11);
    assert.ok(plain(rows[index] ?? "").startsWith(` ${logo.trimEnd()}`), rows[index]);
  }
  // 4 行里放 3 行字：第 2 至第 4 行（头顶那一行只有鸽子），文字从同一列起
  assert.equal(plain(rows[0] ?? ""), ` ${PIGEON_LOGO[0]?.trimEnd()}`);
  assert.equal(plain(rows[1] ?? "").slice(14), "Pigeon v0.9.1");
  assert.equal(plain(rows[2] ?? "").slice(14), "deepseek-flash");
  assert.equal(plain(rows[3] ?? "").slice(14), "~/code/demo");
  assert.ok(rows[1]?.includes("\x1b[1mPigeon v0.9.1\x1b[22m"));
  assert.ok(rows[2]?.includes(secondary("deepseek-flash")));
  assert.ok(rows[3]?.includes(secondary("~/code/demo")));
  // 鸽子本身不带任何颜色或样式
  for (const row of rows) {
    const logoPart = row.slice(0, 12);
    assert.doesNotMatch(logoPart, SGR);
  }
});

test("欢迎头：没有模型名时两行字仍居中；窄终端只留文字、按宽度截断，不折行不错位", () => {
  const noModel = welcomeLines({ version: "0.9.1", cwd: "~" }, 80).slice(1, 5).map(plain);
  assert.equal(noModel[1]?.slice(14), "Pigeon v0.9.1");
  assert.equal(noModel[2]?.slice(14), "~");

  // 并排时模型名放不下：只留文字，模型名写全
  assert.deepEqual(welcomeLines(INFO, 27).map(plain), [
    "",
    " Pigeon v0.9.1",
    " deepseek-flash",
    " ~/code/demo",
    "",
  ]);
  // 只留文字也放不下：按宽度截断
  const narrow = welcomeLines(INFO, 12);
  assert.deepEqual(narrow.map(plain), ["", " Pigeon v...", " deepseek...", " ~/code/demo", ""]);
  for (const width of [8, 12, 20, 30, 40]) {
    for (const line of welcomeLines(INFO, width)) {
      assert.ok(visibleWidth(line) <= width, `宽 ${width}：${JSON.stringify(line)}`);
    }
  }
  // 并排但目录太长：只截目录，鸽子照常
  const longCwd = welcomeLines({ ...INFO, cwd: `~/${"x".repeat(80)}` }, 50).map(plain);
  assert.ok(longCwd[2]?.startsWith(` ${PIGEON_LOGO[1]}`));
  assert.ok(longCwd[4]?.endsWith("..."));
  assert.ok(longCwd.every((line) => visibleWidth(line) <= 50));
});

test("RENDERING-058、VIEWS-032 模型名取模型信息：只写型号 id；只有启动参数的占位标签时不写；启动参数给了真名字照写", () => {
  assert.equal(
    modelLabelOf({ provider: "deepseek", id: "deepseek-flash", identity: "declared" }),
    "deepseek-flash"
  );
  assert.equal(modelLabelOf({ provider: "custom", id: "custom", identity: "launch" }), undefined);
  assert.equal(modelLabelOf({ provider: "openai", id: "gpt-5", identity: "launch" }), "gpt-5");
});

test("目录缩写：主目录本身为 ~，主目录之下为 ~ 开头，主目录之外原样", () => {
  const home = join(tmpdir(), "home-x");
  assert.equal(tildePath(home, home), "~");
  assert.equal(tildePath(join(home, "code", "demo"), home), `~${sep}${join("code", "demo")}`);
  assert.equal(tildePath(join(tmpdir(), "elsewhere"), home), join(tmpdir(), "elsewhere"));
  assert.equal(tildePath(join(home, "a"), ""), join(home, "a"));
});

test("欢迎头在对话流最上方、随消息滚动（不常驻）；清空消息区（回退、切换分支）后仍在最上方", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-welcome-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(80, 16);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    welcome: INFO,
  });
  try {
    shell.start();
    await settle();
    const first = screenText(term);
    assert.ok(first.includes("Pigeon v0.9.1"), first);
    assert.ok(first.includes("deepseek-flash"), first);
    // 跑几轮把它顶出屏幕：欢迎头不常驻
    for (let index = 0; index < 4; index += 1) {
      term.input(`第 ${index} 条`);
      term.input("\r");
      await settle();
    }
    assert.ok(!screenText(term).includes("Pigeon v0.9.1"), screenText(term));
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }

  const flow = new MessageFlow();
  flow.addSystem("先来的一行");
  flow.setHeader(new WelcomeHeader(INFO));
  flow.addSystem("后来的一行");
  const before = flow.view.render(80).map(plain).join("\n");
  assert.ok(before.indexOf("Pigeon v0.9.1") < before.indexOf("先来的一行"), before);
  flow.clear();
  flow.addSystem("清空之后");
  const after = flow.view.render(80).map(plain).join("\n");
  assert.ok(after.includes("Pigeon v0.9.1") && !after.includes("先来的一行"), after);
  assert.ok(after.indexOf("Pigeon v0.9.1") < after.indexOf("清空之后"), after);
});

test("次要信息统一弱化：状态栏、状态行与工作收尾行都包在同一种暗色里", async () => {
  const bar = new StatusBar({ cost: emptyCostTally() });
  const [line] = bar.render(80);
  assert.equal(line, ` ${secondary("0 tokens")}`);

  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-welcome-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(80, 20);
  const writes: string[] = [];
  const write = term.write.bind(term);
  term.write = (data: string) => {
    writes.push(data);
    write(data);
  };
  const runtime = new ScriptedRuntime(sessionId);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
  });
  try {
    shell.start();
    await settle();
    // 跑着时状态行写 running（空闲时不写字）
    runtime.autoResolve = false;
    term.input("你好");
    term.input("\r");
    await settle();
    assert.ok(writes.join("").includes(`${ESC}[2m running`), "状态行弱化");
    runtime.finishAll();
    await settle();
    const all = writes.join("");
    assert.match(all, new RegExp(`${ESC}\\[2m done · \\d+s`), "收尾行弱化");
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});
