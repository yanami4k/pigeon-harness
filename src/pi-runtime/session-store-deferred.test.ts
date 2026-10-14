// 推迟建会话文件（决策 432）：新会话等第一条真要落盘的写入才建文件、取锁；在此之前只有钩子运行记录时先留在内存里，
// 建文件时按原顺序补写，到最后一个写者关闭都没建就丢弃、不留文件。同进程再开的写者（/reload）共用同一推迟状态。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { acquireSessionFileLock, sessionFileLockPath } from "../persistence/session-lock.ts";
import { readSessionFile } from "../persistence/session-reader.ts";
import { asRunId } from "../state/ids.ts";
import { type SessionCustomEntry, SessionEntryType } from "../state/session-entries.ts";
import type { AgentMessage } from "./index.ts";
import {
  openSessionStoreWriter,
  type SessionStoreFault,
  type SessionStoreWriterOptions,
} from "./session-store.ts";

const RUN = asRunId("run_01J5Z7K8W9ABCDEFGHJKMNPQRS");

function tempRoot(): { root: string; sessions: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pigeon-deferred-"));
  return {
    root,
    sessions: join(root, ".pigeon", "state", "sessions"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function options(
  sessions: string,
  sessionId: string,
  extra: Partial<SessionStoreWriterOptions> = {}
): SessionStoreWriterOptions {
  return {
    sessionsRoot: sessions,
    sessionId,
    cwd: dirname(dirname(dirname(sessions))),
    lock: acquireSessionFileLock,
    ...extra,
  };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function hookRecord(event: string): SessionCustomEntry {
  return {
    customType: SessionEntryType.Hook,
    data: {
      version: 1,
      event,
      command: "echo hi",
      exitCode: 0,
      timedOut: false,
      durationMs: 3,
      conclusion: "allow",
    },
  } as unknown as SessionCustomEntry;
}

function runEnd(): SessionCustomEntry {
  return {
    customType: SessionEntryType.RunEnd,
    data: { version: 1, runId: RUN, ending: "completed", messageCount: 1, endedAt: 2 },
  };
}

// 会话根下的全部文件（含锁），相对路径
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// 文件里条目的种类序列：消息记 message:<role>，钩子运行记录记 hook:<事件>，其余自定义条目记 customType
function entryKinds(path: string): string[] {
  const view = readSessionFile(path);
  assert.ok(view !== undefined, "会话文件应可读");
  return view.entries.map((entry) => {
    if (entry.type === "message") return `message:${(entry.message as { role: string }).role}`;
    if (entry.customType === SessionEntryType.Hook)
      return `hook:${(entry.data as { event: string }).event}`;
    return String(entry.customType ?? entry.type);
  });
}

test("推迟建文件：打开后不建文件、不取锁，读主分支为空，filePath 为 undefined", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const writer = openSessionStoreWriter(options(sessions, "sess_D1", { deferCreate: true }));
    assert.equal(writer.fileDeferred?.(), true);
    assert.deepEqual(await writer.branch(), []);
    await writer.flush();
    assert.equal(await writer.filePath(), undefined);
    assert.deepEqual(filesUnder(sessions), []);
    await writer.close();
    assert.deepEqual(filesUnder(sessions), []);
  } finally {
    cleanup();
  }
});

test("推迟建文件：只有钩子运行记录时到关闭都不建文件，记录丢弃、不留锁", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const faults: SessionStoreFault[] = [];
    const writer = openSessionStoreWriter(
      options(sessions, "sess_D2", { deferCreate: true, onFault: (fault) => faults.push(fault) })
    );
    writer.append(hookRecord("SessionStart"));
    writer.append(hookRecord("SessionEnd"));
    await writer.flush();
    assert.equal(writer.fileDeferred?.(), true);
    await writer.close();
    assert.deepEqual(filesUnder(sessions), []);
    assert.deepEqual(faults, []);
  } finally {
    cleanup();
  }
});

test("推迟建文件：第一条消息到来时建文件、取锁，此前的钩子运行记录按原顺序补写在前", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const writer = openSessionStoreWriter(options(sessions, "sess_D3", { deferCreate: true }));
    writer.append(hookRecord("SessionStart"));
    writer.append(hookRecord("UserPromptSubmit"));
    writer.appendMessage(userMessage("你好"));
    writer.append(runEnd());
    assert.equal(writer.fileDeferred?.(), false);
    const path = await writer.filePath();
    assert.ok(path !== undefined);
    assert.ok(existsSync(sessionFileLockPath(path)), "建文件时取锁");
    assert.deepEqual(entryKinds(path), [
      "hook:SessionStart",
      "hook:UserPromptSubmit",
      "message:user",
      SessionEntryType.RunEnd,
    ]);
    // 建好之后钩子运行记录照常直接写
    writer.append(hookRecord("SessionEnd"));
    await writer.close();
    assert.equal(entryKinds(path).at(-1), "hook:SessionEnd");
    assert.equal(existsSync(sessionFileLockPath(path)), false, "关闭后释放锁");
  } finally {
    cleanup();
  }
});

test("推迟建文件：钩子运行记录以外的自定义条目同样触发建文件", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const writer = openSessionStoreWriter(options(sessions, "sess_D4", { deferCreate: true }));
    writer.append(runEnd());
    const path = await writer.filePath();
    assert.ok(path !== undefined);
    assert.deepEqual(entryKinds(path), [SessionEntryType.RunEnd]);
    await writer.close();
  } finally {
    cleanup();
  }
});

test("推迟建文件：同进程再开的写者（/reload）共用推迟状态，前一个写者留下的钩子运行记录在建文件时补上", async () => {
  const { sessions, cleanup } = tempRoot();
  try {
    const first = openSessionStoreWriter(options(sessions, "sess_D5", { deferCreate: true }));
    first.append(hookRecord("SessionStart"));
    // 再开的写者不带 deferCreate（/reload 按会话号找不到文件），随已有核心的状态
    const second = openSessionStoreWriter(options(sessions, "sess_D5"));
    assert.equal(second.fileDeferred?.(), true);
    await second.flush();
    assert.deepEqual(filesUnder(sessions), []);
    await first.close();
    assert.deepEqual(filesUnder(sessions), [], "仍有写者开着：暂存的记录保留，不建文件");
    second.appendMessage(userMessage("开始"));
    const path = await second.filePath();
    assert.ok(path !== undefined);
    assert.deepEqual(entryKinds(path), ["hook:SessionStart", "message:user"]);
    await second.close();
    assert.equal(filesUnder(sessions).length, 1, "只有一个会话文件，锁已释放");
  } finally {
    cleanup();
  }
});

test("推迟建文件：建文件失败报给发起那次写入的写者，不抛", async () => {
  const { root, cleanup } = tempRoot();
  try {
    // 会话根所在处是一个普通文件：建子目录必然失败
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "");
    const faults: SessionStoreFault[] = [];
    const writer = openSessionStoreWriter(
      options(join(blocked, "sessions"), "sess_D6", {
        deferCreate: true,
        onFault: (fault) => faults.push(fault),
      })
    );
    writer.append(hookRecord("SessionStart"));
    await writer.flush();
    assert.equal(faults.length, 0, "只有钩子运行记录时不建文件，也就不报错");
    writer.appendMessage(userMessage("你好"));
    await writer.flush();
    assert.equal(faults.length, 1);
    assert.equal(faults[0]?.action, "opening the session file");
    assert.equal(await writer.filePath(), undefined);
    await writer.close();
  } finally {
    cleanup();
  }
});
