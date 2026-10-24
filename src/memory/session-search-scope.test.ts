// 决策 555：search_sessions 的 scope——project（缺省，与今天一致）与 current（只当前会话、只到最近一次压缩点为止）。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFixtureSession } from "../application/session-store-fixtures.ts";
import { createSearchSessionsTool } from "./search-tools.ts";
import { createSessionSearch } from "./session-search.ts";

function compaction(summary: string): never {
  return { summary, retainedTail: [], tokensBefore: 100, details: {} } as never;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-scope-"));
  const sessionsDir = join(root, ".pigeon", "state", "sessions");
  const session = createFixtureSession({ sessionsDir });
  session.startRun({ task: "任务" });
  session.user("压缩前提到 alpaca 的条目");
  session.assistant({ text: "回复里也有 alpaca", timestamp: 1000 });
  await session.writer.appendCompaction(compaction("第一份摘要"));
  const afterFirst = Date.now() + 100_000;
  session.assistant({ text: "第一次压缩之后又提到 alpaca", timestamp: afterFirst });
  await session.writer.flush();
  return { root, sessionsDir, session, sessionId: session.sessionId, afterFirst };
}

test("MEMORY-082 scope current searches the current session only up to the latest compaction point", async () => {
  const { root, sessionsDir, session, sessionId, afterFirst } = await fixture();
  try {
    const current = { sessionId };
    const search = createSessionSearch(sessionsDir);
    const scoped = await search.search({ keywords: ["alpaca"], scope: "current", current });
    assert.equal(scoped.totalHits, 2, "压缩前的两条命中");
    assert.equal(scoped.totalSessions, 1);
    assert.doesNotMatch(JSON.stringify(scoped), /第一次压缩之后/);

    // 再压一次：上次压缩点之后、这次压缩点之前的条目进入范围
    await session.writer.appendCompaction(compaction("第二份摘要"));
    const afterSecond = Date.now() + 1_000_000;
    session.assistant({ text: "第二次压缩之后提到的 alpaca", timestamp: afterSecond });
    await session.writer.flush();
    const again = await search.search({ keywords: ["alpaca"], scope: "current", current });
    assert.equal(again.totalHits, 3, "第一段与第二次压缩前的条目");
    assert.ok(
      again.ranked.some((hit) => hit.runSeq === 4),
      "第二次压缩点之前的条目进入范围"
    );
    assert.ok(!again.ranked.some((hit) => hit.runSeq === 5), "第二次压缩点之后的条目不在范围");
    assert.ok(afterSecond > afterFirst);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MEMORY-082 scope defaults to project: no behaviour change, the current session stays out", async () => {
  const { root, sessionsDir, session, sessionId } = await fixture();
  try {
    const search = createSessionSearch(sessionsDir);
    const implicit = await search.search({ keywords: ["alpaca"], current: { sessionId } });
    const explicit = await search.search({
      keywords: ["alpaca"],
      scope: "project",
      current: { sessionId },
    });
    assert.deepEqual(implicit, explicit);
    assert.equal(implicit.totalHits, 0, "缺省仍排除当前会话");
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MEMORY-082 the compaction point follows entry order, not timestamps", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-search-scope-order-"));
  try {
    const sessionsDir = join(root, ".pigeon", "state", "sessions");
    const session = createFixtureSession({ sessionsDir });
    session.startRun({ task: "任务" });
    session.user("压缩前的 alpaca");
    await session.writer.appendCompaction(compaction("摘要"));
    session.user("压缩后的 alpaca");
    const { path, sessionId } = await session.close();

    // 把所有条目的时间戳改成同一个值：只能按条目顺序认压缩点
    const sameAt = 1_700_000_000_000;
    const lines = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const entry = JSON.parse(line) as Record<string, unknown> & { kind?: string };
        if (entry.kind === "entry") entry.timestamp = sameAt;
        return JSON.stringify(entry);
      });
    writeFileSync(path, `${lines.join("\n")}\n`);

    const result = await createSessionSearch(sessionsDir).search({
      keywords: ["alpaca"],
      scope: "current",
      current: { sessionId },
    });
    assert.equal(result.totalHits, 1, "只算压缩点之前的那一条");
    assert.deepEqual(
      result.ranked.map((hit) => hit.runSeq),
      [2],
      "压缩前的用户消息（runSeq 2）"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MEMORY-082 scope current hits carry a note that they may already be in the context", async () => {
  const { root, sessionsDir, session, sessionId } = await fixture();
  try {
    const tool = createSearchSessionsTool({ sessionsDir, current: { sessionId } });
    const result = await tool.execute("r", { keywords: ["alpaca"], scope: "current" });
    const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(
      text,
      /scope: conversation text and tool output; in this session before its latest compaction/
    );
    assert.match(text, /may already have appeared in the current context/);
    assert.match(text, /压缩前提到 alpaca/);
    assert.doesNotMatch(text, /第一次压缩之后/);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
