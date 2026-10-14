// 决策 450 + 342：项目的 settings.local.json 被 git 跟踪（随仓库提交）时按共享层对待——收件规则只许它收紧。
// 攻击场景：仓库提交 .pigeon/settings.local.json 写 inbound "accept"，用户级写 "refuse"：仍是 refuse。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { messagingSettings } from "../state/messaging-config.ts";
import { mergeSettingsLayers, messagingSectionOf } from "../state/settings.ts";
import { localSettingsTracked, openSessionSettings } from "./session-settings.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

test("合并：local 层被跟踪时按共享层——只能收紧，放宽不认", () => {
  const layers = [
    { layer: "user" as const, file: { messaging: { inbound: "refuse" as const } } },
    { layer: "local" as const, file: { messaging: { inbound: "accept" as const } } },
  ];
  assert.equal(messagingSettings(mergeSettingsLayers(layers).merged.messaging).inbound, "accept");
  assert.equal(
    messagingSettings(mergeSettingsLayers(layers, { localLayerTracked: true }).merged.messaging)
      .inbound,
    "refuse"
  );
});

test("开会话读设置：仓库提交的 settings.local.json 写 accept 压不过用户级的 refuse；没被跟踪的照常是个人层", async () => {
  const home = temp("pigeon-msg-layers-home-");
  const root = temp("pigeon-msg-layers-repo-");
  mkdirSync(join(home, ".pigeon"), { recursive: true });
  writeFileSync(
    join(home, ".pigeon", "settings.json"),
    JSON.stringify({ messaging: { inbound: "refuse" } })
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, ".pigeon"), { recursive: true });
  writeFileSync(
    join(root, ".pigeon", "settings.local.json"),
    JSON.stringify({ messaging: { inbound: "accept" } })
  );
  const open = () =>
    openSessionSettings(root, {
      homeDir: home,
      confirmation: { kind: "unattended", trustConfig: false },
    });
  // 没被跟踪：个人层，放宽认
  assert.equal(localSettingsTracked(root), false);
  assert.equal(messagingSettings(messagingSectionOf(await open())).inbound, "accept");
  // 提交进仓库：按共享层，放宽不认
  execFileSync("git", ["add", "-f", ".pigeon/settings.local.json"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "local"], { cwd: root });
  assert.equal(localSettingsTracked(root), true);
  assert.equal(messagingSettings(messagingSectionOf(await open())).inbound, "refuse");
});
