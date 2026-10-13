// 决策 450：收件规则 messaging.inbound 的分层——只有用户级与项目个人层能放宽，仓库提交的项目共享层只能收紧。
import assert from "node:assert/strict";
import { test } from "vitest";
import { layeredInbound, messagingSettings } from "./messaging-config.ts";
import { mergeSettingsLayers } from "./settings.ts";

test("项目共享层不能放宽：用户级 refuse、仓库写 accept 仍是 refuse；没有个人设置时仓库的 accept 不认", () => {
  assert.equal(
    layeredInbound([
      { layer: "user", inbound: "refuse" },
      { layer: "project", inbound: "accept" },
    ]),
    "refuse"
  );
  assert.equal(layeredInbound([{ layer: "project", inbound: "accept" }]), undefined);
  assert.equal(
    layeredInbound([
      { layer: "user", inbound: "hold" },
      { layer: "project", inbound: "auto" },
    ]),
    "hold"
  );
});

test("项目共享层能收紧；个人层（用户级、settings.local.json）怎么写都认，后者优先", () => {
  assert.equal(layeredInbound([{ layer: "project", inbound: "hold" }]), "hold");
  assert.equal(
    layeredInbound([
      { layer: "user", inbound: "accept" },
      { layer: "project", inbound: "refuse" },
    ]),
    "refuse"
  );
  assert.equal(
    layeredInbound([
      { layer: "user", inbound: "refuse" },
      { layer: "local", inbound: "accept" },
    ]),
    "accept"
  );
});

test("三层合并按这个规则取 inbound，holdMinutes 照常合并", () => {
  const merged = mergeSettingsLayers([
    { layer: "user", file: { messaging: { inbound: "refuse" } } },
    { layer: "project", file: { messaging: { inbound: "accept", holdMinutes: 2 } } },
  ]).merged;
  assert.deepEqual(messagingSettings(merged.messaging), { inbound: "refuse", holdMs: 120_000 });
  const sharedOnly = mergeSettingsLayers([
    { layer: "project", file: { messaging: { inbound: "accept" } } },
  ]).merged;
  assert.equal(messagingSettings(sharedOnly.messaging).inbound, "auto");
});
