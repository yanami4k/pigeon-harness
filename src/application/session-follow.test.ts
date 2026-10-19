// 决策 501：只看历史的视图跟着会话记录——状态取自记录（模式、上下文与用量）；只读追加的部分，写了一半的末行等补齐，
// 文件变小即从头重读；新的历史行与已画的比出增量
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { sessionsDirOf, subagentSessionsDir } from "../state/paths.ts";
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
    // 写了一半的一行：先不算，补齐之后才出来（照最后一条助手消息造一条新的）
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}");
    const added = {
      ...last,
      seq: last.seq + 1000,
      id: `${last.id}x`,
      parentId: last.id,
      message: { ...last.message, content: [{ type: "text", text: "补齐的一段" }] },
    };
    const text = `${JSON.stringify(added)}\n`;
    const cut = Math.floor(text.length / 2);
    appendFileSync(path, text.slice(0, cut));
    assert.equal(await follower.poll(), undefined, "半行先不算");
    appendFileSync(path, text.slice(cut));
    const completed = await follower.poll();
    assert.ok(completed !== undefined);
    assert.equal(completed.restarted, false);
    assert.deepEqual(
      historyDelta(next.lines, completed.lines)?.added.map((line) => line.text),
      ["补齐的一段"],
      "补齐之后出来"
    );
    truncateSync(path, grown - 10);
    const reread = await follower.poll();
    assert.ok(reread !== undefined);
    assert.equal(reread.restarted, true, "变小了：从头重读");
  } finally {
    await cleanup();
  }
});

test("换了一个文件（更大、更新）：认出来从头读，不当成追加", async () => {
  const { path, follower, cleanup } = await fixture();
  try {
    const first = await follower.poll();
    assert.ok(first !== undefined);
    const content = readFileSync(path, "utf8");
    const replacement = `${path}.new`;
    // 同一份内容再接一遍正文：更大、更新，但是另一个文件
    writeFileSync(replacement, `${content}${content.split("\n").slice(1).join("\n")}`);
    renameSync(replacement, path);
    const next = await follower.poll();
    assert.ok(next !== undefined);
    assert.equal(next.restarted, true);
  } finally {
    await cleanup();
  }
});

test("修改时刻倒退（大小不变）：从头重读", async () => {
  const { path, follower, cleanup } = await fixture();
  try {
    await follower.poll();
    const info = statSync(path);
    utimesSync(path, info.atime, new Date(info.mtimeMs - 60_000));
    const next = await follower.poll();
    assert.ok(next !== undefined);
    assert.equal(next.restarted, true);
  } finally {
    await cleanup();
  }
});

test("子 agent 的用量在记录每次有变化时重算（只看它名下的 subagents 文件夹）", async () => {
  const { root, record, path, follower, cleanup } = await fixture();
  const child = createFixtureSession({
    sessionsDir: subagentSessionsDir(path, record.sessionId),
    cwd: root,
    parentSessionId: record.sessionId,
  });
  try {
    child.startRun({ task: "子任务" });
    child.assistant({ text: "子回复", usage: { input: 7000, totalTokens: 7000 } });
    await child.writer.flush();
    const tokens = (update: Awaited<ReturnType<typeof follower.poll>>) =>
      (update?.status.cost.unpricedTokens ?? 0) + (update?.status.cost.pricedTokens ?? 0);
    assert.equal(tokens(await follower.poll()), 57_000);
    child.assistant({ text: "子又回了", usage: { input: 3000, totalTokens: 3000 } });
    await child.writer.flush();
    record.assistant({ text: "主这边也动了" });
    await record.writer.flush();
    assert.equal(tokens(await follower.poll()), 60_000, "子 agent 新增的用量算进来了");
  } finally {
    await child.close();
    await cleanup();
  }
});

test("用量：复盘只在进入时算一次、别的会话名下的子 agent 不算；从头重读之后不重复计", async () => {
  const { root, record, path, follower, cleanup } = await fixture();
  const sessionsDir = sessionsDirOf(root);
  const review = createFixtureSession({
    sessionsDir,
    cwd: root,
    parentSessionId: record.sessionId,
  });
  const other = createFixtureSession({ sessionsDir, cwd: root });
  const tokens = (update: Awaited<ReturnType<typeof follower.poll>>) =>
    (update?.status.cost.unpricedTokens ?? 0) + (update?.status.cost.pricedTokens ?? 0);
  try {
    review.startRun({ task: "复盘", config: { memoryReview: { kind: "closing", template: "t" } } });
    review.assistant({ text: "记下", usage: { input: 2000, totalTokens: 2000 } });
    review.endRun();
    await review.writer.flush();
    other.startRun({ task: "别的会话" });
    await other.writer.flush();
    const otherPath = recordedSessionPath(root, other.sessionId);
    assert.ok(otherPath !== undefined);
    const stranger = createFixtureSession({
      sessionsDir: subagentSessionsDir(otherPath, other.sessionId),
      cwd: root,
      parentSessionId: other.sessionId,
    });
    stranger.startRun({ task: "别人的子任务" });
    stranger.assistant({ text: "别人的", usage: { input: 100_000, totalTokens: 100_000 } });
    await stranger.close();
    assert.equal(
      tokens(await follower.poll()),
      52_000,
      "自己 5 万 + 复盘 2 千，别人的子 agent 不算"
    );
    // 换了一个文件（同样内容）：从头读，用量不翻倍
    const content = readFileSync(path, "utf8");
    writeFileSync(`${path}.new`, content);
    renameSync(`${path}.new`, path);
    const reread = await follower.poll();
    assert.equal(reread?.restarted, true);
    assert.equal(tokens(reread), 52_000);
  } finally {
    await review.close();
    await other.close();
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
