// 决策 442：/config 设置面板。打开后在布局里列出各项（标签、用户级的值、生效值与覆盖说明），提示行与光标只用 ASCII；
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
import { orchestrationHarness } from "./orchestration-fixtures.ts";
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
      set: (id, value) => {
        const option = CONFIG_OPTIONS.find((item) => item.id === id);
        if (option === undefined || (!option.values.includes(value) && value !== "3")) {
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

test("/config 打开面板：列出各项、生效值与覆盖说明，提示与光标为 ASCII；Enter 轮换值即写用户级并重建，面板刷新", async () => {
  const { term, writes, reloads, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /thinking level/);
    assert.match(screen, /web tools/);
    assert.match(screen, /thinking\.level: /);
    assert.doesNotMatch(screen, /·|→/);
    // 移到"web tools"，Enter 轮换到下一个值（default → true）
    term.input(DOWN);
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["web.enabled=true"]);
    assert.deepEqual(reloads, [[]]);
    const after = screenText(term);
    // 验收修改：面板里改设置不往消息区写行，提示行也不写"已改"——那一项的值当场更新就是反馈
    assert.doesNotMatch(after, /written to|settings reloaded/);
    assert.match(after, /> web tools\s+true/);
    // Esc 关面板：消息区里没有留下改设置的行
    term.input("\x1b");
    await settle();
    assert.doesNotMatch(screenText(term), /web tools|written to|settings reloaded/);
  } finally {
    cleanup();
  }
});

test("矮窗口里打开 /config：面板不被按比例压掉，提示行、选中项与它的说明都在，项多的随选中项滚动", async () => {
  const { term, cleanup } = makeShell({}, {}, 16);
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /settings \(user level/);
    assert.match(screen, /> thinking level/);
    assert.match(screen, /thinking\.level: /);
    // 面板的末行（按键提示）也在——按比例压缩时最先被裁掉的就是它
    assert.match(screen, /Enter\/Space to change/);
    // 往下翻到最后一项：列表跟着滚，选中项与说明照样在
    for (let i = 1; i < CONFIG_OPTIONS.length; i++) term.input(DOWN);
    await settle();
    const last = CONFIG_OPTIONS.at(-1);
    assert.ok(last !== undefined);
    assert.ok(screenText(term).includes(`> ${last.label}`), screenText(term));
    assert.ok(screenText(term).includes(`${last.id}: `), screenText(term));
  } finally {
    cleanup();
  }
});

test("设置面板的可见项数每次画时按 maxRows 现取：变了即重建，选中项保留", () => {
  const panel = new ConfigPanel();
  let rows = CONFIG_OPTIONS.length;
  const items: ConfigItemView[] = CONFIG_OPTIONS.map((option) => ({
    option,
    user: "default",
    effective: "x",
  }));
  panel.open(
    items,
    () => {},
    () => {},
    () => rows
  );
  panel.handleInput(DOWN);
  panel.handleInput(DOWN);
  const third = CONFIG_OPTIONS[2];
  assert.ok(third !== undefined);
  const shown = (lines: string[]): number =>
    lines.filter((line) => CONFIG_OPTIONS.some((option) => line.includes(option.label))).length;
  const before = panel.view.render(100);
  assert.equal(shown(before), CONFIG_OPTIONS.length);
  assert.ok(
    before.some((line) => line.startsWith(`> ${third.label}`)),
    before.join("\n")
  );
  rows = 2;
  const after = panel.view.render(100);
  assert.equal(shown(after), 2, after.join("\n"));
  assert.ok(
    after.some((line) => line.startsWith(`> ${third.label}`)),
    after.join("\n")
  );
});

test("面板打开之后窗口变矮：行数按当前窗口高度现取，选中项保留，按键提示与输入框仍在屏幕上", async () => {
  const { term, cleanup } = makeShell({}, {}, 40);
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    term.input(DOWN);
    term.input(DOWN);
    await settle();
    const third = CONFIG_OPTIONS[2];
    assert.ok(third !== undefined);
    assert.ok(screenText(term).includes(`> ${third.label}`), screenText(term));
    term.resize(110, 15);
    await settle();
    const screen = screenText(term);
    assert.ok(screen.includes(`> ${third.label}`), screen);
    assert.ok(screen.includes(`${third.id}: `), screen);
    assert.match(screen, /Enter\/Space to change/);
    const borders = term.screen.contentLines().filter((line) => /^-{20,}/.test(line));
    assert.equal(borders.length, 2, screen);
  } finally {
    cleanup();
  }
});

test("验收修改：面板里改被别的层覆盖的一项——名字旁标注、提示行写明改用户级不生效，消息区不写；改不成也只写在提示行", async () => {
  const { term, writes, harness, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    const retries = CONFIG_OPTIONS.findIndex((option) => option.id === "modelRequest.maxRetries");
    assert.ok(retries > 0);
    let screen = screenText(term);
    assert.match(screen, /model request retries \(overridden\)/);
    for (let i = 0; i < retries; i++) term.input(DOWN);
    term.input("\r");
    await settle();
    assert.equal(writes.length, 1);
    screen = screenText(term);
    assert.match(screen, /model request retries \(overridden\)/);
    // 哪一层覆盖写在选中项的说明里
    assert.ok(squashSpaces(screenFlat(term)).includes("overriddenbyprojectsettings"), screen);
    // 改不成（有 worker 在跑）：只在提示行说明
    harness.busy = "workers are running";
    term.input("\r");
    await settle();
    assert.equal(writes.length, 1);
    assert.match(screenText(term), /not changed: workers are running/);
    term.input("\x1b");
    await settle();
    assert.doesNotMatch(screenText(term), /overridden|not changed|written to|settings reloaded/);
  } finally {
    cleanup();
  }
});

test("/config 选项=值 直接改；被项目覆盖的另有提醒；值没变不写；值不合法如实报错、不重建", async () => {
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
    // 值没变：不写、不重建、也不说
    assert.equal(reloads.length, 1);
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
    term.input(DOWN);
    term.input("\r");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["web.enabled=true"], "第二次 Enter 在重建期间不改");
    assert.equal(reloads.length, 1);
    assert.match(screenText(term), /running; change settings later/);
    release?.();
    await settle();
    harness.busy = "workers are running";
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["web.enabled=true"], "有 worker 在跑时不写");
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

test("有 worker 在跑时面板开着：↓ 在面板里移动、不跳去 worker 面板，回车改的是面板里选中的那一项", async () => {
  const h = orchestrationHarness();
  const { term, writes, cleanup } = makeShell({ workers: h.face });
  try {
    h.face.spawn({ role: "explorer", task: "看看", name: "w1" });
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    term.input(DOWN);
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["web.enabled=true"]);
    assert.doesNotMatch(screenText(term), /worker w1 \|/);
  } finally {
    await h.stopAll();
    cleanup();
  }
});

test("写拒绝理由时面板不收键；离开主视图即关面板", async () => {
  const h = orchestrationHarness();
  const { shell, term, writes, cleanup } = makeShell({ workers: h.face });
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
    // 打开树形视图（Ctrl+X）：面板关掉
    term.input("\x18");
    await settle();
    term.input("\x18");
    await settle();
    term.input("\r");
    await settle();
    assert.deepEqual(writes, []);
  } finally {
    await h.stopAll();
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
