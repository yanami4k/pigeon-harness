// 单轮输出上限装配（决策 063 第 1 件、347）：配置了才在装配层包装 streamFn——模型调用收到配置值，上限值写进注入快照
// model 段与会话存储 Run 开始条目的 model 摘要；未配置不包装（模型调用不带 maxTokens，由接入按模型上限发），两处都不写。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { runHeadless } from "./headless-core.ts";

function recording() {
  const seen: unknown[] = [];
  const fake = createFakeStreamFn({ replies: [{ text: "好" }] });
  const streamFn: StreamFn = (model, context, options) => {
    seen.push(options?.maxTokens);
    return fake(model, context, options);
  };
  return { seen, streamFn };
}

for (const [label, maxOutputTokens, expected] of [
  ["未配置", undefined, undefined],
  ["配置 4096", 4096, 4096],
] as const) {
  test(`输出上限装配（${label}）：模型调用收到 maxTokens ${expected}，Run 开始条目的 model 摘要照此记或不记`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pigeon-output-limit-"));
    const home = mkdtempSync(join(tmpdir(), "pigeon-output-limit-home-"));
    try {
      const { seen, streamFn } = recording();
      const result = await runHeadless({
        task: "你好",
        governanceRoot: root,
        workspaceRoot: root,
        streamFn,
        yolo: true,
        homeDir: home,
        skillRoots: [],
        agentsMd: false,
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      });
      assert.deepEqual(seen, [expected]);
      const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), result.sessionId);
      assert.ok(loaded !== undefined, "会话存储里应有本会话");
      assert.equal(loaded.view.runs.length, 1);
      assert.equal(loaded.view.runs[0]?.start.model.maxOutputTokens, expected);
      assert.equal(
        "maxOutputTokens" in (loaded.view.runs[0]?.start.model ?? {}),
        expected !== undefined
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("决策 556：未配置输出上限时交给模型的 maxTokens 为正；显式值仍优先", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-output-limit-default-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-output-limit-default-home-"));
  try {
    const seen: Array<{ modelMaxTokens: number; requested: number | undefined }> = [];
    const fake = createFakeStreamFn({ replies: [{ text: "好" }] });
    const streamFn: StreamFn = (model, context, options) => {
      seen.push({ modelMaxTokens: model.maxTokens, requested: options?.maxTokens });
      return fake(model, context, options);
    };
    await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
    });
    assert.equal(seen[0]?.modelMaxTokens, 8192, "未给目录上限时用安全缺省，不能是 0");
    assert.equal(seen[0]?.requested, undefined, "未配置时不另外传每轮上限");

    const seenExplicit: number[] = [];
    await runHeadless({
      task: "你好",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn: (model, context, options) => {
        seenExplicit.push(options?.maxTokens ?? -1);
        return fake(model, context, options);
      },
      maxOutputTokens: 64,
      yolo: true,
      homeDir: home,
      skillRoots: [],
      agentsMd: false,
    });
    assert.equal(seenExplicit[0], 64, "显式 --max-output-tokens 仍优先");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
