// 决策 430：续跑时所用模型与最后一个 Run 记下的不同，按新模型重建系统提示；相同照旧逐字节沿用（363）。
// 旧记录没有模型信息时照旧沿用，见 status-channel.test.ts 的旧会话续跑
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFakeStreamFn } from "../pi-runtime/fixtures.ts";
import { newSessionId } from "../state/ids.ts";
import type { McpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type FrozenSessionPrompt } from "./runtime.ts";
import { openSessionRuntime } from "./session-runtime.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function frozenOf(model?: { provider: string; id: string }): FrozenSessionPrompt {
  return {
    systemPrompt:
      "You are Pigeon, a coding agent powered by the deepseek-flash model.\n\nFROZEN-MARKER",
    ...(model !== undefined ? { model } : {}),
    instructions: { section: "FROZEN-INSTRUCTIONS", manifest: [] },
    localSkills: { entries: [], problems: [], roots: [] },
  };
}

async function promptFromFrozen(
  frozen: FrozenSessionPrompt,
  modelId: string
): Promise<{ prompt: string; frozen: FrozenSessionPrompt }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-prompt-frozen-")));
  const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
  const bundle = buildRuntime({
    streamFn,
    workspaceRoot: root,
    sessionId: newSessionId(),
    yolo: true,
    provider: "deepseek",
    modelId,
    frozenPrompt: frozen,
  });
  try {
    await bundle.adapter.run("你是什么模型");
    return { prompt: streamFn.calls[0]?.context.systemPrompt ?? "", frozen: bundle.frozenPrompt };
  } finally {
    await bundle.adapter.dispose();
    await bundle.sessionStore.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// 决策 570：/reload 换型号时，冻结的系统提示不能再沿用旧型号的身份句
test("CONTEXT-090 决策 570：冻结提示来自旧型号时按新运行面模型重建身份句", async () => {
  const { prompt, frozen } = await promptFromFrozen(
    frozenOf({ provider: "deepseek", id: "deepseek-flash" }),
    "deepseek-pro"
  );
  assert.match(prompt, /^You are Pigeon, a coding agent powered by the deepseek-pro model\./);
  assert.doesNotMatch(prompt, /powered by the deepseek-flash model/);
  assert.equal(frozen.instructions.section, "FROZEN-INSTRUCTIONS", "说明照旧沿用");
  assert.deepEqual(frozen.localSkills.entries, [], "Skill 扫描照旧沿用");
  assert.equal(frozen.model?.id, "deepseek-pro", "新冻结记下新型号");
});

// 决策 363：同一型号重建照旧逐字节沿用冻结的提示
test("CONTEXT-090 决策 363、570：同型号重建逐字节沿用冻结的系统提示", async () => {
  const frozen = frozenOf({ provider: "deepseek", id: "deepseek-flash" });
  const { prompt } = await promptFromFrozen(frozen, "deepseek-flash");
  assert.equal(prompt, frozen.systemPrompt);
});

// 旧调用方没给 model：维持原行为，不误伤 363 的续跑
test("CONTEXT-090 决策 570：冻结提示没有型号时维持沿用（兼容旧路径）", async () => {
  const frozen = frozenOf();
  const { prompt } = await promptFromFrozen(frozen, "deepseek-pro");
  assert.equal(prompt, frozen.systemPrompt);
});

test("续跑换了模型：系统提示按新模型重建；再用同一模型续跑，逐字节沿用重建后的那份", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-prompt-model-")));
  const home = mkdtempSync(join(tmpdir(), "pigeon-prompt-model-home-"));
  const sessionId = newSessionId();
  const promptWith = async (modelId: string, resume: boolean): Promise<string> => {
    const streamFn = createFakeStreamFn({ replies: [{ text: "好" }] });
    const opened = await openSessionRuntime({
      governanceRoot: root,
      sessionId,
      streamFn,
      flags: {
        yolo: true,
        provider: "deepseek",
        modelId,
        // 显式指定的型号：续接时按它换模型（MODEL-013）
        providerFlag: "deepseek",
        modelFlag: modelId,
        persistThinking: true,
      },
      startMcp: noMcp,
      homeDir: home,
      ...(resume ? { resume: true } : {}),
    });
    try {
      await opened.bundle.adapter.run("你好");
    } finally {
      await disposeRuntime(opened.bundle);
    }
    return streamFn.calls[0]?.context.systemPrompt ?? "";
  };
  try {
    const flash = await promptWith("deepseek-flash", false);
    assert.match(flash, /^You are Pigeon, a coding agent powered by the deepseek-flash model\./);
    assert.equal(await promptWith("deepseek-flash", true), flash, "同一模型续跑逐字节沿用");
    const pro = await promptWith("deepseek-pro", true);
    assert.match(pro, /^You are Pigeon, a coding agent powered by the deepseek-pro model\./);
    assert.equal(pro, flash.replace("deepseek-flash", "deepseek-pro"), "只有模型名变了");
    assert.equal(await promptWith("deepseek-pro", true), pro, "重建后的那份照旧沿用");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
