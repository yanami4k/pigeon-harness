// M5 S5（决策 044）：usage 与快照摘要的投影——会话摘要算每会话总 token（会话列表呈现；决策 476：只写 token 数、不写金额，
// 写法同状态栏），trace 的 Run 头显示 Run 开始摘要与模型请求次数（助手消息条数），每轮显示 usage 与这一轮合计的 token 数（不写
// 金额）。会话摘要里的金额字段照旧算（不删字段）。读新会话存储：用量取自助手消息。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { runSessionListCommand } from "../application/session-list.ts";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { listSessionSummaries } from "../persistence/session-list.ts";
import { runTraceCommand } from "./trace.ts";

const HASH = "d".repeat(64);

function usage(input: number, output: number, cacheRead: number, total: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
  };
}

test("会话摘要合计 token 与成本并在会话列表呈现；trace Run 头显示启动快照，每轮显示 usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-usage-view-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const session = createFixtureSession({ sessionsDir });
    session.startRun({
      task: "读",
      config: {
        model: { provider: "kimi", id: "k2", thinkingLevel: "off" },
        policy: { allow: ["read_file"], deny: [], approvalMode: "prompt" },
        advertisedTools: ["read_file"],
        systemPrompt: "系统提示",
        memory: [
          { path: ".pigeon/memory/a.md", hash: HASH, bytes: 3, truncated: false, included: true },
        ],
      },
    });
    const [callId = ""] = session.assistant({
      toolCalls: [{ name: "read_file" }],
      usage: usage(120, 30, 100, 0.0031),
    });
    session.toolResult({ toolCallId: callId, toolName: "read_file", text: "内容" });
    session.assistant({ text: "好", usage: usage(200, 50, 0, 0.002) });
    session.endRun();
    const { sessionId } = await session.close();

    const [summary] = listSessionSummaries(sessionsDir);
    assert.equal(summary?.totalTokens, 500);
    assert.ok(Math.abs((summary?.totalCost ?? 0) - 0.0051) < 1e-9);

    const list = runSessionListCommand({ root });
    assert.match(list, / {2}500 tokens$/m);
    assert.doesNotMatch(list, /\$|¥/);

    const trace = runTraceCommand({ root, sessionId });
    const prompt = createHash("sha256").update("系统提示").digest("hex").slice(0, 12);
    assert.ok(
      trace.includes(
        `start: model kimi/k2 | effort off | approval mode prompt | tools read_file | memory 1 (1 injected) | skills 0 | system prompt ${prompt} | 2 model requests`
      ),
      trace
    );
    assert.match(
      trace,
      /turn 1 .*tokens in 120 \/ out 30 \/ cache read 100 \/ cache write 0 \| 250 tokens$/m
    );
    assert.match(
      trace,
      /turn 2 .*tokens in 200 \/ out 50 \/ cache read 0 \/ cache write 0 \| 250 tokens$/m
    );
    assert.doesNotMatch(trace, /\$\d|¥/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
