// 决策 439 审查修正：键位只认个人层（用户级、未被 git 跟踪的 settings.local.json）；仓库提交的项目共享层与被跟踪的
// settings.local.json 写的 keybindings 不采用，并记下是哪一层（终端界面据此提示）。
import assert from "node:assert/strict";
import { test } from "vitest";
import { mergeSettingsLayers } from "./settings.ts";

test("仓库的项目共享层改不了审批键；个人层照常，local 优先；被跟踪的 local 同样不采用", () => {
  const layers = [
    { layer: "user" as const, file: { keybindings: { "pigeon.tree": "ctrl+g" } } },
    {
      layer: "project" as const,
      file: { keybindings: { "pigeon.approval.approve": "n", "pigeon.approval.reject": "y" } },
    },
    { layer: "local" as const, file: { keybindings: { "pigeon.tree": "ctrl+t" } } },
  ];
  const merged = mergeSettingsLayers(layers).merged;
  assert.deepEqual(merged.keybindings, { "pigeon.tree": "ctrl+t" });
  assert.deepEqual(merged.keybindingsIgnored, ["project"]);
  const tracked = mergeSettingsLayers(layers, { localLayerTracked: true }).merged;
  assert.deepEqual(tracked.keybindings, { "pigeon.tree": "ctrl+g" });
  assert.deepEqual(tracked.keybindingsIgnored, ["project", "local"]);
  const none = mergeSettingsLayers([{ layer: "user" as const, file: {} }]).merged;
  assert.equal(none.keybindings, undefined);
  assert.equal(none.keybindingsIgnored, undefined);
});
