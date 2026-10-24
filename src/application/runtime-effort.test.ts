// 决策 513：会话中途切换思考强度——运行面的 thinking 一面切换后下一次请求带新档位（这一轮里也算：轮间换上），每次切换记一条
// pigeon.thinking-level，Run 开始条目记当时的档位；续接按主分支最后一条恢复，/reload 沿用切换过的；没切换过的照旧取设置；
// 已知模型不支持推理时固定 off、切换不改。
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runReplayCommand } from "../cli/replay.ts";
import { runTraceCommand } from "../cli/trace.ts";
import { loadStoreSession } from "../persistence/session-view.ts";
import { createFakeStreamFn, type FakeReply, type FakeStreamFn } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { registerModelAccess } from "../pi-runtime/model-access.ts";
import { newSessionId, type SessionId } from "../state/ids.ts";
import type { ThinkingLevel } from "../state/runtime-events.ts";
import { SessionEntryType } from "../state/session-entries.ts";
import { emptySettingsSnapshot, type SettingsSnapshot } from "../state/settings.ts";
import { noMcpSession } from "./mcp.ts";
import { buildRuntime, disposeRuntime, type RuntimeBundle } from "./runtime.ts";
import { carryThinking, openSessionRuntime, thinkingLevelFromEntries } from "./session-runtime.ts";

const FLAGS = { yolo: true, provider: "fake", modelId: "fake", persistThinking: true };

function workspace(): { root: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pigeon-effort-")));
  writeFileSync(join(root, "a.txt"), "a\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 假模型：reasoning 给了即登记"是否支持推理"
function model(
  replies: FakeReply[],
  reasoning?: boolean
): { fake: FakeStreamFn; streamFn: StreamFn } {
  const fake = createFakeStreamFn({ replies });
  return {
    fake,
    streamFn:
      reasoning === undefined ? fake : registerModelAccess(fake, { declared: { reasoning } }),
  };
}

const levels = (fake: FakeStreamFn): unknown[] => fake.calls.map((call) => call.options?.reasoning);

function settingsWith(root: string, level?: ThinkingLevel): SettingsSnapshot {
  const settings = emptySettingsSnapshot(root);
  return level === undefined
    ? settings
    : { ...settings, merged: { ...settings.merged, thinking: { level } } };
}

function open(
  root: string,
  sessionId: SessionId,
  streamFn: StreamFn,
  options: {
    resume?: boolean;
    reloadFrom?: RuntimeBundle;
    settings?: SettingsSnapshot;
    flags?: Partial<typeof FLAGS> & { thinkingLevel?: ThinkingLevel };
    warn?: (line: string) => void;
  } = {}
) {
  return openSessionRuntime({
    governanceRoot: root,
    sessionId,
    streamFn,
    flags: { ...FLAGS, ...options.flags },
    homeDir: root,
    startMcp: async () => noMcpSession(),
    settings: options.settings ?? emptySettingsSnapshot(root),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
    ...(options.resume === true ? { resume: true } : {}),
    ...(options.reloadFrom !== undefined ? { resume: true, reloadFrom: options.reloadFrom } : {}),
  });
}

function sessionOf(root: string, sessionId: SessionId) {
  return loadStoreSession(join(root, ".pigeon", "state", "sessions"), sessionId);
}

test("决策 513：切换后下一次请求带新档位；记一条 pigeon.thinking-level，Run 开始条目记当时的档位；同档不记", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    const { fake, streamFn } = model([{ text: "好" }], true);
    const opened = await open(root, sessionId, streamFn);
    const thinking = opened.bundle.thinking;
    assert.deepEqual(thinking.levels, ["off", "minimal", "low", "medium", "high"]);
    assert.equal(thinking.get(), "high");
    assert.equal(thinking.chosen(), undefined);
    await opened.bundle.adapter.run("一");
    thinking.set("low");
    thinking.set("low");
    assert.equal(thinking.chosen(), "low");
    await opened.bundle.adapter.run("二");
    await disposeRuntime(opened.bundle);
    assert.deepEqual(levels(fake), ["high", "low"]);
    const session = sessionOf(root, sessionId);
    assert.deepEqual(
      session?.view.runs.map((run) => run.start.model.thinkingLevel),
      ["high", "low"]
    );
    const switches = session?.main.filter(
      (entry) => entry.type === "custom" && entry.customType === SessionEntryType.ThinkingLevel
    );
    assert.equal(switches?.length, 1, "同档不记");
    // trace 认这条记录：两个 Run 之间的切换列在会话级条目里
    assert.match(
      runTraceCommand({ root, sessionId }),
      /session entries:\n {2}effort: high -> low at \d\d:\d\d:\d\d\(UTC\)/
    );
    assert.deepEqual(
      (switches?.[0] as { data?: { from?: string; to?: string } } | undefined)?.data?.to,
      "low"
    );
  } finally {
    cleanup();
  }
});

test("决策 513：这一轮里切换的也算——工具结果之后的下一次请求就带新档位", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    const holder: { bundle?: RuntimeBundle } = {};
    const fake = createFakeStreamFn({
      replies: [
        { text: "读", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
        { text: "完" },
      ],
    });
    const streamFn: StreamFn = (m, context, options) => {
      // 第一次请求发出之后、轮间之前切换
      if (fake.calls.length === 0) holder.bundle?.thinking.set("medium");
      return fake(m, context, options);
    };
    const opened = await open(
      root,
      sessionId,
      registerModelAccess(streamFn, { declared: { reasoning: true } })
    );
    holder.bundle = opened.bundle;
    await opened.bundle.adapter.run("读文件");
    await disposeRuntime(opened.bundle);
    assert.deepEqual(levels(fake), ["high", "medium"]);
    // 切换不属于哪个 Run（同审批模式的切换）：trace 在会话级条目里列出；Run 开始条目记的是当时的档位，trace 与 replay 都写
    const runId = sessionOf(root, sessionId)?.view.runs[0]?.runId ?? "";
    const trace = runTraceCommand({ root, sessionId });
    assert.match(trace, /session entries:\n {2}effort: high -> medium at /);
    assert.match(trace, /start: model fake\/fake \| effort high \|/);
    assert.match(
      runReplayCommand({ root, runId, sessionId }),
      /run start \| model fake\/fake \| effort high \|/
    );
  } finally {
    cleanup();
  }
});

test("决策 513：续接按主分支最后一条切换恢复（盖过设置）；/reload 沿用切换过的；没切换过的续接照旧取设置", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    const first = await open(root, sessionId, model([{ text: "好" }], true).streamFn, {
      settings: settingsWith(root, "medium"),
    });
    assert.equal(first.bundle.thinking.get(), "medium");
    await first.bundle.adapter.run("一");
    first.bundle.thinking.set("xhigh");
    first.bundle.thinking.set("low");
    // /reload：沿用切换过的
    const reloaded = await open(root, sessionId, model([{ text: "好" }], true).streamFn, {
      reloadFrom: first.bundle,
      settings: settingsWith(root, "medium"),
    });
    await disposeRuntime(first.bundle);
    assert.equal(reloaded.bundle.thinking.get(), "low");
    assert.equal(reloaded.bundle.thinking.chosen(), "low");
    await disposeRuntime(reloaded.bundle);
    // 续接：取主分支最后一条
    const second = model([{ text: "好" }], true);
    const resumed = await open(root, sessionId, second.streamFn, {
      resume: true,
      settings: settingsWith(root, "medium"),
    });
    assert.equal(resumed.bundle.thinking.get(), "low");
    await resumed.bundle.adapter.run("二");
    await disposeRuntime(resumed.bundle);
    assert.deepEqual(levels(second.fake), ["low"]);
    assert.equal(thinkingLevelFromEntries(sessionOf(root, sessionId)?.main ?? []), "low");
    // 没切换过的会话：续接照旧取设置
    const other = newSessionId();
    const plain = await open(root, other, model([{ text: "好" }], true).streamFn);
    await plain.bundle.adapter.run("一");
    await disposeRuntime(plain.bundle);
    const again = await open(root, other, model([{ text: "好" }], true).streamFn, {
      resume: true,
      settings: settingsWith(root, "medium"),
    });
    assert.equal(again.bundle.thinking.get(), "medium");
    assert.equal(again.bundle.thinking.chosen(), undefined);
    await disposeRuntime(again.bundle);
  } finally {
    cleanup();
  }
});

test("决策 513：已知模型不支持推理——固定 off，切换不改也不记", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    const { fake, streamFn } = model([{ text: "好" }], false);
    const opened = await open(root, sessionId, streamFn);
    const thinking = opened.bundle.thinking;
    assert.deepEqual(thinking.levels, ["off"]);
    thinking.set("high");
    assert.equal(thinking.get(), "off");
    await opened.bundle.adapter.run("一");
    await disposeRuntime(opened.bundle);
    assert.deepEqual(levels(fake), [undefined]);
    const switches = sessionOf(root, sessionId)?.main.filter(
      (entry) => entry.type === "custom" && entry.customType === SessionEntryType.ThinkingLevel
    );
    assert.equal(switches?.length, 0);
  } finally {
    cleanup();
  }
});

test("决策 553：显式档位不受支持时启动报错；会话里记下的档位保留，换回支持推理的模型即按它", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    await assert.rejects(
      () =>
        open(root, sessionId, model([{ text: "好" }], false).streamFn, {
          settings: settingsWith(root, "medium"),
          flags: { thinkingLevel: "high" },
        }),
      /effort "high" is not supported by this model \(use off\)/
    );
    const other = newSessionId();
    const first = await open(root, other, model([{ text: "好" }], true).streamFn);
    first.bundle.thinking.set("low");
    const plain = await open(root, other, model([{ text: "好" }], false).streamFn, {
      reloadFrom: first.bundle,
    });
    await disposeRuntime(first.bundle);
    assert.equal(plain.bundle.thinking.get(), "off");
    assert.equal(plain.bundle.thinking.chosen(), "low");
    const back = await open(root, other, model([{ text: "好" }], true).streamFn, {
      reloadFrom: plain.bundle,
    });
    await disposeRuntime(plain.bundle);
    assert.equal(back.bundle.thinking.get(), "low");
    await disposeRuntime(back.bundle);
  } finally {
    cleanup();
  }
});

test("决策 513 审查：温度跟着档位走——开思考时不下发、切到 off 后下发；Run 开始条目按当时的档位记", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    const { fake, streamFn } = model([{ text: "好" }], true);
    const bundle = buildRuntime({
      streamFn,
      workspaceRoot: root,
      homeDir: root,
      sessionId,
      yolo: true,
      provider: "fake",
      modelId: "fake",
      settings: emptySettingsSnapshot(root),
      temperature: 0.3,
    });
    await bundle.adapter.run("一");
    bundle.thinking.set("off");
    await bundle.adapter.run("二");
    await disposeRuntime(bundle);
    assert.deepEqual(
      fake.calls.map((call) => [call.options?.reasoning, call.options?.temperature]),
      [
        ["high", undefined],
        [undefined, 0.3],
      ]
    );
    const runs = sessionOf(root, sessionId)?.view.runs ?? [];
    assert.deepEqual(runs[0]?.start.model.temperatureIgnored, {
      requested: 0.3,
      reason: "reasoning-enabled",
    });
    assert.equal(runs[0]?.start.model.temperature, undefined);
    assert.equal(runs[1]?.start.model.temperature, 0.3);
    assert.equal(runs[1]?.start.model.temperatureIgnored, undefined);
  } finally {
    cleanup();
  }
});

test("决策 513 审查：重建换手的间隙里落在旧运行面上的切换，换上之后接过来，不再记一条；已释放的运行面上切换不抛、不记", async () => {
  const { root, cleanup } = workspace();
  try {
    const sessionId = newSessionId();
    const first = await open(root, sessionId, model([{ text: "好" }], true).streamFn);
    await first.bundle.adapter.run("一");
    const reloaded = await open(root, sessionId, model([{ text: "好" }], true).streamFn, {
      reloadFrom: first.bundle,
    });
    // 新运行面已按旧的取过档位；这时在旧运行面上切换
    first.bundle.thinking.set("medium");
    await disposeRuntime(first.bundle);
    assert.equal(reloaded.bundle.thinking.get(), "high");
    carryThinking(first.bundle, reloaded.bundle);
    assert.equal(reloaded.bundle.thinking.get(), "medium");
    // 旧运行面已释放：切换不抛、不改
    first.bundle.thinking.set("low");
    assert.equal(first.bundle.thinking.get(), "medium");
    await reloaded.bundle.adapter.run("二");
    await disposeRuntime(reloaded.bundle);
    const switches = sessionOf(root, sessionId)?.main.filter(
      (entry) => entry.type === "custom" && entry.customType === SessionEntryType.ThinkingLevel
    );
    assert.deepEqual(
      switches?.map((entry) => (entry as { data?: { to?: string } }).data?.to),
      ["medium"],
      "接过来不再记一条"
    );
    assert.equal(sessionOf(root, sessionId)?.view.runs.at(-1)?.start.model.thinkingLevel, "medium");
  } finally {
    cleanup();
  }
});

test("MODEL-041 决策 553：显式档位不受支持时启动报错并列出可用档；缺省取最高可用档", async () => {
  const root = workspace();
  try {
    const streamFn = registerModelAccess(createFakeStreamFn({ replies: [{ text: "好" }] }), {
      declared: { reasoning: true },
      catalog: () => ({ reasoning: true, thinkingLevels: ["off", "low"] }),
    });
    await assert.rejects(
      () => open(root.root, newSessionId(), streamFn, { flags: { thinkingLevel: "high" } }),
      /effort "high" is not supported by this model \(use off, low\)/
    );
    const opened = await open(root.root, newSessionId(), streamFn);
    try {
      assert.deepEqual(opened.bundle.thinking.levels, ["off", "low"]);
      assert.equal(opened.bundle.thinking.get(), "low");
    } finally {
      await disposeRuntime(opened.bundle);
    }
  } finally {
    root.cleanup();
  }
});

test("决策 558：用户级档位不支持时回落到不超过它的最高可用档并说明；显式 --thinking 仍报错", async () => {
  const { root: dir, cleanup } = workspace();
  try {
    const stream = registerModelAccess(createFakeStreamFn({ replies: [{ text: "好" }] }), {
      declared: { reasoning: true },
      catalog: () => ({ reasoning: true, thinkingLevels: ["off", "low", "high", "max"] }),
    });
    const warnings: string[] = [];
    const sessionId = newSessionId();
    const opened = await open(dir, sessionId, stream, {
      settings: settingsWith(dir, "xhigh"),
      warn: (line) => warnings.push(line),
    });
    try {
      assert.equal(opened.bundle.thinking.get(), "high", "xhigh 回落到 high");
      assert.match(
        warnings.join("\n"),
        /effort "xhigh" is not supported by fake\/fake \(available: off, low, high, max\); using "high"/
      );
      await opened.bundle.adapter.run("hi");
      await opened.bundle.sessionStore.flush();
      assert.equal(
        sessionOf(dir, sessionId)?.view.runs.at(-1)?.start.model.thinkingLevel,
        "high",
        "Run 开始条目记实际档位"
      );
    } finally {
      await disposeRuntime(opened.bundle);
    }

    // 显式 --thinking xhigh：553 不变，仍然报错并列可用档
    await assert.rejects(
      () =>
        open(dir, newSessionId(), stream, {
          settings: settingsWith(dir),
          flags: { thinkingLevel: "xhigh" },
        }),
      /effort "xhigh" is not supported by this model \(use off, low, high, max\)/
    );
  } finally {
    cleanup();
  }
});

test("决策 558：没有更低的可用档时回落取最低可用档（low + off/high → off）", async () => {
  const { root: dir, cleanup } = workspace();
  try {
    const stream = registerModelAccess(createFakeStreamFn({ replies: [{ text: "好" }] }), {
      declared: { reasoning: true },
      catalog: () => ({ reasoning: true, thinkingLevels: ["off", "high"] }),
    });
    const warnings: string[] = [];
    const opened = await open(dir, newSessionId(), stream, {
      settings: settingsWith(dir, "low"),
      warn: (line) => warnings.push(line),
    });
    try {
      assert.equal(opened.bundle.thinking.get(), "off");
      assert.match(
        warnings.join("\n"),
        /effort "low" is not supported by fake\/fake \(available: off, high\); using "off"/
      );
    } finally {
      await disposeRuntime(opened.bundle);
    }
  } finally {
    cleanup();
  }
});
