// 决策 554：压缩时把“上一条 compaction 条目之后、本次之前”的条目另存到 outputs/<会话号>/compact-<n>，
// 摘要末尾给 pigeon://outputs/<会话号>/compact-<n>；第二次只追加 compact-2；归档失败照常完成压缩、摘要记一行失败。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, CompactResult, Entry } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { type CompactionStore, ContextCompactor, resolveCompactionConfig } from "./compaction.ts";
import { createFakeStreamFn } from "./fixtures.ts";
import { openSessionStoreWriter } from "./session-store.ts";

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistant(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "fake",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

function summaryModel(): Model<Api> {
  return {
    id: "fake-model",
    name: "fake-model",
    api: "anthropic-messages",
    provider: "fake",
    baseUrl: "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 16_384,
  };
}

function longConversation(prefix: string): AgentMessage[] {
  return [
    user(`${prefix}：第一件事请修 a.ts`.repeat(20), 1),
    assistant(`${prefix}：已修好 a.ts`.repeat(20), 2),
    user(`${prefix}：第二件事把 b.ts 的日志改成中文`.repeat(20), 3),
    assistant(`${prefix}：已改好 b.ts`.repeat(20), 4),
    user(`${prefix}：第三件事跑一下全部测试`.repeat(5), 5),
  ];
}

const NOOP = () => {};

async function archiveFixture(root: string, sessionId: string) {
  const writer = openSessionStoreWriter({
    sessionsRoot: join(root, ".pigeon", "state", "sessions"),
    sessionId,
    cwd: root,
  });
  const store: CompactionStore = {
    branch: () => writer.branch(),
    appendCompaction: (result) => writer.appendCompaction(result),
    archiveCompaction: (input) =>
      writer.archiveCompaction?.(input) ?? Promise.resolve({ error: "missing" }),
  };
  return { writer, store };
}

function entriesOf(file: string): Entry[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

test("CONTEXT-094 a compaction archives the replaced increment and links compact-1; a second compaction only adds compact-2", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-compact-archive-"));
  const sessionId = "sess_archive_1";
  try {
    const { writer, store } = await archiveFixture(root, sessionId);
    for (const message of longConversation("第一轮")) writer.appendMessage(message);
    const before = (await writer.branch()) as Entry[];

    const compactor = new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn: createFakeStreamFn({ replies: [{ text: "摘要一" }] }),
      model: summaryModel(),
    });
    const first = await compactor.run(store, {
      trigger: "manual",
      tokens: 100,
      signal: new AbortController().signal,
      onHookError: NOOP,
    });
    assert.equal(first.kind, "compacted");
    await writer.flush();
    const file = await writer.filePath();
    assert.ok(file !== undefined);

    const outputsDir = join(root, ".pigeon", "state", "outputs", sessionId);
    const archiveOne = join(outputsDir, "compact-1");
    assert.deepEqual(readdirSync(outputsDir).sort(), ["compact-1"]);
    const archived = entriesOf(archiveOne);
    // 与压缩前的条目逐条一致（原样序列化）
    assert.deepEqual(archived, before);
    assert.ok(JSON.stringify(archived).includes("第一轮：第一件事请修 a.ts"));

    const compaction = entriesOf(file).filter((entry) => entry.type === "compaction");
    assert.equal(compaction.length, 1);
    assert.ok(
      (compaction[0] as unknown as { summary: string }).summary.endsWith(
        `pigeon://outputs/${sessionId}/compact-1`
      )
    );
    const firstArchive = readFileSync(archiveOne, "utf8");

    // 第二次压缩：只追加 compact-2，compact-1 不改写
    for (const message of longConversation("第二轮")) {
      writer.appendMessage({
        ...message,
        timestamp: (message.timestamp as number) + 100,
      } as AgentMessage);
    }
    const second = await new ContextCompactor({
      config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
      streamFn: createFakeStreamFn({ replies: [{ text: "摘要二" }] }),
      model: summaryModel(),
    }).run(store, {
      trigger: "manual",
      tokens: 100,
      signal: new AbortController().signal,
      onHookError: NOOP,
    });
    assert.equal(second.kind, "compacted");
    await writer.flush();
    assert.deepEqual(readdirSync(outputsDir).sort(), ["compact-1", "compact-2"]);
    assert.equal(readFileSync(archiveOne, "utf8"), firstArchive);
    const archiveTwo = entriesOf(join(outputsDir, "compact-2"));
    assert.ok(JSON.stringify(archiveTwo).includes("第二轮：第一件事请修 a.ts"));
    assert.ok(!JSON.stringify(archiveTwo).includes("第一轮："));
    const summaries = entriesOf(file)
      .filter((entry) => entry.type === "compaction")
      .map((entry) => (entry as unknown as { summary: string }).summary);
    assert.ok(summaries[1]?.endsWith(`pigeon://outputs/${sessionId}/compact-2`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTEXT-095 a failed archive does not stop the compaction and leaves one failure line", async () => {
  const compactionResult: CompactResult[] = [];
  const store: CompactionStore = {
    branch: async () =>
      longConversation("失败").map(
        (message, index) =>
          ({
            type: "message",
            id: `e${index}`,
            parentId: index === 0 ? null : `e${index - 1}`,
            seq: index + 1,
            timestamp: message.timestamp,
            message,
          }) as Entry
      ),
    appendCompaction: async (result) => {
      compactionResult.push(result);
      return [];
    },
    archiveCompaction: async () => ({ error: new Error("disk full") }),
  };
  const outcome = await new ContextCompactor({
    config: resolveCompactionConfig({ thresholdTokens: 10, keepRecentTokens: 5 }),
    streamFn: createFakeStreamFn({ replies: [{ text: "摘要" }] }),
    model: summaryModel(),
  }).run(store, {
    trigger: "manual",
    tokens: 100,
    signal: new AbortController().signal,
    onHookError: NOOP,
  });
  assert.equal(outcome.kind, "compacted");
  assert.ok(compactionResult[0]?.summary.endsWith("Compaction archive failed: disk full"));
});
