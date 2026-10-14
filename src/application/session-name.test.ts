// 决策 456：会话名是会话自己的属性——记进会话文件（上游会话的 name 事实），推迟建文件时先留在内存里、不为改名建文件；
// 按最新一条取；会话回退不影响；被手改成不合规的不认、按缺省名；会话列表每行带名字
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { acquireSessionFileLock } from "../persistence/session-lock.ts";
import { readSessionFile } from "../persistence/session-reader.ts";
import type { AgentMessage } from "../pi-runtime/index.ts";
import { forkSessionFile, openSessionStoreWriter } from "../pi-runtime/session-store.ts";
import { newSessionId } from "../state/ids.ts";
import { listRecentMainSessions, recentSessionLine } from "./recent-sessions.ts";
import {
  defaultSessionName,
  sessionDisplayName,
  sessionNameOf,
  storedSessionName,
  validSessionName,
} from "./session-name.ts";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

test("分叉出来的分支会话不带来源的名字：用它自己的缺省名", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-name-"));
  const sessions = join(root, ".pigeon", "state", "sessions");
  const sessionId = newSessionId();
  const writer = openSessionStoreWriter({
    sessionsRoot: sessions,
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
  });
  try {
    writer.setName("api-fix");
    writer.appendMessage(userMessage("第一件事"));
    await writer.flush();
    const path = await writer.filePath();
    assert.ok(path !== undefined);
    const message = readSessionFile(path)?.entries.find((entry) => entry.type === "message");
    assert.ok(message !== undefined);
    const branchId = newSessionId();
    await forkSessionFile({
      sessionsRoot: sessions,
      source: { sessionId, path },
      entryId: message.id,
      branchSessionId: branchId,
      cwd: root,
    });
    assert.equal(sessionNameOf(root, sessionId, root), "api-fix");
    assert.equal(storedSessionName(root, branchId)?.name, undefined);
    assert.equal(sessionNameOf(root, branchId, root), defaultSessionName(root, branchId));
  } finally {
    await writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("会话目录读不了（不是目录、被占用、权限）：按没改过名处理，不抛", () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-name-"));
  try {
    mkdirSync(join(root, ".pigeon", "state"), { recursive: true });
    writeFileSync(join(root, ".pigeon", "state", "sessions"), "不是目录");
    const sessionId = newSessionId();
    assert.equal(storedSessionName(root, sessionId), undefined);
    assert.equal(sessionNameOf(root, sessionId, root), defaultSessionName(root, sessionId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("改名记进会话文件：推迟建文件时不为改名建文件，随第一条要落盘的内容写下；按最新一条取；会话回退不影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "pigeon-session-name-"));
  const sessionId = newSessionId();
  const writer = openSessionStoreWriter({
    sessionsRoot: join(root, ".pigeon", "state", "sessions"),
    sessionId,
    cwd: root,
    lock: acquireSessionFileLock,
    deferCreate: true,
  });
  try {
    writer.setName("api-fix");
    await writer.flush();
    assert.equal(writer.fileDeferred?.(), true, "只改名不建文件");
    assert.equal(storedSessionName(root, sessionId), undefined);
    // 没有文件：按给的目录取缺省名
    assert.equal(sessionNameOf(root, sessionId, root), defaultSessionName(root, sessionId));

    writer.appendMessage(userMessage("第一件事"));
    await writer.flush();
    assert.equal(storedSessionName(root, sessionId)?.name, "api-fix");
    assert.equal(sessionNameOf(root, sessionId, root), "api-fix");

    // 会话回退到开头：主分支挪走，名字不变（不属于任何分支）
    const leaf = await writer.leafId();
    assert.equal(
      await writer.rewindLane({ expectLeaf: leaf ?? null, to: null, entries: [] }),
      "ok"
    );
    assert.equal(sessionNameOf(root, sessionId, root), "api-fix");

    // 再改：按最新一条取
    writer.setName("second-name");
    await writer.flush();
    assert.equal(sessionNameOf(root, sessionId, root), "second-name");

    // 会话列表每行带名字
    writer.appendMessage(userMessage("第二件事"));
    await writer.flush();
    const listed = listRecentMainSessions(root).find((item) => item.sessionId === sessionId);
    assert.equal(listed?.name, "second-name");
    assert.ok(listed !== undefined && recentSessionLine(listed).includes("  second-name  "));

    // 被手改成不合名字规则的不认，按文件头的目录给缺省名
    writer.setName("bad name\u001b[31m");
    await writer.flush();
    assert.equal(storedSessionName(root, sessionId)?.name, undefined);
    assert.equal(
      sessionNameOf(root, sessionId, join(root, "elsewhere")),
      defaultSessionName(root, sessionId)
    );
  } finally {
    await writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("名字规则：字母、数字、下划线、连字符与点，最长 40；缺省名为目录名加会话号末 4 位（小写）", () => {
  assert.equal(validSessionName("api-worker_2"), true);
  assert.equal(validSessionName("v1.2"), true);
  assert.equal(validSessionName("有 空格"), false);
  assert.equal(validSessionName("a".repeat(41)), false);
  assert.equal(defaultSessionName("/w/proj", "sess_01ABCDEFXYZ1"), "proj-xyz1");
  assert.equal(defaultSessionName("C:\\work\\my app", "sess_01ABCDEF0001"), "my-app-0001");
});

test("显示名：记过的合规名字照用，否则缺省名（工作目录名加会话号末 4 位）", () => {
  assert.equal(sessionDisplayName("api-fix", "/w/demo", "sess_0000ABCD"), "api-fix");
  assert.equal(sessionDisplayName(undefined, "/w/demo", "sess_0000ABCD"), "demo-abcd");
  assert.equal(sessionDisplayName("", "/w/demo", "sess_0000ABCD"), "demo-abcd");
  assert.equal(sessionDisplayName("x".repeat(41), "/w/demo", "sess_0000ABCD"), "demo-abcd");
  // 默认可忽略的字符（韩文填充符一类：算 0 宽却画成空白）不算合规名字；其他文字照常
  assert.equal(sessionDisplayName("ㅤ", "/w/demo", "sess_0000ABCD"), "demo-abcd");
  assert.equal(sessionDisplayName("aᅟb", "/w/demo", "sess_0000ABCD"), "demo-abcd");
  assert.equal(sessionDisplayName("修登录页", "/w/demo", "sess_0000ABCD"), "修登录页");
});
