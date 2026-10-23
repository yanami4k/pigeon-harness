// 装配根冒烟（M2 S1，决策 025）：buildRuntime 从 cli/index.ts 抽到 Controller 层后，
// 装配接线本身是被改动的部分——本测试钉住"装配出的 bundle 真能跑通一次写调用"：
// 注入的审批 handler 工厂收到装配根自建的 grantStore、prompt 模式下批准生效、
// 文件被真实编辑、工具结果消息上挂着审批闸的决定（会话存储）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SessionGrantStore } from "../approvals/grant-store.ts";
import { writeProviderKey } from "../persistence/credentials.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { loadSettings } from "../persistence/settings.ts";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import { toolResultMark } from "../state/session-judge.ts";
import type { EditFileParams } from "../tools/edit-file.ts";
import { lineTag, snapshotTag } from "../tools/hashline.ts";
import { buildRuntime, resolvePackagedModelAccess } from "./runtime.ts";

// 取值并断言在场（替代非空断言）
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, "值应在场");
  return value;
}

test("MODEL-003, MODEL-012, MODEL-024 one credentialed provider is chosen and the choice is remembered in the user settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pigeon-runtime-model-"));
  try {
    const first = await resolvePackagedModelAccess({
      settings: loadSettings(home, { homeDir: home }),
      model: "claude-sonnet-4-5-20250929",
      env: { ANTHROPIC_API_KEY: "sk-x" },
      homeDir: home,
    });
    assert.equal(first.kind, "ok");
    if (first.kind !== "ok") return;
    // MODEL-003：唯一有凭据的那家被选中；MODEL-009：型号唯一，所以能反推
    assert.equal(first.provider, "anthropic");
    assert.equal(first.modelId, "claude-sonnet-4-5-20250929");
    // MODEL-024：写进用户层的 model.lastUsed
    assert.match(readFileSync(join(home, ".pigeon", "settings.json"), "utf8"), /"lastUsed"/);
    // MODEL-012：下次不给型号时用它；MODEL-016：那家仍有凭据
    const second = await resolvePackagedModelAccess({
      settings: loadSettings(home, { homeDir: home }),
      env: { ANTHROPIC_API_KEY: "sk-x" },
      homeDir: home,
    });
    assert.equal(second.kind, "ok");
    if (second.kind !== "ok") return;
    assert.equal(second.provider, "anthropic");
    assert.equal(second.modelId, "claude-sonnet-4-5-20250929");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("MODEL-034, MODEL-038 the login hint, file credentials and the run-only environment rule", async () => {
  const home = mkdtempSync(join(tmpdir(), "pigeon-runtime-credentials-"));
  try {
    const settings = loadSettings(home, { homeDir: home });
    // 零凭据 + 允许登录：占位运行面 + needsLogin（TUI 拦住发消息并提示 /login）
    const none = await resolvePackagedModelAccess({
      settings,
      env: {},
      homeDir: home,
      credentialsFile: true,
      allowLogin: true,
    });
    assert.equal(none.kind, "ok");
    if (none.kind !== "ok") return;
    assert.equal(none.needsLogin, true);
    assert.equal(none.provider, "custom");
    assert.equal(none.modelId, "custom");
    assert.equal(typeof none.streamFn, "function");
    writeProviderKey("deepseek", "sk-file", { homeDir: home });
    // MODEL-038：pigeon run 不给 credentialsFile，只认环境变量——文件里有 key 也不选它
    const runOnly = await resolvePackagedModelAccess({ settings, env: {}, homeDir: home });
    assert.equal(runOnly.kind, "failed");
    // 终端界面读文件：/login 写入的 key 在没环境变量时生效
    const fromFile = await resolvePackagedModelAccess({
      settings,
      env: {},
      homeDir: home,
      credentialsFile: true,
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.equal(fromFile.kind, "ok");
    if (fromFile.kind !== "ok") return;
    assert.equal(fromFile.provider, "deepseek");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("装配根：注入审批 handler 的 bundle 跑通 prompt 模式写调用，审批决定记在工具结果上", async () => {
  const original = "alpha\nbeta\ngamma\n";
  const root = mkdtempSync(join(tmpdir(), "pigeon-runtime-"));
  try {
    writeFileSync(join(root, "a.ts"), original);
    const editArgs: EditFileParams = {
      path: "a.ts",
      snapshot: snapshotTag(original),
      edits: [{ op: "replace", anchor: `2#${lineTag("beta")}`, lines: ["BETA"] }],
    };
    const streamFn = createFakeStreamFn({
      replies: [
        { text: "改一下", toolCalls: [{ name: "edit_file", args: editArgs }] },
        { text: "已完成" },
      ],
    });
    const sessionId = newSessionId();
    // 注入的工厂：捕获装配根传入的 grantStore，handler 一律批准
    let factoryGrants: SessionGrantStore | undefined;
    let handlerCalls = 0;
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      sessionId,
      yolo: false,
      provider: "fake-provider",
      modelId: "fake-model-1",
      // 剧本按 hashline 参数编辑（决策 062 起缺省为 replace，这里显式指定）
      editMode: "hashline",
      createApprovalHandler: (grants) => {
        factoryGrants = grants;
        return async () => {
          handlerCalls += 1;
          return { approved: true };
        };
      },
    });
    try {
      const result = await bundle.adapter.run("把 beta 改成 BETA");

      assert.equal(result.status, "completed");
      // 审批 handler 由调用方注入并真的被调用；工厂收到的是 bundle 里的同一个 store
      assert.equal(handlerCalls, 1);
      assert.ok(factoryGrants !== undefined);
      assert.equal(factoryGrants, bundle.grantStore);
      // 批准后写调用真实生效
      assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "alpha\nBETA\ngamma\n");
    } finally {
      await bundle.adapter.dispose();
      await bundle.sessionStore.close();
    }
    // 审批决定落会话存储：edit_file 的工具结果消息上挂着"人工批准"的审批闸标记，且只有这一条工具结果
    const loaded = loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
    assert.ok(loaded !== undefined, "会话存储里应有本会话");
    const results = (loaded.view.runs[0]?.messages ?? [])
      .map((ref) => ref.message)
      .filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.toolName, "edit_file");
    assert.equal(results[0]?.isError, false);
    assert.deepEqual(toolResultMark(required(results[0]))?.gate, {
      outcome: "approved",
      approvedBy: "human",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
