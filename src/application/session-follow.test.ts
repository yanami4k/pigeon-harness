// 决策 501：只看历史的视图跟着会话记录——状态取自记录（模式、上下文与用量）；只读追加的部分，写了一半的末行等补齐，
// 文件变小即从头重读；新的历史行与已画的比出增量
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { sessionsDirOf } from "../state/paths.ts";
import { SESSION_ENTRY_VERSION, SessionEntryType } from "../state/session-entries.ts";
import { historyDelta, recordedSessionPath, SessionFollower } from "./session-follow.ts";
import { createFixtureSession } from "./session-store-fixtures.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pigeon-follow-"));
  const record = createFixtureSession({ sessionsDir: sessionsDirOf(root), cwd: root });
  record.startRun({
    task: "修登录",
    config: {
      policy: { allow: [], deny: [], approvalMode: "prompt" },
      compaction: {
        contextWindow: 200_000,
        reserveTokens: 1000,
        keepRecentTokens: 1000,
        thresholdTokens: 180_000,
      },
    },
  });
  record.assistant({ text: "好", usage: { input: 50_000, totalTokens: 50_000 } });
  await record.writer.flush();
  const path = recordedSessionPath(root, record.sessionId);
  assert.ok(path !== undefined);
  const follower = new SessionFollower({ root, sessionId: record.sessionId, path });
  return {
    root,
    record,
    path,
    follower,
    cleanup: async () => {
      await record.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("模式、上下文与用量取自会话记录；之后切换过的模式取最后一次，新增的用量累加", async () => {
  const { record, follower, cleanup } = await fixture();
  try {
    let update = await follower.poll();
    assert.ok(update !== undefined);
    assert.equal(update.restarted, true);
    assert.equal(update.status.mode, "prompt");
    assert.deepEqual(update.status.context, { tokens: 50_000, contextWindow: 200_000 });
    assert.equal(update.status.cost.unpricedTokens + update.status.cost.pricedTokens, 50_000);
    assert.equal(await follower.poll(), undefined, "没有追加即没有更新");
    record.writer.append({
      customType: SessionEntryType.ApprovalMode,
      data: { version: SESSION_ENTRY_VERSION, from: "prompt", to: "yolo", changedAt: Date.now() },
    });
    record.assistant({ text: "又一段", usage: { input: 10_000, totalTokens: 10_000 } });
    await record.writer.flush();
    update = await follower.poll();
    assert.ok(update !== undefined);
    assert.equal(update.restarted, false);
    assert.equal(update.status.mode, "yolo");
    assert.equal(update.status.cost.unpricedTokens + update.status.cost.pricedTokens, 60_000);
  } finally {
    await cleanup();
  }
});

test("大文件追加时只读增量：写了一半的末行等补齐再算；文件变小即从头重读", async () => {
  const { record, path, follower, cleanup } = await fixture();
  try {
    for (let index = 0; index < 200; index++)
      record.assistant({ text: `第 ${index} 段 ${"字".repeat(200)}` });
    await record.writer.flush();
    const first = await follower.poll();
    assert.ok(first !== undefined);
    const size = statSync(path).size;
    assert.equal(follower.readBytes, size, "第一次整份读");
    record.assistant({ text: "新的一段" });
    await record.writer.flush();
    const grown = statSync(path).size;
    const next = await follower.poll();
    assert.ok(next !== undefined);
    assert.equal(follower.readBytes, grown, "之后只读追加的部分");
    assert.equal(next.restarted, false);
    const delta = historyDelta(first.lines, next.lines);
    assert.ok(delta !== undefined);
    assert.deepEqual(
      delta.added.map((line) => line.text),
      ["新的一段"]
    );
    // 写了一半的一行：先不算，补齐之后才出来
    appendFileSync(path, '{"kind":"entry","seq":999999,');
    assert.equal(await follower.poll(), undefined);
    truncateSync(path, grown - 10);
    const reread = await follower.poll();
    assert.ok(reread !== undefined);
    assert.equal(reread.restarted, true, "变小了：从头重读");
  } finally {
    await cleanup();
  }
});

test("文件没了：照常抛给调用方（调用方停在原样、下次再看）", async () => {
  const { path, follower, cleanup } = await fixture();
  try {
    await follower.poll();
    rmSync(path);
    await assert.rejects(follower.poll());
  } finally {
    await cleanup();
  }
});

test("历史行的增量：工具行补上结果算改动，前段对不上（主分支换了）即整份重画", () => {
  const drawn = [
    { kind: "user" as const, text: "> 修" },
    { kind: "tool" as const, text: "$ read_file a.ts" },
  ];
  const next = [
    { kind: "user" as const, text: "> 修" },
    { kind: "tool" as const, text: "$ read_file a.ts -> ok" },
    { kind: "assistant" as const, text: "好了" },
  ];
  assert.deepEqual(historyDelta(drawn, next), { changed: [1], added: [next[2]] });
  assert.equal(
    historyDelta(drawn, [{ kind: "user", text: "> 别的" }, ...next.slice(1)]),
    undefined
  );
  assert.equal(historyDelta(next, drawn), undefined);
});
