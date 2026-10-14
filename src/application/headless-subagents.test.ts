// pigeon run 的子 agent（决策 457、481）：主 agent 停下时还有子 agent 在跑，等它干完、把结果交给主 agent 接着干；连续干等
// 超过上限即停掉剩下的；不开时不注册四件工具
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFakeStreamFn, type FakeReply } from "../pi-runtime/fixtures.ts";
import type { StreamFn } from "../pi-runtime/index.ts";
import { runHeadless } from "./headless-core.ts";
import type { McpSession } from "./mcp.ts";

const noMcp = async (): Promise<McpSession> => ({
  tools: [],
  prompts: [],
  problems: [],
  connections: [],
  summary: () => ({ mcpTools: [], mcpServers: [] }),
  close: async () => {},
});

function routed(parent: FakeReply[], child: FakeReply[]) {
  const top = createFakeStreamFn({ replies: parent });
  const sub = createFakeStreamFn({ replies: child });
  const streamFn: StreamFn = (model, context, options) =>
    (context.systemPrompt ?? "").includes("You are a sub-agent named")
      ? sub(model, context, options)
      : top(model, context, options);
  return { streamFn, top, sub };
}

function dirs(): { root: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-run-agents-"));
  const home = mkdtempSync(join(tmpdir(), "pigeon-run-agents-home-"));
  writeFileSync(join(root, "a.txt"), "one\n");
  return {
    root,
    home,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("主 agent 停下时还有子 agent 在跑：等它干完，结果交给主 agent 接着干，之后才结束", async () => {
  const { root, home, cleanup } = dirs();
  try {
    const { streamFn, top } = routed(
      [
        { text: "", toolCalls: [{ name: "spawn_agent", args: { task: "look around" } }] },
        { text: "started; waiting" },
        { text: "got it, all done" },
      ],
      [{ text: "child result here" }]
    );
    const result = await runHeadless({
      task: "go",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      subagents: true,
    });
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(top.calls.length, 3, "子 agent 的结果交回后主 agent 又跑了一轮");
    assert.match(JSON.stringify(top.calls[2]?.context.messages.at(-1)), /child result here/);
  } finally {
    cleanup();
  }
});

test("连续干等超过上限：停掉剩下的子 agent、丢下没交回的结果，照常结束并说明一行", async () => {
  const { root, home, cleanup } = dirs();
  const warnings: string[] = [];
  try {
    const { streamFn, top } = routed(
      [
        { text: "", toolCalls: [{ name: "spawn_agent", args: { task: "slow work" } }] },
        { text: "started; waiting" },
      ],
      [
        {
          text: "",
          toolCalls: [
            { name: "run_command", args: { command: 'node -e "setTimeout(() => {}, 20000)"' } },
          ],
        },
        { text: "late" },
      ]
    );
    const started = Date.now();
    const result = await runHeadless({
      task: "go",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
      subagents: true,
      subagentWaitMs: 500,
      warn: (line) => warnings.push(line),
    });
    assert.equal(result.status, "completed", result.errorMessage);
    assert.equal(top.calls.length, 2, "没交回的结果不再给主 agent");
    assert.ok(Date.now() - started < 15_000, "没有等子 agent 的命令跑完");
    assert.ok(
      warnings.some((line) => /^stopped 1 sub-agent after waiting/.test(line)),
      warnings.join(" | ")
    );
  } finally {
    cleanup();
  }
});

test("不开子 agent：四件工具都不注册", async () => {
  const { root, home, cleanup } = dirs();
  try {
    const { streamFn, top } = routed([{ text: "done" }], [{ text: "unused" }]);
    await runHeadless({
      task: "go",
      governanceRoot: root,
      workspaceRoot: root,
      streamFn,
      yolo: true,
      homeDir: home,
      startMcp: noMcp,
    });
    const names = (top.calls[0]?.context.tools ?? []).map((tool) => tool.name);
    assert.ok(
      !names.some((name) => /^(spawn_agent|send_message|list_agents|stop_agent)$/.test(name))
    );
  } finally {
    cleanup();
  }
});
