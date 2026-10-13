// 决策 442：/config 设置面板。打开后在布局里列出各项（标签、用户级的值、生效值与覆盖说明），提示行与光标只用 ASCII；
// Enter 在可选值间轮换，改一次即写用户级并按 /reload 重建、面板随后刷新；被项目覆盖的项改了另有提醒；/config 选项=值 直接改；
// 值不合法如实报错不重建；Esc 关面板；运行中 /config 被拒。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CONFIG_OPTIONS, ConfigError, type ConfigItemView } from "../application/config-options.ts";
import { newSessionId } from "../state/ids.ts";
import { ScriptedRuntime } from "./runtime-fixtures.ts";
import { PigeonTuiShell } from "./shell.ts";
import { MockTerminal, screenText, settle } from "./testing.ts";

function makeShell() {
  const logDir = mkdtempSync(join(tmpdir(), "pigeon-tui-config-"));
  const sessionId = newSessionId();
  const term = new MockTerminal(110, 50);
  const runtime = new ScriptedRuntime(sessionId);
  const user = new Map<string, string>();
  const writes: string[] = [];
  const reloads: string[][] = [];
  const view = (): ConfigItemView[] =>
    CONFIG_OPTIONS.map((option) => ({
      option,
      user: user.get(option.id) ?? "default",
      effective: user.get(option.id) ?? `${option.defaultLabel}（缺省）`,
      ...(option.id === "modelRequest.maxRetries" ? { overriddenBy: "project" as const } : {}),
    }));
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
          throw new ConfigError(`${id} 只能是 ${option?.values.join("、") ?? "?"}`);
        }
        user.set(id, value);
        writes.push(`${id}=${value}`);
        return "~/.pigeon/settings.json";
      },
    },
    reload: async (args) => {
      reloads.push([...args]);
      return ["已重读设置"];
    },
  });
  shell.start();
  return {
    term,
    runtime,
    writes,
    reloads,
    cleanup: () => {
      shell.stop();
      rmSync(logDir, { recursive: true, force: true });
    },
  };
}

test("/config 打开面板：列出各项、生效值与覆盖说明，提示与光标为 ASCII；Enter 轮换值即写用户级并重建，面板刷新", async () => {
  const { term, writes, reloads, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config");
    term.input("\r");
    await settle();
    const screen = screenText(term);
    assert.match(screen, /思考档位（thinking\.level）/);
    assert.match(screen, /联网工具（web\.enabled）/);
    assert.doesNotMatch(screen, /·|→/);
    // 移到"联网工具"，Enter 轮换到下一个值（default → true）
    term.input("\x1b[B");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["web.enabled=true"]);
    assert.deepEqual(reloads, [[]]);
    const after = screenText(term);
    assert.match(after, /已写进 ~\/\.pigeon\/settings\.json：web\.enabled = true/);
    assert.match(after, /已重读设置/);
    assert.match(after, /生效值：true/);
    // Esc 关面板
    term.input("\x1b");
    await settle();
    assert.doesNotMatch(
      screenText(term).split("已重读设置").at(-1) ?? "",
      /联网工具（web\.enabled）/
    );
  } finally {
    cleanup();
  }
});

test("/config 选项=值 直接改；被项目覆盖的另有提醒；值不合法如实报错、不重建", async () => {
  const { term, writes, reloads, cleanup } = makeShell();
  try {
    await settle();
    term.input("/config modelRequest.maxRetries=3");
    term.input("\r");
    await settle();
    assert.deepEqual(writes, ["modelRequest.maxRetries=3"]);
    assert.match(screenText(term), /被项目设置覆盖，改用户级不生效/);
    assert.equal(reloads.length, 1);
    term.input("/config web.enabled=maybe");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /没有改：web\.enabled 只能是/);
    assert.equal(reloads.length, 1);
    term.input("/config oops");
    term.input("\r");
    await settle();
    assert.match(screenText(term), /用法：\/config/);
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
