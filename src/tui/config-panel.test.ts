// 决策 442：/config 设置视图（整屏，见 464）。打开后列出各项（标签、用户级的值，下面常显说明、生效值与覆盖说明）；
// Enter 在可选值间轮换，改一次即写用户级并按 /reload 重建、面板随后刷新；被项目覆盖的项改了另有提醒；/config 选项=值 直接改；
// 值不合法如实报错不重建；Esc 关面板；运行中 /config 被拒。审查修正：重建进行中、有 worker 在跑时不改；读设置出错不崩；
// 面板开着时 ↓ 不跳去 worker 面板；写拒绝理由时面板不收键；离开主视图即关面板；面板开着时排队的输入不发出。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CONFIG_OPTIONS, ConfigError, type ConfigItemView } from "../application/config-options.ts";
import { newSessionId } from "../state/ids.ts";
import { ConfigPanel } from "./config-panel.ts";
import { keybindingRows } from "./keybindings.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell, type TuiShellOptions } from "./shell.ts";
import { MockTerminal, screenFlat, screenText, settle, squashSpaces } from "./testing.ts";

interface Harness {
  user: Map<string, string>;
  busy?: string;
  viewFails?: boolean;
  reloadGate?: Promise<void>;
}

function makeShell(extra: Partial<TuiShellOptions> = {}, state: Partial<Harness> = {}, rows = 50) {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-config-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(110, rows);
  const runtime = new ScriptedRuntime(sessionId);
  const harness: Harness = { user: new Map<string, string>(), ...state };
  const writes: string[] = [];
  const reloads: string[][] = [];
  const view = (): ConfigItemView[] => {
    if (harness.viewFails === true) throw new Error("project settings file is not valid JSON");
    return CONFIG_OPTIONS.map((option) => ({
      option,
      user: harness.user.get(option.id) ?? "default",
      effective: harness.user.get(option.id) ?? `${option.defaultLabel}（缺省）`,
      ...(option.id === "modelRequest.maxRetries" ? { overriddenBy: "project" as const } : {}),
    }));
  };
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime,
    sessionId,
    logDir,
    config: {
      view,
      keys: () => keybindingRows({}),
      set: (id, value) => {
        if (id.startsWith("keybindings:")) {
          writes.push(`${id}=${value}`);
          return "~/.pigeon/settings.json";
        }
        const option = CONFIG_OPTIONS.find((item) => item.id === id);
        if (
          option === undefined ||
          (!option.values.includes(value) && value !== "3" && value !== "default")
        ) {
          throw new ConfigError(`${id} must be one of ${option?.values.join(", ") ?? "?"}`);
        }
        if (harness.user.get(id) === value) return undefined;
        harness.user.set(id, value);
        writes.push(`${id}=${value}`);
        return "~/.pigeon/settings.json";
      },
      busy: () => harness.busy,
    },
    reload: async (args) => {
      reloads.push([...args]);
      await harness.reloadGate;
      return ["settings reloaded: web changed"];
    },
    ...extra,
  });
  shell.start();
  return {
    shell,
    term,
    runtime,
    writes,
    reloads,
    harness,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

test("/config 打开整屏的设置视图：每项下面常显说明、生效值与覆盖说明；Enter 轮换值即写用户级并重建，视图刷新；Esc 回主视图", async () => {
  const { shell, term, writes, reloads, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    assert.equal(shell.currentView(), "config");
    let screen = screenText(term);
    assert.match(screen, /settings \(user level/);
    // 分组：标签行写各组，当前组加方括号；只列当前组的项，每一项的说明都常显（不只选中项），带缺省值
    assert.match(
      screen,
      /\[model\] {2}web {2}context {2}tools {2}guards & hooks {2}workspace {2}interface {2}keys/
    );
    const model = CONFIG_OPTIONS.filter((option) => option.group === "model");
    for (const option of model) {
      assert.ok(screen.includes(option.label), screen);
      assert.ok(squashSpaces(screenFlat(term)).includes(squashSpaces(`${option.id}:`)), option.id);
    }
    assert.doesNotMatch(screen, /web tools/);
    assert.match(screen, /› thinking level +default +default by model/);
    assert.ok(squashSpaces(screenFlat(term)).includes("overriddenbyprojectsettings"), screen);
    // 整屏：没有消息区的输入框
    assert.equal(term.screen.contentLines().filter((line) => /^-{20,}/.test(line)).length, 0);
    assert.doesNotMatch(screen, /·|→/);
    // Enter 轮换到下一个值（default → off）
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["thinking.level=off"]);
    assert.deepEqual(reloads, [[]]);
    const after = screenText(term);
    // 验收修改：视图里改设置不往消息区写行，提示行也不写"已改"——那一项的值当场更新就是反馈
    assert.doesNotMatch(after, /written to|settings reloaded/);
    assert.match(after, /› thinking level\s+off/);
    // → 切到下一组
    term.input(RIGHT);
    await settle();
    screen = screenText(term);
    assert.match(screen, /model {2}\[web\]/);
    assert.match(screen, /› web tools/);
    // Esc 回主视图：消息区里没有留下改设置的行
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "main");
    assert.doesNotMatch(screenText(term), /web tools|written to|settings reloaded/);
  } finally {
    cleanup();
  }
});

test("矮窗口里打开 /config：放不下时跟着选中项滚动，选中项与它的说明都在；窗口变矮照样", async () => {
  const { term, cleanup } = makeShell({}, {}, 12);
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    term.input(RIGHT);
    term.input(RIGHT);
    await settle();
    let screen = screenText(term);
    assert.match(screen, /settings \(user level/);
    assert.match(screen, /\[context\]/);
    assert.match(screen, /› context pruning/);
    const context = CONFIG_OPTIONS.filter((option) => option.group === "context");
    for (let i = 1; i < context.length; i++) term.input(DOWN);
    await settle();
    const last = context.at(-1);
    assert.ok(last !== undefined);
    screen = screenText(term);
    assert.ok(screen.includes(`› ${last.label}`), screen);
    assert.ok(squashSpaces(screenFlat(term)).includes(squashSpaces(`${last.id}:`)), screen);
    assert.doesNotMatch(screen, /› context pruning/);
    term.resize(110, 9);
    await settle();
    screen = screenText(term);
    assert.ok(screen.includes(`› ${last.label}`), screen);
  } finally {
    cleanup();
  }
});

test("设置视图的行数每次画时按高度现取：放得下全列出，放不下只留选中项附近的", () => {
  const panel = new ConfigPanel();
  let height = 100;
  const items: ConfigItemView[] = CONFIG_OPTIONS.filter((option) => option.group === "context").map(
    (option) => ({ option, user: "default", effective: "x" })
  );
  panel.open(
    items,
    () => {},
    () => {},
    () => height
  );
  panel.handleInput(DOWN);
  panel.handleInput(DOWN);
  const third = items[2]?.option;
  assert.ok(third !== undefined);
  const shown = (lines: string[]): number =>
    lines.filter((line) =>
      items.some(
        (item) =>
          line.startsWith(`  ${item.option.label} `) || line.startsWith(`› ${item.option.label} `)
      )
    ).length;
  const before = panel.view.render(200);
  assert.equal(shown(before), items.length);
  assert.ok(
    before.some((line) => line.startsWith(`› ${third.label}`)),
    before.join("\n")
  );
  height = 6;
  const after = panel.view.render(200);
  assert.ok(shown(after) < CONFIG_OPTIONS.length, after.join("\n"));
  assert.ok(
    after.some((line) => line.startsWith(`› ${third.label}`)),
    after.join("\n")
  );
});

test("/config 选项=值 直接改；被项目覆盖的另有提醒；值没变不写、回一行；值不合法如实报错、不重建", async () => {
  const { term, writes, reloads, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config modelRequest.maxRetries=3");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["modelRequest.maxRetries=3"]);
    // 合成一行：写进用户级，被项目共享设置覆盖时写明
    assert.match(
      screenFlat(term),
      /modelRequest\.maxRetries = 3 \(written to user settings, but project settings override it\)/
    );
    assert.doesNotMatch(screenText(term), /settings reloaded/);
    assert.equal(reloads.length, 1);
    const before = screenText(term);
    term.input("/config modelRequest.maxRetries=3");
    term.input("\r");
    await settle();
    // 值没变：不写、不重建，回一行（直接打的命令没有别处可见的变化）
    assert.equal(reloads.length, 1);
    assert.match(
      screenFlat(term),
      /modelRequest\.maxRetries is already 3, but project settings override it/
    );
    assert.equal(
      (screenText(term).match(/written to user settings/g) ?? []).length,
      (before.match(/written to user settings/g) ?? []).length
    );
    term.input("/config web.enabled=maybe");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /not changed: web\.enabled must be one of/);
    assert.equal(reloads.length, 1);
    term.input("/config oops");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /usage: \/config/);
  } finally {
    cleanup();
  }
});

test("运行中 /config 被拒（它会重建运行面）", async () => {
  const { term, runtime, writes, cleanup } = makeShell();
  try {
    await settle();
    runtime.autoResolve = false;
    term.input("跑");
    term.input("\r");
    await settle();
    term.input("/config web.enabled=false");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, []);
    runtime.finishAll();
    await settle();
  } finally {
    cleanup();
  }
});

test("重建还没完时连按 Enter：第二次不改、不并发重建；有 worker 在跑时不改也不写", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { term, writes, reloads, harness, cleanup } = makeShell({}, { reloadGate: gate });
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["thinking.level=off"], "第二次 Enter 在重建期间不改");
    assert.equal(reloads.length, 1);
    assert.match(screenText(term), /running; change settings later/);
    release?.();
    await settle();
    harness.busy = "workers are running";
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["thinking.level=off"], "有 worker 在跑时不写");
    assert.match(screenText(term), /not changed: workers are running/);
  } finally {
    cleanup();
  }
});

test("读设置出错（项目设置文件坏了）：如实说明、不崩，界面照常可用", async () => {
  const { term, runtime, harness, cleanup } = makeShell();
  try {
    await settle();
    harness.viewFails = true;
    term.input("/config");
    term.input("\r");
    await settle();
    assert.match(
      screenText(term),
      /reading settings failed: project settings file is not valid JSON/
    );
    term.input("你好");
    term.input("\r");
    await settle();
    assert.deepEqual(runtime.runs, ["你好"]);
  } finally {
    cleanup();
  }
});

test("写拒绝理由时设置视图不收键", async () => {
  const { shell, term, writes, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    let decided: unknown;
    void shell
      .askApproval({ toolName: "run_command", toolCallId: "c1", args: {} })
      .then((result) => {
        decided = result;
      });
    await settle();
    term.input("r");
    await settle();
    term.input("too risky");
    term.input("\r");
    await settle();
    assert.deepEqual(decided, { key: "r", reason: "too risky" });
    assert.deepEqual(writes, [], "理由里的字母与回车没有改设置");
  } finally {
    cleanup();
  }
});

test("面板开着时排队的输入不发出，关了面板再发", async () => {
  const { shell, term, runtime, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    shell.enqueueInput("排队的一条");
    await settle();
    assert.deepEqual(runtime.runs, [], "面板开着不发");
    term.input("\x1b");
    await settle();
    assert.deepEqual(runtime.runs, ["排队的一条"], "关面板即发出");
  } finally {
    cleanup();
  }
});

test("决策 465：数字项按 Enter 就地输入——非法时视图底部醒目写原因、不写文件；Esc 取消；清空即取缺省", async () => {
  const { shell, term, writes, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    term.input(DOWN);
    term.input("\r");
    await settle();
    assert.match(screenText(term), /› model request retries \(overridden\) +_/);
    term.input("x");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, []);
    assert.match(screenText(term), /not changed: modelRequest\.maxRetries must be one of/);
    // Esc 只取消输入，视图还开着
    term.input("\r");
    term.input("9");
    term.input("\x1b");
    await settle();
    assert.equal(shell.currentView(), "config");
    assert.deepEqual(writes, []);
    term.input("\r");
    term.input("3");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["modelRequest.maxRetries=3"]);
    term.input("\r");
    term.input("\x7f");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["modelRequest.maxRetries=3", "modelRequest.maxRetries=default"]);
  } finally {
    cleanup();
  }
});

test("决策 465：键位组——每个动作的生效键与缺省键；Enter 后下一下按键即绑定（Shift+Tab、Ctrl+X 也能绑），Backspace 清空，Esc 取消，Delete 恢复缺省", async () => {
  const { shell, term, writes, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    // ← 从第一组绕到最后一组（键位）
    term.input(LEFT);
    await settle();
    let screen = screenText(term);
    assert.match(screen, /\[keys\]/);
    assert.match(screen, /› pigeon\.cancel +escape +default escape/);
    term.input("\r");
    await settle();
    assert.match(screenText(term), /press the new key for pigeon\.cancel/);
    term.input("\x1b[Z");
    await settle();
    assert.deepEqual(writes, ["keybindings:pigeon.cancel=shift+tab"]);
    assert.equal(shell.currentView(), "config", "Shift+Tab 归设置视图，没有切审批模式也没离开");
    term.input("\r");
    term.input("\x18");
    await settle();
    assert.equal(writes.at(-1), "keybindings:pigeon.cancel=ctrl+x");
    assert.equal(shell.currentView(), "config");
    term.input("\r");
    term.input("\x7f");
    await settle();
    assert.equal(writes.at(-1), "keybindings:pigeon.cancel=");
    term.input("\r");
    term.input("\x1b");
    await settle();
    assert.equal(writes.length, 3, "Esc 取消");
    term.input("\x1b[3~");
    await settle();
    assert.equal(writes.at(-1), "keybindings:pigeon.cancel=default");
    screen = screenText(term);
    assert.match(screen, /pigeon\.approval\.approve/);
  } finally {
    cleanup();
  }
});
