// 决策 439：键位表。缺省键位与改用之前一致；设置可按动作名改键（含 pi-tui 部件的 tui.*）；未知动作名与 Pigeon 动作之间的
// 冲突在消息区提示；全屏缺省改动（Home/End 留给输入框、F3 也开搜索）；设置文件里 keybindings 的键须是动作名的样子。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { newSessionId } from "../state/ids.ts";
import { validateSettingsLayer } from "../state/settings.ts";
import { ConfigPanel } from "./config-panel.ts";
import { installKeybindings, isKey, keybindingRows } from "./keybindings.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

afterEach(() => {
  installKeybindings();
});

test("缺省键位与改用之前逐个一致", () => {
  installKeybindings();
  assert.ok(isKey("\x1b", "pigeon.cancel"));
  assert.ok(isKey("\x03", "pigeon.exit"));
  assert.ok(isKey("\x0f", "pigeon.toggleToolOutput"));
  assert.ok(isKey("\x18", "pigeon.tree"));
  assert.ok(isKey("\x1bq", "pigeon.dequeue"));
  for (const [key, id] of [
    ["y", "pigeon.approval.approve"],
    ["N", "pigeon.approval.reject"],
    ["r", "pigeon.approval.rejectWithReason"],
    ["a", "pigeon.approval.grant"],
    ["d", "pigeon.approval.grantDirectory"],
    ["s", "pigeon.approval.scriptKind"],
  ] as const) {
    assert.ok(isKey(key, id), `${key} → ${id}`);
  }
  const keys = getKeybindings();
  assert.deepEqual(keys.getKeys("tui.altScreen.top"), ["ctrl+home"]);
  assert.deepEqual(keys.getKeys("tui.altScreen.bottom"), ["ctrl+end"]);
  assert.deepEqual(keys.getKeys("tui.altScreen.search"), ["ctrl+shift+f", "f3"]);
  assert.ok(keys.getKeys("tui.editor.cursorLineStart").includes("home"));
});

test("按动作名改键：Pigeon 的动作与 pi-tui 部件的都能改；空数组即取消", () => {
  const notices = installKeybindings({
    "pigeon.toggleToolOutput": "ctrl+t",
    "tui.altScreen.search": [],
  });
  assert.deepEqual(notices, []);
  assert.ok(isKey("\x14", "pigeon.toggleToolOutput"));
  assert.ok(!isKey("\x0f", "pigeon.toggleToolOutput"));
  assert.deepEqual(getKeybindings().getKeys("tui.altScreen.search"), []);
});

test("未知的动作名与 Pigeon 动作之间的冲突给出提示行；终端界面开局写进消息区", async () => {
  const notices = installKeybindings({
    "pigeon.nope": "ctrl+k",
    "pigeon.tree": "ctrl+o",
  });
  assert.ok(notices.some((line) => /unknown action pigeon\.nope/.test(line)));
  assert.ok(notices.some((line) => /keybinding conflict: ctrl\+o/.test(line)));
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-keys-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(100, 30);
  const shell = new PigeonTuiShell({
    terminal: term,
    runtime: new ScriptedRuntime(sessionId),
    sessionId,
    logDir,
    keybindings: { "pigeon.nope": "ctrl+k" },
  });
  try {
    shell.start();
    await settle();
    assert.match(screenText(term), /unknown action pigeon\.nope/);
  } finally {
    shell.stop();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("设置文件：keybindings 的键须是动作名的样子（pigeon.* 或 tui.*），值为键或键的数组", () => {
  const source = { layer: "user" as const, file: "/home/u/.pigeon/settings.json" };
  const ok = validateSettingsLayer(
    { keybindings: { "pigeon.tree": "ctrl+g", "tui.editor.undo": ["ctrl+z"] } },
    source
  );
  assert.ok("file" in ok, JSON.stringify(ok));
  const bad = validateSettingsLayer({ keybindings: { toggle: "ctrl+g" } }, source);
  assert.ok("problems" in bad && /is not an action name/.test(bad.problems.join("")));
  const badValue = validateSettingsLayer({ keybindings: { "pigeon.tree": 3 } }, source);
  assert.ok("problems" in badValue);
});

test("决策 465：设置视图的键位组——Pigeon 动作在前；两个 Pigeon 动作绑了同一个键，两行都标出冲突（醒目）；新动作在缺省表里", () => {
  installKeybindings({ "pigeon.tree": "ctrl+o" });
  try {
    const rows = keybindingRows({ "pigeon.tree": "ctrl+o" });
    assert.ok(rows[0]?.action.startsWith("pigeon."));
    const tree = rows.find((row) => row.action === "pigeon.tree");
    const output = rows.find((row) => row.action === "pigeon.toggleToolOutput");
    assert.deepEqual(tree?.conflicts, ["pigeon.toggleToolOutput"]);
    assert.deepEqual(output?.conflicts, ["pigeon.tree"]);
    assert.equal(tree?.userSet, true);
    assert.deepEqual(tree?.defaults, ["ctrl+x"]);
    const mode = rows.find((row) => row.action === "pigeon.toggleMode");
    assert.deepEqual(mode?.keys, ["shift+tab"]);
    assert.deepEqual(rows.find((row) => row.action === "pigeon.openPanel")?.keys, ["left"]);
    assert.deepEqual(rows.find((row) => row.action === "tui.editor.cursorLeft")?.conflicts, []);
    const panel = new ConfigPanel();
    panel.open(
      [],
      () => {},
      () => {},
      () => 200,
      () => rows
    );
    const raw = panel.view.render(160).join("\n");
    assert.ok(raw.includes("\x1b[31mconflicts with pigeon.toggleToolOutput"), raw);
  } finally {
    installKeybindings(undefined);
  }
});
